/* Wario Land 4 browser target — mGBA mCore shim.
 *
 * Exposes a small C surface to JS. No SDL, no filesystem, no audio device: the
 * page owns the canvas and (only if the user explicitly unmutes) the
 * AudioContext. The ROM arrives as bytes from a real <input type=file> and is
 * never written anywhere but linear memory.
 *
 * Derived from ~/decompfleet/games/pokeruby/web/src/shim.c (same fleet). Two
 * substantive changes for this title:
 *   - SAVE_BYTES is 32 KiB, not 128 KiB: WL4's header string is SRAM_V112,
 *     i.e. battery-backed SRAM, not FLASH1M. mGBA picks its save media from the
 *     buffer size it is handed, so this has to be exact rather than generous.
 *   - vj_read8/16/32 expose the emulated bus, so the test harness can gate
 *     "played" on the game's own IWRAM state (gMainGameMode, gWarioData) at
 *     addresses read out of the build's own linker map. A screenshot cannot
 *     tell gameplay from WL4's attract demo; gMainGameMode can.
 */

#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba/gba/core.h>
#include <mgba-util/vfs.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/image.h>

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define VID_W 240
#define VID_H 160

/* Wario Land 4 declares "SRAM_V112" in its header: 32 KiB of battery-backed
 * SRAM. Oversizing this makes mGBA attach the wrong save media, so it is exact. */
#define SAVE_BYTES (32 * 1024)

static struct mCore* core = NULL;
static mColor* vbuf = NULL;

/* The core keeps referencing the ROM VFile for the whole session, so this copy
 * has to outlive vj_load_rom(). Same for the save buffer. */
static uint8_t* rom = NULL;
static size_t romLen = 0;
static struct VFile* romVf = NULL;

static uint8_t* save = NULL;
static struct VFile* saveVf = NULL;

static int16_t* abuf = NULL; /* interleaved stereo, drained by JS */
static size_t abufFrames = 0;
static unsigned sampleRate = 0;

static uint8_t* state = NULL;
static size_t stateLen = 0;

static int loaded = 0;

/* ---------------------------------------------------------------- lifecycle */

/* mGBA's default logger prints every BIOS SWI and DMA to stdout, which in a
 * browser is thousands of console lines a second and a visible framerate cost.
 * Swallow everything; the vj_* return values are the diagnostic surface. */
static void _quietLog(struct mLogger* logger, int category, enum mLogLevel level,
                      const char* format, va_list args) {
	UNUSED(logger);
	UNUSED(category);
	UNUSED(level);
	UNUSED(format);
	UNUSED(args);
}

static struct mLogger quietLogger = { .log = _quietLog, .filter = NULL };

EMSCRIPTEN_KEEPALIVE
int vj_init(void) {
	if (core) {
		return 1;
	}
	mLogSetDefaultLogger(&quietLogger);
	core = GBACoreCreate();
	if (!core) {
		return 0;
	}
	if (!core->init(core)) {
		core->deinit(core);
		core = NULL;
		return 0;
	}
	/* core->config holds hash tables that mCore reads during reset()
	 * (_GBACoreReset -> mCoreConfigGetBoolValue). GBACoreCreate does not
	 * initialise them, so without this reset() walks a garbage table and traps
	 * on an out-of-bounds read. Nothing is read from or written to disk --
	 * mCoreConfigLoad is deliberately not called. */
	mCoreConfigInit(&core->config, "warioland4-web");
	core->loadConfig(core, &core->config);

	vbuf = calloc(VID_W * VID_H, sizeof(mColor));
	core->setVideoBuffer(core, vbuf, VID_W);
	core->setAudioBufferSize(core, 1024);
	sampleRate = core->audioSampleRate(core);
	abufFrames = 4096;
	abuf = calloc(abufFrames * 2, sizeof(int16_t));
	return 1;
}

/* Copies, so JS may free its own view immediately. */
EMSCRIPTEN_KEEPALIVE
int vj_load_rom(const uint8_t* data, int size) {
	if (!core || size <= 0) {
		return 0;
	}
	if (loaded) {
		core->unloadROM(core);
		loaded = 0;
	}
	free(rom);
	rom = malloc((size_t) size);
	if (!rom) {
		return 0;
	}
	memcpy(rom, data, (size_t) size);
	romLen = (size_t) size;

	romVf = VFileFromMemory(rom, romLen);
	if (!romVf || !core->loadROM(core, romVf)) {
		return 0;
	}

	if (!save) {
		save = calloc(SAVE_BYTES, 1);
	}
	saveVf = VFileFromMemory(save, SAVE_BYTES);
	core->loadSave(core, saveVf);

	core->reset(core);
	loaded = 1;
	return 1;
}

EMSCRIPTEN_KEEPALIVE
int vj_loaded(void) {
	return loaded;
}

