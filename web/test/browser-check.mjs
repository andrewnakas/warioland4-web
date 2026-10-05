/* Drives the real page in headless Chrome over the DevTools protocol.
 *
 *   CDP_URL=ws://... node browser-check.mjs <url> <rom> <linker.map> [outdir]
 *
 * Deliberately exercises the shipping path rather than a test-only shortcut:
 * the ROM is handed to the actual <input type=file> with DOM.setFileInputFiles,
 * so the picker, the File API path, the IndexedDB cache and the boot sequence
 * under test are the ones a user gets.
 *
 * Three things this harness refuses to take the page's word for:
 *
 *  - "nothing was uploaded" is asserted at the CDP network layer, and the CSP
 *    is additionally probed by making the page attempt a cross-origin fetch and
 *    requiring the browser to block it. A page's own log saying it sent nothing
 *    is not evidence.
 *  - "something is on screen" is measured from the screenshot the browser hands
 *    back, decoded outside the page and cropped to the canvas rect.
 *  - "it played" is read out of the game's own IWRAM, at addresses resolved
 *    from the linker map of the build under test. Wario Land 4's attract demo
 *    is screenshot-identical to play.
 *
 * Audio is asserted off: the page builds no AudioContext unless the mute button
 * is clicked, and this harness never clicks it.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap, gameState, GM, GM_NAME, WARIO } from './symbols.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANVAS_LUMA = join(HERE, '../../tools/canvas_luma.py');

const [url, romPath, mapPath, outDir] = process.argv.slice(2);
if (!url || !romPath || !mapPath) {
	console.error('usage: node browser-check.mjs <url> <rom> <linker.map> [outdir]');
	process.exit(2);
}
if (outDir) { mkdirSync(outDir, { recursive: true }); }

const S = gameState(loadMap(mapPath));

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
	return !!ok;
}

/* --------------------------------------------------------------- CDP client */

const endpoint = process.env.CDP_URL;
if (!endpoint) {
	console.error('CDP_URL not set');
	process.exit(2);
}

const ws = new WebSocket(endpoint);
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const requests = [];

ws.addEventListener('message', (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) { reject(new Error(msg.error.message)); } else { resolve(msg.result); }
		return;
	}
	if (msg.method === 'Network.requestWillBeSent') {
		requests.push(msg.params.request.url);
	}
	if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
		consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
	}
	if (msg.method === 'Runtime.exceptionThrown') {
		pageErrors.push(msg.params.exceptionDetails.text + ' ' +
			(msg.params.exceptionDetails.exception?.description || ''));
	}
});

function send(method, params = {}) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}

await new Promise((res, rej) => {
	ws.addEventListener('open', res, { once: true });
	ws.addEventListener('error', rej, { once: true });
});

/* Evaluate and unwrap, surfacing page-side exceptions as real failures rather
 * than as undefined. */
async function evaluate(expr, { awaitPromise = false } = {}) {
	const r = await send('Runtime.evaluate', {
		expression: expr, returnByValue: true, awaitPromise
	});
	if (r.exceptionDetails) {
		throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ||
			r.exceptionDetails.text));
	}
	return r.result.value;
}

/* Let the page actually run for `ms` of wall clock while CDP events drain.
 * Never sleep without pumping: a press and its release can otherwise land in
 * the same task batch and the core sees neither edge. */
