/* Muted core-level test for the Wario Land 4 browser target.
 *
 *   node test/core-smoke.mjs <rom> <linker.map> [dumpdir]
 *
 * Runs outside a browser, so it isolates "the core is wrong" from "the page is
 * wrong". No audio is ever drained and no AudioContext exists here at all.
 *
 * The point of this file is the gameplay gate. Wario Land 4 runs an attract
 * demo that is screenshot-identical to play -- bright, animated, Wario running,
 * HUD up -- and this test proves that by reaching it with zero input. So
 * "played" is gated on gMainGameMode == GM_GAME_SCREEN (and explicitly not
 * GM_DEMO) plus gWarioData.xPosition moving under our input, with every address
 * resolved from the linker map of the build under test.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { open, KEY, toPPM } from './gba.mjs';
import { loadMap, gameState, checkWarioOffsets, GM, GM_NAME, WARIO } from './symbols.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [romPath, mapPath, dumpDir] = process.argv.slice(2);
if (!romPath || !mapPath) {
  console.error('usage: core-smoke.mjs <rom> <linker.map> [dumpdir]');
  process.exit(2);
}
if (dumpDir) { mkdirSync(dumpDir, { recursive: true }); }

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
  return ok;
}

/* ------------------------------------------------------------- symbols */

const syms = loadMap(mapPath);
const S = gameState(syms);
const nOff = checkWarioOffsets(join(HERE, '../../upstream/TsilaAllaoui/include/wario.h'));
console.log(`symbols: ${syms.size} from ${mapPath}`);
console.log(`  gMainGameMode 0x${S.mainGameMode.toString(16)}  gWarioData 0x${S.warioData.toString(16)}` +
            `  gCurrentPassage 0x${S.currentPassage.toString(16)}` +
            `  gCurrentStageNumber 0x${S.currentStageNumber.toString(16)}`);
check('WarioData offsets agree with include/wario.h', nOff > 0, `${nOff} fields`);

/* ---------------------------------------------------------------- boot */

const g = await open(romPath);
const mode = () => g.api.read16(S.mainGameMode);
const wx = () => g.api.read16(S.warioData + WARIO.xPosition);
const wy = () => g.api.read16(S.warioData + WARIO.yPosition);

function shot(name) {
  if (!dumpDir) { return; }
  writeFileSync(`${dumpDir}/${name}.ppm`, toPPM(g.framebufferRGBA(), g.W, g.H));
}

console.log('\nROM identity');
check('header title is WARIOLAND', /^WARIOLAND/.test(g.api.title()), JSON.stringify(g.api.title()));
check('game code is AWAE (USA, Europe)', g.api.gameCode() === 'AWAE', g.api.gameCode());
check('revision byte is 0', g.api.revision() === 0, String(g.api.revision()));
check('save media is SRAM', /^SRAM/.test(g.api.saveType()), g.api.saveType());
check('save buffer is 32 KiB (matches SRAM_V)', g.api.saveSize() === 32768, String(g.api.saveSize()));

console.log('\nboot');
g.run(600, 0);
shot('01-intro');
check('600 frames advanced', g.frames === 600, `${g.frames}`);
check('picture is not black after the intro starts', g.api.meanLuma() > 2,
      `luma ${g.api.meanLuma().toFixed(1)}`);

/* ------------------------------------- the attract demo is NOT gameplay */
/* Done first, and from a clean core, because it is the control: if this does
 * not reach GM_DEMO then the gate below proves nothing in particular. */

console.log('\nattract demo (control: zero input, must still look like gameplay)');
{
  const d = await open(romPath);
  const dmode = () => d.api.read16(S.mainGameMode);
  const dwx = () => d.api.read16(S.warioData + WARIO.xPosition);
  let reached = false;
  for (let i = 0; i < 400 && !reached; i++) {
    d.run(60, 0);
    if (dmode() === GM.DEMO) { reached = true; }
  }
  check('idling with NO input reaches GM_DEMO', reached,
        `frame ${d.frames} (${(d.frames / 59.7275).toFixed(1)}s)`);
  if (reached) {
    const x0 = dwx(), l0 = d.api.meanLuma();
    d.run(180, 0);
    const moved = Math.abs(dwx() - x0);
    if (dumpDir) { writeFileSync(`${dumpDir}/00-attract-demo.ppm`, toPPM(d.framebufferRGBA(), d.W, d.H)); }
    check('the demo moves Wario with no input at all', moved > 100,
          `x ${x0} -> ${dwx()} (${moved})`);
    check('the demo is bright, i.e. visually indistinguishable from play',
          d.api.meanLuma() > 60, `luma ${l0.toFixed(1)} -> ${d.api.meanLuma().toFixed(1)}`);
    check('...but gMainGameMode says GM_DEMO, not GM_GAME_SCREEN',
          dmode() === GM.DEMO && GM.DEMO !== GM.GAME_SCREEN, `mode ${dmode()} (${GM_NAME[dmode()]})`);
  }
}

/* ------------------------------------------------- menus into the level */