EMSCRIPTEN_KEEPALIVE
void vj_reset(void) {
	if (core && loaded) {
		core->reset(core);
	}
}

/* ------------------------------------------------------------------- frames */

EMSCRIPTEN_KEEPALIVE
void vj_run_frame(void) {
	if (core && loaded) {
		core->runFrame(core);
	}
}

EMSCRIPTEN_KEEPALIVE
mColor* vj_framebuffer(void) {
	return vbuf;
}

EMSCRIPTEN_KEEPALIVE
int vj_width(void) { return VID_W; }

EMSCRIPTEN_KEEPALIVE
int vj_height(void) { return VID_H; }

EMSCRIPTEN_KEEPALIVE
int vj_frame_counter(void) {
	return (core && loaded) ? (int) core->frameCounter(core) : -1;
}

/* mGBA leaves alpha at 0 in some paths; ImageData needs it opaque. Done here
 * rather than in JS so the page can hand the buffer straight to putImageData. */
EMSCRIPTEN_KEEPALIVE
void vj_opaque(void) {
	uint32_t* p = (uint32_t*) vbuf;
	for (int i = 0; i < VID_W * VID_H; ++i) {
		p[i] |= 0xFF000000u;
	}
}

/* -------------------------------------------------------------------- input */

EMSCRIPTEN_KEEPALIVE
void vj_set_keys(int keys) {
	if (core && loaded) {
		core->setKeys(core, (uint32_t) keys);
	}
}

/* -------------------------------------------------------------- memory peek */

/* Reads through the emulated bus, so IWRAM (0x03000000) and EWRAM (0x02000000)
 * are both reachable. This is what makes the gameplay test honest: the harness
 * resolves gMainGameMode / gWarioData out of build/us/warioland4_us.map and
 * reads them here, instead of inferring "it looks like play" from a picture.
 * Read-only: there is deliberately no write counterpart, so a test cannot
 * manufacture the state it is supposed to be observing. */
EMSCRIPTEN_KEEPALIVE
int vj_read8(unsigned addr) {
	if (!core || !loaded) {
		return -1;
	}
	return (int) core->busRead8(core, addr);
}

EMSCRIPTEN_KEEPALIVE
int vj_read16(unsigned addr) {
	if (!core || !loaded) {
		return -1;
	}
	return (int) core->busRead16(core, addr);
}

EMSCRIPTEN_KEEPALIVE
unsigned vj_read32(unsigned addr) {
	if (!core || !loaded) {
		return 0;
	}
	return (unsigned) core->busRead32(core, addr);
}

/* -------------------------------------------------------------------- audio */

EMSCRIPTEN_KEEPALIVE
int vj_sample_rate(void) { return (int) sampleRate; }

EMSCRIPTEN_KEEPALIVE
int16_t* vj_audio_buffer(void) { return abuf; }

/* Returns frames (sample pairs) written into vj_audio_buffer(). JS only calls
 * this once the user has unmuted; otherwise the buffer is simply never drained
 * and mGBA's ring overwrites itself, which costs nothing. */
EMSCRIPTEN_KEEPALIVE
int vj_drain_audio(int maxFrames) {
	if (!core || !loaded) {
		return 0;
	}
	if (maxFrames > (int) abufFrames) {
		maxFrames = (int) abufFrames;
	}
	struct mAudioBuffer* ab = core->getAudioBuffer(core);
	if (!ab) {
		return 0;
	}
	size_t got = mAudioBufferRead(ab, abuf, (size_t) maxFrames);
	return (int) got;
}

/* --------------------------------------------------------- cartridge SRAM */

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_save_buffer(void) { return save; }

EMSCRIPTEN_KEEPALIVE
int vj_save_size(void) { return SAVE_BYTES; }

/* Cheap change detector so the page can persist only when the cartridge save
 * actually moved, instead of writing 32 KiB to IndexedDB on a timer. */
EMSCRIPTEN_KEEPALIVE
unsigned vj_save_hash(void) {
	if (!save) {
		return 0;
	}
	unsigned h = 2166136261u;
	for (int i = 0; i < SAVE_BYTES; ++i) {
		h = (h ^ save[i]) * 16777619u;
	}
	return h;
}

/* Must be called before vj_load_rom(): mGBA reads the buffer when it attaches
 * the save media, so restoring afterwards is silently ignored. */
EMSCRIPTEN_KEEPALIVE
int vj_save_restore(const uint8_t* data, int size) {
	if (!save) {
		save = calloc(SAVE_BYTES, 1);
	}
	if (!data || size <= 0) {
		return 0;
	}
	if (size > SAVE_BYTES) {
		size = SAVE_BYTES;
	}
	memcpy(save, data, (size_t) size);
	return size;
}

