/* Resolve game-state addresses from the linker map of the build we just made.
 *
 * This exists so the gameplay tests gate on the game's own state rather than
 * on what a picture looks like. Wario Land 4 runs an attract demo on the title
 * screen that is screenshot-identical to play: Wario runs, the HUD is up, the
 * timer counts down. The fleet has been burnt by exactly this on Sonic 2.
 *
 * Every address here comes out of build/us/warioland4_us.map -- the map emitted
 * by the build under test -- and every struct offset comes out of the repo's own
 * include/wario.h. Nothing is hardcoded from a wiki or a memory map found
 * online, and if a symbol is missing the tests fail loudly instead of reading a
 * plausible-looking zero from the wrong address.
 */

import { readFileSync } from 'node:fs';

/* Matches both shapes the map uses:
 *     0x03000c3a                gMainGameMode
 *     0x03001898                        gWarioData = .
 */
const LINE = /^\s*0x([0-9a-fA-F]{8,16})\s+([A-Za-z_]\w*)(?:\s*=\s*\.)?\s*$/;

export function loadMap(path) {
  const syms = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = LINE.exec(line);
    if (!m) { continue; }
    const addr = Number.parseInt(m[1], 16) >>> 0;
    const name = m[2];
    /* First definition wins: the map lists a symbol once where it is defined
     * and again in cross-reference sections. */
    if (!syms.has(name)) { syms.set(name, addr); }
  }
  if (syms.size === 0) {
    throw new Error(`no symbols parsed out of ${path} -- refusing to run a test ` +
                    'that would then read arbitrary addresses');
  }
  return syms;
}

/* struct WarioData, include/wario.h:254. The offsets are in the header's own
 * comments; they are restated here and checked for consistency by the caller. */
export const WARIO = {
  reaction: 0x00,
  pose: 0x01,
  horizontalDirection: 0x0E,
  verticalDirection: 0x10,
  xPosition: 0x12,
  yPosition: 0x14,
  xVelocity: 0x16,
  yVelocity: 0x18
};

/* enum GameMode, include/main.h:19. GM_DEMO is the attract demo; it is the
 * value a "looks like gameplay" screenshot cannot be distinguished from. */
export const GM = {
  CUTSCENE: 0,
  STAGE_SELECT: 1,
  GAME_SCREEN: 2,
  SOFT_RESET: 3,
  PAUSE: 4,
  QUIT: 5,
  MINIGAMES: 6,
  ITEM_SHOP: 7,
  DEMO: 8,
  FILE_SELECT: 9,
  SAVE_RESET: 10,
  GM_11: 11,
  CREDITS: 12
};

export const GM_NAME = Object.fromEntries(Object.entries(GM).map(([k, v]) => [v, k]));

/* The symbols every state assertion depends on. Resolved up front so a rename
 * upstream is an immediate, obvious failure. */
export function gameState(syms) {
  const need = ['gMainGameMode', 'gWarioData', 'gCurrentPassage',
                'gCurrentStageNumber', 'gCurrentStageID'];
  const missing = need.filter((n) => !syms.has(n));
  if (missing.length) {
    throw new Error('linker map is missing ' + missing.join(', ') +
                    ' -- the build and these tests are out of sync');
  }
  return {
    mainGameMode: syms.get('gMainGameMode'),
    warioData: syms.get('gWarioData'),
    currentPassage: syms.get('gCurrentPassage'),
    currentStageNumber: syms.get('gCurrentStageNumber'),
    currentStageID: syms.get('gCurrentStageID')
  };
}

/* Verify the struct-offset table above still agrees with the header, so these
 * constants cannot silently drift away from the source they were read from. */
export function checkWarioOffsets(headerPath) {
  const text = readFileSync(headerPath, 'utf8');
  const body = /struct WarioData \{([\s\S]*?)\n\};/.exec(text);
  if (!body) { throw new Error(`could not find struct WarioData in ${headerPath}`); }
  const found = {};
  for (const m of body[1].matchAll(/\/\*\s*0x([0-9A-Fa-f]+)\s*\*\/\s*[\w*]+\s+(\w+)\s*;/g)) {
    found[m[2]] = Number.parseInt(m[1], 16);
  }
  const bad = [];
  for (const [k, v] of Object.entries(WARIO)) {
    if (found[k] !== v) { bad.push(`${k}: test says 0x${v.toString(16)}, header says ${found[k]}`); }
  }
  if (bad.length) { throw new Error('WarioData offsets drifted:\n  ' + bad.join('\n  ')); }
  return Object.keys(found).length;
}
