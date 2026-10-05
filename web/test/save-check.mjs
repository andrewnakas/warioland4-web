/* Does this page's cartridge save actually survive leaving the page?
 *
 *   CDP_URL=ws://... node save-check.mjs <url> <rom>
 *
 * Method borrowed from ~/decompfleet/games/pokefirered/tools/save_mechanism.py.
 * That harness tests EmulatorJS's internals, which this page does not use, so
 * what is reused is the *method*, not the code:
 *
 *   1. Dispatch the lifecycle event rather than navigating away. A real
 *      navigation is a race that the page usually wins even when it is broken
 *      -- the tab dies before a destructive teardown's IndexedDB writes land.
 *      On this fleet that produced 8/8 clean runs of the navigate-away
 *      experiment on a page that was provably losing saves. Dispatching removes
 *      the race and makes the answer deterministic.
 *
 *   2. VERIFY THE DETECTOR. A comparison between two arms is worthless if the
 *      thing that is supposed to differ between them silently does nothing. So
 *      this runs a deliberately broken arm as well: the harness injects a
 *      destructive pagehide listener of exactly the shape that breaks the
 *      EmulatorJS pages (wipe the store on the way out), and the test fails
 *      unless the detector reports that arm as DESTROYED. Only then does
 *      "the real page is INTACT" mean anything.
 *
 * The broken arm lives here in the test, never in the shipped page.
 */

import { loadMap } from './symbols.mjs';

const [url, romPath] = process.argv.slice(2);
if (!url || !romPath) {
	console.error('usage: node save-check.mjs <url> <rom>');
	process.exit(2);
}

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
	return !!ok;
}

const endpoint = process.env.CDP_URL;
if (!endpoint) { console.error('CDP_URL not set'); process.exit(2); }

const ws = new WebSocket(endpoint);
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) { reject(new Error(msg.error.message)); } else { resolve(msg.result); }
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
async function evaluate(expression, awaitPromise = false) {
	const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
	if (r.exceptionDetails) {
		throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ||
			r.exceptionDetails.text));
	}
	return r.result.value;
}
const pump = (ms) => new Promise((res) => setTimeout(res, ms));
async function waitFor(expr, timeoutMs, label) {
	const t0 = Date.now();
	for (;;) {
		let v = false;
		try { v = await evaluate(expr); } catch { /* document swapping */ }
		if (v) { return true; }
		if (Date.now() - t0 > timeoutMs) { throw new Error(`timed out waiting for ${label}`); }
		await pump(100);
	}
}

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');

let nonce = '';
async function goto(base) {
	nonce = 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36);
	await send('Page.navigate', { url: base + (base.includes('?') ? '&' : '?') + '_n=' + nonce });
	await waitFor(`location.search.indexOf(${JSON.stringify(nonce)}) !== -1 && document.readyState !== 'loading'`,
		20000, 'the new document');
}

/* Boot the page with the ROM through the real picker and write a known pattern
 * into the cartridge SRAM. Returns the seed byte. */
async function bootAndSeed() {
	await waitFor('!!(window.__vj && window.__vj.ready)', 30000, 'core init');
	const doc = await send('DOM.getDocument');
	const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#rom-file' });
	await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [romPath] });
	await waitFor('!!(window.__vj && window.__vj.running)', 30000, 'ROM boot');
	/* Freeze the core before marking the save. Wario Land 4 rewrites its SRAM
	 * image while it runs, so an unfrozen core overwrites the marker within a
	 * second or so and the test then reports the page as having lost the save
	 * when nothing of the sort happened. That is a race in the measurement, not
	 * a bug in the page, and it produced an intermittent red here before this
	 * line existed. */
	await evaluate('window.__vj.setPaused(true)');
	const froze = await evaluate('window.__vj.isPaused()');
	if (!froze) { throw new Error('could not freeze the core; the save test would be a race'); }
	const seed = 0x50 + (Date.now() & 0x0f);
	await evaluate(`window.__vj.pokeSave(${seed})`, true);
	await pump(300);
	return seed;
}

/* The detector: what is in the store, read from the live page. */
async function storeState() {
	const s = await evaluate('window.__vj.readStoredSaveBytes(8).then(JSON.stringify)', true);
	const v = JSON.parse(s);
	return v === null ? { len: 0, head: [] } : v;
}

const STAGES = [
	{
		name: 'real page (shipped)',
		/* Nothing injected. */
		inject: null,
		expect: 'INTACT'
	},
	{
		name: 'deliberately broken arm (detector control)',
		/* A destructive unload handler of the shape that breaks the EmulatorJS
		 * pages on this fleet: on the way out, tear the store down. If the
		 * detector cannot see this, it cannot see the real bug either. */
		inject: `window.addEventListener('pagehide', function () {
                   indexedDB.deleteDatabase('warioland4-web');
                   window.__brokenArmInstalled = true;
                 });
                 window.__brokenArmInstalled = 'pending'; 1`,
		expect: 'DESTROYED'
	}
];

console.log('deterministic save-mechanism test: dispatch, do not navigate\n');

const observed = {};
for (const stage of STAGES) {
	await goto(url);
	/* Clear storage so each arm starts from the same place. */
	await evaluate(`new Promise(function (r) {
      var q = indexedDB.deleteDatabase('warioland4-web');
      q.onsuccess = q.onerror = q.onblocked = function () { r(1); };
    })`, true);
	await goto(url);

	const seed = await bootAndSeed();
	const before = await storeState();
	check(`[${stage.name}] save is in the store before the event`,
		before.len === 32768 && before.head[0] === seed, `${before.len} bytes`);

	let armLive = true;
	if (stage.inject) {
		await evaluate(stage.inject);
		armLive = (await evaluate('window.__brokenArmInstalled')) === 'pending';
		check(`[${stage.name}] the injected arm is actually present`, armLive);
	}

	/* Dispatch, do not navigate. */
	await evaluate(`window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange')); 1`);
	await pump(900);

	const after = await storeState();
	/* Two distinct ways to lose the save, and they are worth telling apart:
	 * the store can be emptied outright, or it can still hold 32 KiB that is no
	 * longer the data we wrote. Both are data loss; only the first is what the
	 * EmulatorJS teardown does. */
	const verdict = after.len !== 32768 ? 'DESTROYED (store emptied)'
		: after.head[0] !== seed ? 'DESTROYED (bytes replaced)'
			: 'INTACT';
	observed[stage.name] = verdict.startsWith('DESTROYED') ? 'DESTROYED' : 'INTACT';
	console.log(`    ${stage.name}: ${after.len} bytes, head ${JSON.stringify(after.head.slice(0, 4))}, ` +
		`seed 0x${seed.toString(16)} -> ${verdict}`);
	check(`[${stage.name}] verdict is ${stage.expect}`, observed[stage.name] === stage.expect,
		verdict);
}

check('the detector discriminates: the two arms disagree',
	observed[STAGES[0].name] !== observed[STAGES[1].name],
	`${STAGES[0].name}=${observed[STAGES[0].name]}, ${STAGES[1].name}=${observed[STAGES[1].name]}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
ws.close();
process.exit(failed.length ? 1 : 0);
