/* Thin node-side wrapper around the wasm core, shared by the test scripts. */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const KEY = {
  A: 1, B: 2, SELECT: 4, START: 8,
  RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512
};

export async function open(romPath, { saveBytes = null } = {}) {
  const createGBA = require(join(HERE, 'core-node.js'));
  const M = await createGBA();
  const api = {
    init: M.cwrap('vj_init', 'number', []),
    loadRom: M.cwrap('vj_load_rom', 'number', ['number', 'number']),
    runFrame: M.cwrap('vj_run_frame', null, []),
    setKeys: M.cwrap('vj_set_keys', null, ['number']),
    framebuffer: M.cwrap('vj_framebuffer', 'number', []),
    width: M.cwrap('vj_width', 'number', []),
    height: M.cwrap('vj_height', 'number', []),
    opaque: M.cwrap('vj_opaque', null, []),
    read8: M.cwrap('vj_read8', 'number', ['number']),
    read16: M.cwrap('vj_read16', 'number', ['number']),
    read32: M.cwrap('vj_read32', 'number', ['number']),
    meanLuma: M.cwrap('vj_mean_luma', 'number', []),
    frameHash: M.cwrap('vj_frame_hash', 'number', []),
    title: M.cwrap('vj_game_title', 'string', []),
    gameCode: M.cwrap('vj_game_code', 'string', []),
    revision: M.cwrap('vj_rom_revision', 'number', []),
    saveType: M.cwrap('vj_save_type', 'string', []),
    saveBuffer: M.cwrap('vj_save_buffer', 'number', []),
    saveSize: M.cwrap('vj_save_size', 'number', []),
    saveHash: M.cwrap('vj_save_hash', 'number', []),
    saveRestore: M.cwrap('vj_save_restore', 'number', ['number', 'number']),
    stateSize: M.cwrap('vj_state_size', 'number', []),
    stateSave: M.cwrap('vj_state_save', 'number', []),
    stateLoad: M.cwrap('vj_state_load', 'number', ['number', 'number'])
  };
  if (!api.init()) { throw new Error('vj_init failed'); }

  if (saveBytes) {
    const sp = M._malloc(saveBytes.length);
    M.HEAPU8.set(saveBytes, sp);
    api.saveRestore(sp, saveBytes.length);
    M._free(sp);
  }

  const rom = readFileSync(romPath);
  const p = M._malloc(rom.length);
  M.HEAPU8.set(rom, p);
  const ok = api.loadRom(p, rom.length);
  M._free(p);
  if (!ok) { throw new Error(`mGBA rejected ${romPath}`); }

  const W = api.width(), H = api.height();

  return {
    M, api, W, H, romLen: rom.length,
    frames: 0,
    /* Advance n frames with `bits` held for all of them. */
    run(n, bits = 0) {
      for (let i = 0; i < n; i++) { api.setKeys(bits); api.runFrame(); this.frames++; }
      return this.frames;
    },
    /* Press and release with real emulated time in between, so neither edge
     * can be swallowed by landing in the same frame. */
    tap(bits, { hold = 6, gap = 10 } = {}) {
      this.run(hold, bits);
      this.run(gap, 0);
    },
    framebufferRGBA() {
      api.opaque();
      const ptr = api.framebuffer();
      return Buffer.from(M.HEAPU8.subarray(ptr, ptr + W * H * 4));
    },
    saveBytes() {
      const ptr = api.saveBuffer(), len = api.saveSize();
      return Buffer.from(M.HEAPU8.subarray(ptr, ptr + len));
    }
  };
}

/* Write the framebuffer as a binary PPM so frames can actually be looked at.
 * mGBA's mColor here is BGRA in memory order. */
export function toPPM(rgba, W, H) {
  const head = Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii');
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    px[i * 3 + 0] = rgba[i * 4 + 0];
    px[i * 3 + 1] = rgba[i * 4 + 1];
    px[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return Buffer.concat([head, px]);
}