function pump(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

async function waitFor(expr, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		let v = false;
		try { v = await evaluate(expr); } catch { /* document may be swapping */ }
		if (v) { return true; }
		if (Date.now() - t0 > timeoutMs) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${label || expr}`);
		}
		await pump(100);
	}
}

/* --------------------------------------------------------------- navigation */

/* Trap: after Page.navigate, Runtime.evaluate still runs against the OLD
 * document for a short window, so "poll until window.__vj exists" returns true
 * immediately against the page we were trying to leave. Carry a nonce in the
 * URL and require the live document to echo it back. The nonce doubles as proof
 * that the tab we are attached to is ours and not another agent's browser on a
 * shared debug port. */
let nonce = '';
async function goto(base) {
	nonce = 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36);
	const target = base + (base.includes('?') ? '&' : '?') + '_n=' + nonce;
	await send('Page.navigate', { url: target });
	await waitFor(
		`location.search.indexOf(${JSON.stringify(nonce)}) !== -1 && document.readyState !== 'loading'`,
		20000, 'the new document (nonce echo)');
	return nonce;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('DOM.enable');

console.log('=== stage 1: boot, network, gameplay ===\n');

await goto(url);
check('attached tab echoes our URL nonce (not another agent\'s browser)',
	await evaluate(`location.search.indexOf(${JSON.stringify(nonce)}) !== -1`), nonce);

/* Start from a clean slate so "the save persisted" cannot be satisfied by a
 * leftover from an earlier run. */
await evaluate(`new Promise(function (res) {
  var r = indexedDB.deleteDatabase('warioland4-web');
  r.onsuccess = r.onerror = r.onblocked = function () { res(1); };
})`, { awaitPromise: true });
await goto(url);

await waitFor('!!(window.__vj && window.__vj.ready)', 30000, 'core init');
check('wasm core initialises', await evaluate('window.__vj.ready'));

/* ------------------------------------------------------------ the CSP probe */

/* The CSP is the actual boundary, so test that the browser enforces it rather
 * than trusting the meta tag to be well formed. connect-src 'self' is what
 * makes uploading the user's ROM impossible regardless of what any script on
 * the page does.
 *
 * A bare "the fetch rejected" is NOT evidence: on a sandboxed box with no
 * outbound network a fetch rejects anyway, and the probe would pass against a
 * page with no CSP at all. So require the browser to report a
 * securitypolicyviolation naming connect-src, and separately require a
 * same-origin fetch to still succeed -- which rules out "nothing can reach
 * anything" as the explanation. */
const cspProbe = await evaluate(`(function () {
  var seen = null;
  function onV(e) { seen = {directive: e.violatedDirective, uri: String(e.blockedURI)}; }
  document.addEventListener('securitypolicyviolation', onV);
  return fetch('https://cdn.emulatorjs.org/stable/data/version.json', {mode: 'no-cors'})
    .then(function () { return {outcome: 'ALLOWED'}; })
    .catch(function (e) { return {outcome: 'REJECTED: ' + e.name}; })
    .then(function (r) {
      return new Promise(function (res) { setTimeout(function () {
        document.removeEventListener('securitypolicyviolation', onV);
        r.violation = seen; res(JSON.stringify(r));
      }, 250); });
    });
})()`, { awaitPromise: true }).then(JSON.parse);
check('cross-origin fetch does not succeed', cspProbe.outcome !== 'ALLOWED', cspProbe.outcome);
check('...and the browser reports a CSP connect-src violation (so it is the CSP, not a dead network)',
	!!cspProbe.violation && /connect-src/.test(cspProbe.violation.directive),
	cspProbe.violation ? `${cspProbe.violation.directive} blocked ${cspProbe.violation.uri}` : 'no violation event');

const sameOrigin = await evaluate(`
  fetch('app.css').then(function (r) { return 'OK ' + r.status; })
                  .catch(function (e) { return 'FAILED: ' + e.name; })`, { awaitPromise: true });
check('control: a same-origin fetch still works (the network is not simply dead)',
	/^OK 200/.test(sameOrigin), sameOrigin);

const cspMeta = await evaluate(
	`(document.querySelector('meta[http-equiv="Content-Security-Policy"]')||{}).content || ''`);
check('page declares connect-src \'self\'', /connect-src\s+'self'\s*;/.test(cspMeta));
check('page declares form-action \'none\'', /form-action\s+'none'/.test(cspMeta));
check('page declares default-src \'none\'', /default-src\s+'none'/.test(cspMeta));
check('CSP needs no \'unsafe-inline\' for scripts', !/script-src[^;]*unsafe-inline/.test(cspMeta));

/* ---------------------------------------------- ROM through the real picker */

const beforeRomRequests = requests.length;
const doc = await send('DOM.getDocument');
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#rom-file' });
await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [romPath] });

await waitFor('!!(window.__vj && window.__vj.running)', 30000, 'ROM to boot');
check('ROM accepted through the real <input type=file>', await evaluate('window.__vj.running'));
check('header title is WARIOLAND', /^WARIOLAND/.test(await evaluate('window.__vj.title()')),
	await evaluate('window.__vj.title()'));
check('game code AWAE', (await evaluate('window.__vj.gameCode()')) === 'AWAE',
	await evaluate('window.__vj.gameCode()'));
check('save media reported as SRAM', /^SRAM/.test(await evaluate('window.__vj.saveType()')),
	await evaluate('window.__vj.saveType()'));

/* -------------------------------------------------------- canvas is visible */

/* A core can render perfectly at 60fps into a 0x0 canvas while reporting
 * started:true and a climbing frame counter. Assert the geometry explicitly. */
const rect = await evaluate('JSON.stringify(window.__vj.canvasRect())').then(JSON.parse);
check('canvas has non-zero CSS size', rect.w > 10 && rect.h > 10, `${Math.round(rect.w)}x${Math.round(rect.h)}`);
check('canvas backing store is 240x160', rect.cw === 240 && rect.ch === 160, `${rect.cw}x${rect.ch}`);

/* ----------------------------------------------------------------- gameplay */

const R8 = (a) => evaluate(`window.__vj.read8(${a})`);
const R16 = (a) => evaluate(`window.__vj.read16(${a})`);
const mode = () => R16(S.mainGameMode);
const wx = () => R16(S.warioData + WARIO.xPosition);
const wy = () => R16(S.warioData + WARIO.yPosition);

const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 };

/* Drive frames through __vj.pump rather than at the compositor's mercy. Each
 * call runs real frames synchronously, so press/release edges are separated by
 * actual emulated time. */
async function tap(bits, n = 5, gap = 20) {
	await evaluate(`window.__vj.pump(${n}, ${bits})`);
	await evaluate(`window.__vj.pump(${gap}, 0)`);
}

let taps = 0;
while ((await mode()) !== GM.FILE_SELECT && taps < 400) { await tap(KEY.START); taps++; }
check('reached GM_FILE_SELECT', (await mode()) === GM.FILE_SELECT);

taps = 0;
while ((await mode()) !== GM.GAME_SCREEN && taps < 500) { await tap(KEY.A); taps++; }
await evaluate('window.__vj.pump(120, 0)');
const m = await mode();
check('reached GM_GAME_SCREEN (in a level)', m === GM.GAME_SCREEN, `mode ${m} (${GM_NAME[m]})`);
check('NOT GM_DEMO (the attract demo looks identical in a screenshot)', m !== GM.DEMO);
const passage = await R8(S.currentPassage), stage = await R8(S.currentStageNumber);
check('first level: Entry Passage, stage 0 (Hall of Hieroglyphs)',
	passage === 0 && stage === 0, `passage ${passage} stage ${stage}`);

const x0 = await wx(), y0 = await wy();
await evaluate(`window.__vj.pump(150, ${KEY.RIGHT})`);
const x1 = await wx();
check('holding RIGHT moves Wario right in the level', x1 > x0, `x ${x0} -> ${x1} (+${x1 - x0})`);
await evaluate(`window.__vj.pump(14, ${KEY.A | KEY.RIGHT})`);
const yUp = await wy();
check('pressing A makes Wario leave the ground', yUp < y0, `y ${y0} -> ${yUp}`);
await evaluate(`window.__vj.pump(60, ${KEY.RIGHT})`);
check('still GM_GAME_SCREEN after all that input', (await mode()) === GM.GAME_SCREEN);

/* ---------------------------------------- what the browser actually drew */

/* Ground truth is the screenshot the browser hands back, decoded out here and
 * cropped to the canvas rect, so page chrome is not scored as "picture". The
 * page measuring its own canvas is the known false-black trap on this box. */
async function shoot(name) {
	const r = await send('Page.captureScreenshot', { format: 'png' });
	const buf = Buffer.from(r.data, 'base64');
	const path = join(outDir || '/tmp', `${name}.png`);
	writeFileSync(path, buf);
	const box = await evaluate('JSON.stringify(window.__vj.canvasRect())').then(JSON.parse);
	const vw = await evaluate('window.innerWidth');
	const out = execFileSync('python3', [CANVAS_LUMA, path,
		String(box.x), String(box.y), String(box.w), String(box.h), String(vw)],
		{ encoding: 'utf8' });
	return { path, stat: JSON.parse(out) };
}

const shotPlay = await shoot('browser-01-gameplay');
check('the browser-side screenshot of the canvas is not black', shotPlay.stat.mean > 15,
	`mean luma ${shotPlay.stat.mean}, ${(shotPlay.stat.lit * 100).toFixed(1)}% lit, ` +
	`crop ${shotPlay.stat.box_px.join(',')} @ ${shotPlay.stat.scale}x`);

const h1 = await evaluate('window.__vj.frameHash()');
await evaluate(`window.__vj.pump(40, ${KEY.RIGHT})`);
check('the picture keeps changing (not one bright wedged frame)',
	(await evaluate('window.__vj.frameHash()')) !== h1);

/* --------------------------------------------------------------- audio off */

check('no AudioContext was ever constructed', (await evaluate('window.__vj.audioContextExists()')) === false);
check('page reports audio off', (await evaluate('window.__vj.audioOn()')) === false);

/* ------------------------------------------------------ nothing left the box */

const foreign = requests.filter((u) => !u.startsWith(new URL(url).origin) &&
	!u.startsWith('data:') && !u.startsWith('blob:'));
check('no request to any other origin, at the network layer',
	foreign.length === 0, foreign.length ? foreign.join(', ') : `${requests.length} same-origin requests`);
check('ROM was never fetched over the network',
	!requests.some((u) => /\.gba(\?|$)/.test(u)));

/* ------------------------------------------------------ save across a reload */

console.log('\n=== stage 2: cartridge save across a real reload ===\n');

/* Write a recognisable pattern into the cartridge SRAM and persist it. This is
 * the SRAM layer rather than an in-game SAVE, and is reported as such.
 *
 * The core is frozen first: Wario Land 4 rewrites its SRAM image continuously
 * while it runs, so a marker written into a live core is overwritten within
 * about a second and the test then reports a lost save that was never lost. */
await evaluate('window.__vj.setPaused(true)');
check('core frozen for the save measurement (else the game overwrites the marker)',
	await evaluate('window.__vj.isPaused()'));

/* First, the stronger claim: the save image the GAME itself wrote while we were
 * playing has to round-trip. A synthetic pattern only proves our own write path;
 * these are the bytes Wario Land 4's own SRAM routines produced. */
const gameSram = await evaluate('JSON.stringify(window.__vj.readSaveBytes(32))').then(JSON.parse);
check('the game wrote a non-trivial SRAM image during play',
	gameSram.some((b) => b !== 0), `${gameSram.filter((b) => b !== 0).length}/32 non-zero`);
await evaluate('window.__vj.flushSave()', { awaitPromise: true });
const gameStored = await evaluate('window.__vj.readStoredSaveBytes(32).then(JSON.stringify)',
	{ awaitPromise: true }).then((s) => JSON.parse(s));
check('the game-written SRAM reached IndexedDB byte-for-byte',
	gameStored && JSON.stringify(gameStored.head) === JSON.stringify(gameSram),
	gameStored ? JSON.stringify(gameStored.head.slice(0, 8)) : 'nothing stored');

/* Then the explicit write path, with a marker we chose. */
const seed = 0x40 + (Date.now() & 0x1f);
await evaluate(`window.__vj.pokeSave(${seed})`, { awaitPromise: true });
const wrote = await evaluate('JSON.stringify(window.__vj.readSaveBytes(16))').then(JSON.parse);
check('pattern written into the 32 KiB SRAM buffer', wrote[0] === seed, JSON.stringify(wrote.slice(0, 8)));

const stored = await evaluate('window.__vj.readStoredSaveBytes(16).then(JSON.stringify)',
	{ awaitPromise: true }).then((s) => JSON.parse(s));
check('the save reached IndexedDB, 32 KiB', stored && stored.len === 32768,
	stored ? `${stored.len} bytes` : 'nothing stored');
check('stored bytes are the ones we wrote', stored && stored.head[0] === seed,
	stored ? JSON.stringify(stored.head.slice(0, 8)) : '-');

/* The deterministic mechanism test, before the real reload: dispatch the
 * lifecycle events the browser would fire, from the live page, and confirm the
 * store is still intact afterwards. A navigate-away soak is a weak detector --
 * it passed 8/8 on a provably broken page elsewhere on this fleet -- because
 * the tab usually dies before a destructive teardown's writes land. Dispatching
 * removes the race. */
const flushesBefore = await evaluate('window.__vj.flushes');
await evaluate(`window.dispatchEvent(new Event('pagehide'));
  document.dispatchEvent(new Event('visibilitychange'));
  1`);
await pump(400);
const flushesAfter = await evaluate('window.__vj.flushes');
check('pagehide actually ran our flush (control: the arm is live, not a no-op)',
	flushesAfter > flushesBefore, `${flushesBefore} -> ${flushesAfter}`);

const afterEvents = await evaluate('window.__vj.readStoredSaveBytes(16).then(JSON.stringify)',
	{ awaitPromise: true }).then((s) => JSON.parse(s));
check('save survives the lifecycle events intact (no teardown wipes the store)',
	afterEvents && afterEvents.len === 32768 && afterEvents.head[0] === seed,
	afterEvents ? `${afterEvents.len} bytes, head ${afterEvents.head[0]}` : 'STORE EMPTY');

/* Now the thing a person actually does. Navigate in the same tab rather than
 * closing it: closing over CDP can skip the unload path entirely, which would
 * never exercise what we just tested. */
await goto(url);
await waitFor('!!(window.__vj && window.__vj.ready)', 30000, 'core init after reload');
check('stage 2 document is a fresh load with a new nonce',
	await evaluate(`location.search.indexOf(${JSON.stringify(nonce)}) !== -1`), nonce);

/* Read storage BEFORE the ROM boots: once a core is running it rewrites SRAM
 * within seconds, so a later read measures the new core, not what persisted. */
const persisted = await evaluate('window.__vj.readStoredSaveBytes(16).then(JSON.stringify)',
	{ awaitPromise: true }).then((s) => JSON.parse(s));
check('after a real page reload the save is still in IndexedDB',
	persisted && persisted.len === 32768, persisted ? `${persisted.len} bytes` : 'STORE EMPTY');
check('and its contents are byte-identical to what we wrote',
	persisted && JSON.stringify(persisted.head) === JSON.stringify(stored.head),
	persisted ? JSON.stringify(persisted.head.slice(0, 8)) : '-');

await waitFor('!!(window.__vj && window.__vj.running)', 30000, 'cached ROM to boot');
check('ROM resumed from the local cache without the picker', await evaluate('window.__vj.running'));
check('restored save is the one the core booted with',
	(await evaluate('JSON.stringify(window.__vj.readSaveBytes(16))')
		.then(JSON.parse))[0] === seed);

if (outDir) { await shoot('browser-02-after-reload'); }

/* ------------------------------------------------------------------ errors */

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (outDir) {
	writeFileSync(join(outDir, 'browser-check.json'),
		JSON.stringify({ url, rom: romPath, results, requests }, null, 2));
}
ws.close();
process.exit(failed.length ? 1 : 0);
