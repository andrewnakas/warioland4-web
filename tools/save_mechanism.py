#!/usr/bin/env python3
"""Does EmulatorJS's `exit` handler actually empty the save store?  No race.

save_soak.py measures the user-visible outcome (navigate away, come back), which
is a race against the page dying and therefore noisy.  This isolates the
mechanism: it fires EmulatorJS's `exit` event by hand -- the exact thing its
beforeunload listener does -- and then looks at the IndexedDB store from the
SAME live page.  Deterministic, and it answers the question the soak can only
answer statistically.

    python3 tools/save_mechanism.py /path/to/rom.gba

Reports, in order: the store after boot, whether /data/saves is still an IDBFS
mount after `exit`, and the store after `exit`.
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import cdp  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

MOUNT_STATE = """(function () {
  try {
    const n = window.EJS_emulator.gameManager.FS.lookupPath('/data/saves').node;
    return JSON.stringify({
      mounted: !!n.mount,
      autoPersist: !!(n.mount && n.mount.opts && n.mount.opts.autoPersist),
      type: n.mount && n.mount.type && n.mount.type.name || null
    });
  } catch (e) { return JSON.stringify({error: String(e)}); }
})()"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("rom", type=pathlib.Path)
    ap.add_argument("--port", type=int, default=8589)
    ap.add_argument("--cdp-port", type=int, default=9589)
    ap.add_argument("--keep-ejs-unload", action="store_true",
                    help="irrelevant here: we fire `exit` by hand either way")
    a = ap.parse_args()

    srv = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(a.port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    base = f"http://localhost:{a.port}/index.html"
    chrome = None
    res = {}
    try:
        chrome = cdp.Chrome(port=a.cdp_port, headless=True)
        tab = chrome.tab("about:blank")
        tab.goto(f"{base}?mute=1&autostart=1"
                 + ("&ejsunload=keep" if a.keep_ejs_unload else ""))
        tab.set_file_input("#file", [str(a.rom.resolve())])
        for _ in range(180):
            if tab.js("window.__pfr.started === true"):
                break
            time.sleep(0.5)
        else:
            print("core never started")
            return 1
        for _ in range(60):
            time.sleep(0.25)
            tab.js("0")
        tab.js("window.__pfr.save('mechanism')")
        time.sleep(1.5)

        # Control: prove the two arms of save_soak.py are actually different.
        # If ?ejsunload=keep silently did nothing, both arms would be the same
        # page and "8/8 kept" would mean nothing at all.
        dropped = any("dropped EmulatorJS's beforeunload" in line
                      for line in tab.console())
        res["ejs_listener_dropped"] = dropped
        print(f"  arm: EmulatorJS's beforeunload "
              f"{'DROPPED by us' if dropped else 'left in place'}"
              f"  (--keep-ejs-unload={a.keep_ejs_unload})")
        if dropped == a.keep_ejs_unload:
            print("  !! the arm is not doing what it says -- the control is broken")

        res["before"] = tab.js("window.__pfr.idbSave()", await_promise=True, timeout=30)
        res["mount_before"] = json.loads(tab.js(MOUNT_STATE))
        print(f"  after boot        files={res['before'].get('files')}")
        print(f"                    mount={res['mount_before']}")

        # Phase 1: dispatch a real `beforeunload` event, the way leaving the page
        # does -- but without actually unloading, so nothing is racing the page's
        # death and the result is deterministic.  THIS is the user-facing path.
        print("  dispatching beforeunload (no actual unload, so no race) ...")
        tab.js("window.dispatchEvent(new Event('beforeunload'))")
        time.sleep(4.0)
        res["mount_after_beforeunload"] = json.loads(tab.js(MOUNT_STATE))
        res["after_beforeunload"] = tab.js("window.__pfr.idbSave()",
                                           await_promise=True, timeout=30)
        bu_emptied = (not res["after_beforeunload"].get("files")
                      and bool(res["before"].get("files")))
        print(f"  after beforeunload files={res['after_beforeunload'].get('files')}")
        print(f"                     mount={res['mount_after_beforeunload']}")
        print(f"  -> save destroyed by beforeunload: {'YES' if bu_emptied else 'no'}")
        res["destroyed_by_beforeunload"] = bu_emptied

        # Phase 2: fire the `exit` event directly, which is what that listener
        # calls. This shows the mechanism exists regardless of which arm we are
        # in -- the fix is not "make exit safe", it is "never let beforeunload
        # reach exit".
        print("  firing EmulatorJS's `exit` event by hand ...")
        try:
            tab.js("window.EJS_emulator.callEvent('exit')")
        except Exception as e:
            # expected in the stock arm: beforeunload already tore the mount
            # down, so the second exit throws ErrnoError unmounting nothing
            print(f"    (exit threw: {e}; the mount was already gone)")
        time.sleep(4.0)

        res["mount_after"] = json.loads(tab.js(MOUNT_STATE))
        res["after"] = tab.js("window.__pfr.idbSave()", await_promise=True, timeout=30)
        print(f"  after exit        files={res['after'].get('files')}")
        print(f"                    mount={res['mount_after']}")

        emptied = not res["after"].get("files") and bool(res["before"].get("files"))
        unmounted = (res["mount_before"].get("mounted")
                     and not res["mount_after"].get("autoPersist"))
        print()
        print(f"  store emptied by `exit`: {'YES' if emptied else 'no'}")
        print(f"  /data/saves unmounted  : {'YES' if unmounted else 'no'}")
        res["emptied"] = emptied
        res["unmounted"] = unmounted
    finally:
        if chrome:
            chrome.kill()
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:
            srv.kill()
    out = ROOT / "out"
    out.mkdir(exist_ok=True)
    (out / "save_mechanism.json").write_text(json.dumps(res, indent=2))
    print(f"\nwritten to {out / 'save_mechanism.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
