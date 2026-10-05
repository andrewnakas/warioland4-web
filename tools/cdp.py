#!/usr/bin/env python3
"""A Chrome DevTools Protocol client in the standard library only.

This box has no websocket-client, no playwright and no node, so rather than add
a dependency we speak RFC 6455 over a raw socket.  Enough of it for CDP: text
frames, client masking, continuation frames, ping/pong, close.

    with Chrome(port=9585, headless=True) as c:
        tab = c.tab("http://localhost:8585/")
        tab.call("Runtime.evaluate", expression="1+1", returnByValue=True)
"""
import base64
import json
import os
import pathlib
import random
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request


class WS:
    """Minimal RFC 6455 client."""

    def __init__(self, url: str, timeout: float = 30.0):
        assert url.startswith("ws://"), url
        host_port, _, path = url[5:].partition("/")
        host, _, port = host_port.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("handshake closed")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.decode(errors="replace")[:200])
        self.buf = rest

    # ---- framing ----
    def _recv(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self.buf)))
            if not chunk:
                raise ConnectionError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes):
        head = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 1 << 16:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + masked)

    def send(self, text: str):
        self._send_frame(0x1, text.encode())

    def recv(self) -> str:
        """Next complete text message. Answers pings, skips binary."""
        while True:
            parts, opcode = [], None
            while True:
                b0, b1 = self._recv(2)
                fin, op = b0 & 0x80, b0 & 0x0F
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self._recv(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self._recv(8))[0]
                if b1 & 0x80:            # server frames must not be masked
                    self._recv(4)
                data = self._recv(n) if n else b""
                if op == 0x9:            # ping
                    self._send_frame(0xA, data)
                    continue
                if op == 0xA:            # pong
                    continue
                if op == 0x8:            # close
                    raise ConnectionError("server closed websocket")
                if op != 0x0:
                    opcode = op
                parts.append(data)
                if fin:
                    break
            if opcode == 0x1:
                return b"".join(parts).decode(errors="replace")
            # binary frame: not something CDP sends; ignore and read the next

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


class Tab:
    def __init__(self, ws_url: str, timeout: float = 30.0):
        self.ws = WS(ws_url, timeout)
        self.n = 0
        self.events: list[dict] = []

    def call(self, method: str, _timeout: float | None = None, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        if _timeout:
            self.ws.sock.settimeout(_timeout)
        try:
            while True:
                msg = json.loads(self.ws.recv())
                if msg.get("id") == mid:
                    if "error" in msg:
                        raise RuntimeError(f"{method}: {msg['error']}")
                    return msg.get("result", {})
                if "method" in msg:
                    self.events.append(msg)
        finally:
            self.ws.sock.settimeout(30.0)

    def js(self, expression: str, await_promise: bool = False, timeout: float = 30.0):
        r = self.call("Runtime.evaluate", _timeout=timeout, expression=expression,
                      returnByValue=True, awaitPromise=await_promise)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise RuntimeError("JS: " + (d.get("exception", {}).get("description")
                                         or d.get("text", "?")))
        return r.get("result", {}).get("value")

    def console(self) -> list[str]:
        out = []
        for e in self.events:
            if e["method"] == "Runtime.consoleAPICalled":
                out.append(" ".join(
                    str(a.get("value", a.get("description", "")))
                    for a in e["params"].get("args", [])))
            elif e["method"] == "Log.entryAdded":
                out.append("[log] " + e["params"]["entry"].get("text", ""))
            elif e["method"] == "Runtime.exceptionThrown":
                d = e["params"]["exceptionDetails"]
                out.append("[exception] " + (d.get("exception", {}).get("description")
                                             or d.get("text", "")))
        self.events = [e for e in self.events if e["method"] not in (
            "Runtime.consoleAPICalled", "Log.entryAdded", "Runtime.exceptionThrown")]
        return out

    def screenshot(self, path: pathlib.Path):
        r = self.call("Page.captureScreenshot", format="png", _timeout=60)
        path.write_bytes(base64.b64decode(r["data"]))

    def set_file_input(self, selector: str, files: list[str]):
        doc = self.call("DOM.getDocument")["root"]["nodeId"]
        node = self.call("DOM.querySelector", nodeId=doc, selector=selector)["nodeId"]
        if not node:
            raise RuntimeError(f"no such element: {selector}")
        self.call("DOM.setFileInputFiles", nodeId=node, files=files)

    def goto(self, url: str, timeout: float = 40.0) -> bool:
        """Navigate and wait until the NEW document is the one answering.

        Plain Page.navigate followed by "poll until the thing I want exists" is
        a trap: for a moment after the call, Runtime.evaluate still runs against
        the OLD document, so a check for a global the previous page also defined
        returns true immediately and the test then measures the page it was
        trying to leave. A per-navigation nonce in the query string removes the
        ambiguity.
        """
        if url.startswith("about:"):
            self.call("Page.navigate", url=url)
            end = time.time() + timeout
            while time.time() < end:
                try:
                    if self.js("location.href") == url:
                        return True
                except Exception:
                    pass
                time.sleep(0.2)
            return False
        nonce = "nav%d" % random.randrange(1 << 30)
        full = url + ("&" if "?" in url else "?") + "_n=" + nonce
        self.call("Page.navigate", url=full)
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.js(f"location.search.indexOf('{nonce}') !== -1"
                           " && document.readyState !== 'loading'"):
                    return True
            except Exception:
                pass
            time.sleep(0.2)
        return False

    def close(self):
        self.ws.close()


class Chrome:
    def __init__(self, port: int = 9585, headless: bool = True,
                 window: str = "960,720", binary: str | None = None):
        self.port = port
        self.profile = tempfile.mkdtemp(prefix="pfr-chrome-")
        exe = binary or shutil.which("google-chrome") or shutil.which("chromium") \
            or shutil.which("google-chrome-stable")
        if not exe:
            raise RuntimeError("no chrome/chromium on PATH")
        args = [
            exe,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={self.profile}",
            f"--window-size={window}",
            "--mute-audio",                      # fleet rule: audio off in every test
            "--autoplay-policy=no-user-gesture-required",
            "--no-first-run", "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--disable-features=CalculateNativeWinOcclusion",
            # software GL: the core needs WebGL and there is no display here
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "about:blank",
        ]
        if headless:
            args.insert(1, "--headless=new")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        self._wait()

    def _wait(self, secs: float = 30.0):
        end = time.time() + secs
        while time.time() < end:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version",
                                       timeout=1).read()
                return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("chrome did not open its debug port")

    def tab(self, url: str) -> Tab:
        # /json/new has been PUT-only since Chrome 111 (it used to accept GET).
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/json/new?{url}", method="PUT")
        info = json.loads(urllib.request.urlopen(req, timeout=10).read())
        t = Tab(info["webSocketDebuggerUrl"])
        t.target_id = info["id"]
        t.call("Runtime.enable")
        t.call("Log.enable")
        t.call("Page.enable")
        t.call("DOM.enable")
        return t

    def close_tab(self, tab: Tab):
        try:
            tab.close()
            urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}/json/close/{tab.target_id}", timeout=5).read()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.kill()

    def kill(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        shutil.rmtree(self.profile, ignore_errors=True)