console.log('\nmenus');
let taps = 0;
while (mode() !== GM.FILE_SELECT && taps < 400) { g.tap(KEY.START, { hold: 5, gap: 20 }); taps++; }
shot('02-file-select');
check('reached GM_FILE_SELECT', mode() === GM.FILE_SELECT, `frame ${g.frames}`);

taps = 0;
while (mode() !== GM.STAGE_SELECT && taps < 400) { g.tap(KEY.A, { hold: 5, gap: 20 }); taps++; }
shot('03-stage-select');
check('reached GM_STAGE_SELECT', mode() === GM.STAGE_SELECT, `frame ${g.frames}`);

taps = 0;
while (mode() !== GM.GAME_SCREEN && taps < 400) { g.tap(KEY.A, { hold: 5, gap: 20 }); taps++; }
g.run(120, 0);
shot('04-level-start');
check('reached GM_GAME_SCREEN', mode() === GM.GAME_SCREEN, `frame ${g.frames}`);
check('NOT the attract demo', mode() !== GM.DEMO, `mode ${mode()} (${GM_NAME[mode()]})`);

const passage = g.api.read8(S.currentPassage);
const stageNum = g.api.read8(S.currentStageNumber);
check('in the first level: passage 0, stage 0 (Entry Passage, Hall of Hieroglyphs)',
      passage === 0 && stageNum === 0, `passage ${passage} stage ${stageNum}`);

/* ------------------------------------------------------- real movement */

console.log('\nmovement under our own input');
const x0 = wx(), y0 = wy();
check('Wario has a plausible in-level position', x0 > 0 && y0 > 0, `x=${x0} y=${y0}`);

g.run(150, KEY.RIGHT);
shot('05-after-running-right');
const x1 = wx();
check('holding RIGHT moves Wario right', x1 > x0, `x ${x0} -> ${x1} (+${x1 - x0})`);
check('still GM_GAME_SCREEN while moving', mode() === GM.GAME_SCREEN, `mode ${mode()}`);

const yBefore = wy();
g.run(14, KEY.A | KEY.RIGHT);
const yPeak = wy();
g.run(60, KEY.RIGHT);
shot('06-after-jump');
/* yPosition grows downward, so a jump makes it smaller. */
check('pressing A makes Wario leave the ground', yPeak < yBefore,
      `y ${yBefore} -> ${yPeak} (up ${yBefore - yPeak})`);

const xIdle = wx();
g.run(90, 0);
check('Wario stops when input is released', Math.abs(wx() - xIdle) < 40,
      `x ${xIdle} -> ${wx()}`);

console.log('\nrendering');
check('level picture is not black', g.api.meanLuma() > 20, `luma ${g.api.meanLuma().toFixed(1)}`);
const h1 = g.api.frameHash();
g.run(30, KEY.RIGHT);
check('the picture keeps changing (not a wedged core holding one frame)',
      g.api.frameHash() !== h1);

/* -------------------------------------------------------- save plumbing */

console.log('\ncartridge SRAM');
const sramBefore = g.saveBytes();
check('save buffer readable, 32 KiB', sramBefore.length === 32768);
/* The game writes SRAM on its own during boot/stage entry, so this should have
 * moved from the all-zero buffer we handed mGBA. */
check('the game has written to SRAM by now', sramBefore.some((b) => b !== 0),
      `${sramBefore.filter((b) => b !== 0).length} non-zero bytes`);

const h = g.api.saveHash();
const g2 = await open(romPath, { saveBytes: sramBefore });
check('a core restored with that SRAM reports the same save hash',
      g2.api.saveHash() === h, `0x${h.toString(16)}`);

/* ------------------------------------------------------- savestate trip */

/* A savestate carries emulator state, not the contents of our framebuffer --
 * vbuf is ours, outside the core, and nothing repaints it until a frame runs.
 * So the comparison has to be "one frame after the snapshot" against "one frame
 * after restoring it", not the raw hash at restore time. Comparing the latter
 * just measures the stale buffer and fails for the wrong reason. */
console.log('\nsavestate round trip');
const stPtr = g.api.stateSave(), stLen = g.api.stateSize();
const st = Buffer.from(g.M.HEAPU8.subarray(stPtr, stPtr + stLen));
g.run(1, 0);
const hashAfterOneFrame = g.api.frameHash();

g.run(240, KEY.RIGHT | KEY.A);
check('the picture actually diverged during the window (else the test is vacuous)',
      g.api.frameHash() !== hashAfterOneFrame);

const sp = g.M._malloc(st.length);
g.M.HEAPU8.set(st, sp);
const okLoad = g.api.stateLoad(sp, st.length);
g.M._free(sp);
check('state reloads', !!okLoad);
g.run(1, 0);
check('replaying one frame from the restored state reproduces the exact frame',
      g.api.frameHash() === hashAfterOneFrame,
      `0x${hashAfterOneFrame.toString(16)} vs 0x${g.api.frameHash().toString(16)}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (dumpDir) { console.log(`frames written to ${dumpDir}`); }
process.exit(fail ? 1 : 0);