/* ------------------------------------------------------------- savestates */

EMSCRIPTEN_KEEPALIVE
int vj_state_size(void) {
	return (core && loaded) ? (int) core->stateSize(core) : 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_state_save(void) {
	if (!core || !loaded) {
		return NULL;
	}
	size_t n = core->stateSize(core);
	if (n != stateLen) {
		free(state);
		state = malloc(n);
		stateLen = n;
	}
	if (!core->saveState(core, state)) {
		return NULL;
	}
	return state;
}

EMSCRIPTEN_KEEPALIVE
int vj_state_load(const uint8_t* data, int size) {
	if (!core || !loaded || !data) {
		return 0;
	}
	if ((size_t) size != core->stateSize(core)) {
		return 0;
	}
	return core->loadState(core, data) ? 1 : 0;
}

/* ------------------------------------------------------------------ probes */

/* Mean luma over the frame. Distinguishes "the core is running" from "the core
 * is running and something is actually on screen" -- a black frame ticks along
 * perfectly happily. Computed over the core's own framebuffer rather than the
 * canvas, so it is not subject to the WebGL preserveDrawingBuffer false-black
 * that bit the EmulatorJS pages on this box. */
EMSCRIPTEN_KEEPALIVE
double vj_mean_luma(void) {
	if (!vbuf) {
		return -1.0;
	}
	const uint8_t* p = (const uint8_t*) vbuf;
	double acc = 0.0;
	for (int i = 0; i < VID_W * VID_H; ++i) {
		acc += 0.2126 * p[i * 4 + 0] + 0.7152 * p[i * 4 + 1] + 0.0722 * p[i * 4 + 2];
	}
	return acc / (VID_W * VID_H);
}

/* FNV-1a of the visible frame, for comparing two frames exactly (savestate
 * round trips, and "is the picture still changing"). */
EMSCRIPTEN_KEEPALIVE
unsigned vj_frame_hash(void) {
	if (!vbuf) {
		return 0;
	}
	const uint8_t* p = (const uint8_t*) vbuf;
	unsigned h = 2166136261u;
	for (int i = 0; i < VID_W * VID_H * 4; ++i) {
		h = (h ^ p[i]) * 16777619u;
	}
	return h;
}

/* Title from the cartridge header, so the page can say which ROM it got (and
 * refuse one that is not Wario Land 4) without JS parsing the header.
 *
 * The title field is 12 bytes NUL-padded, and WL4's is "WARIOLANDE" -- 10
 * characters. Returning title+code as one 16-byte blob (which is what the
 * pokeruby shim this was derived from does) therefore truncates at the padding
 * and the code is unreachable from JS, because cwrap('string') stops at the
 * first NUL. Hence two separate accessors rather than one concatenated field. */
EMSCRIPTEN_KEEPALIVE
const char* vj_game_title(void) {
	static char title[13];
	memset(title, 0, sizeof(title));
	if (rom && romLen >= 0xAC) {
		memcpy(title, rom + 0xA0, 12);
	}
	return title;
}

/* The 4-character game code at 0xAC: AWAE for (USA, Europe), AWAJ for JP. */
EMSCRIPTEN_KEEPALIVE
const char* vj_game_code(void) {
	static char code[5];
	memset(code, 0, sizeof(code));
	if (rom && romLen >= 0xB0) {
		memcpy(code, rom + 0xAC, 4);
	}
	return code;
}

EMSCRIPTEN_KEEPALIVE
int vj_rom_revision(void) {
	/* Header byte 0xBC is the version/revision number. WL4 (USA, Europe) is 0. */
	return (rom && romLen > 0xBC) ? rom[0xBC] : -1;
}

/* The save-type string mGBA itself keys off. Exposed so the page can show it
 * and the harness can assert this really is an SRAM title, which is the whole
 * reason SAVE_BYTES is 32 KiB. */
EMSCRIPTEN_KEEPALIVE
const char* vj_save_type(void) {
	static char buf[16];
	static const char* const kinds[] = { "SRAM_V", "SRAM_F_V", "EEPROM_V",
		                             "FLASH_V", "FLASH512_V", "FLASH1M_V" };
	memset(buf, 0, sizeof(buf));
	if (!rom) {
		return buf;
	}
	for (unsigned k = 0; k < sizeof(kinds) / sizeof(kinds[0]); ++k) {
		size_t n = strlen(kinds[k]);
		for (size_t i = 0; i + n <= romLen; i += 4) {
			if (!memcmp(rom + i, kinds[k], n)) {
				size_t j = 0;
				while (j < sizeof(buf) - 1 && i + j < romLen && rom[i + j] > 0x20) {
					buf[j] = (char) rom[i + j];
					++j;
				}
				return buf;
			}
		}
	}
	return buf;
}
