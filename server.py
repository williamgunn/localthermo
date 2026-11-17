#!/usr/bin/env python3
"""LocalThermo hub: serves the app and relays readings to other devices on your network.

    python3 server.py            # then open http://localhost:8000 in Chrome on this computer
    python3 server.py --port 9000

The Chrome page on this computer talks to the BlueDOT and pushes readings here.
Any other device on the network can open http://<this computer>:8000 to watch them.
Only this computer may push; other devices can only read. Standard library only.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(ROOT, "logs")
# Only these files are served; nothing else in the folder is reachable.
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/bluedot.js": ("bluedot.js", "text/javascript; charset=utf-8"),
}
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
MAX_ROWS = 50000
MAX_BODY = 4 * 1024 * 1024

lock = threading.Lock()
state = {
    "session": int(time.time() * 1000),
    "rows": [],          # [epoch ms, value or None, "F" | "C"]
    "latest": None,      # last decoded frame from the page
    "frame_at": None,    # epoch ms of that frame
    "status": {"state": "idle", "text": "Not connected"},
    "pushed_at": None,   # when the hub page last checked in
    "log": None,         # open CSV file for this session
    "port": 8000,
}


def now_ms():
    return int(time.time() * 1000)


def lan_address():
    """This computer's address on the local network (no traffic is sent)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def to_f(value, unit):
    return value if unit == "F" else value * 9 / 5 + 32


def to_c(value, unit):
    return value if unit == "C" else (value - 32) * 5 / 9


def log_rows(rows):
    """Append readings to logs/bluedot-<session start>.csv. Caller holds the lock."""
    if state["log"] is None:
        os.makedirs(LOG_DIR, exist_ok=True)
        name = datetime.now().strftime("bluedot-%Y%m%d-%H%M%S.csv")
        state["log"] = open(os.path.join(LOG_DIR, name), "a", encoding="utf-8")
        state["log"].write("time,temp_f,temp_c,probe_connected\n")
        print(f"Logging to logs/{name}")
    for t, value, unit in rows:
        stamp = datetime.fromtimestamp(t / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if value is None:
            state["log"].write(f"{stamp},,,0\n")
        else:
            state["log"].write(f"{stamp},{to_f(value, unit):.1f},{to_c(value, unit):.1f},1\n")
    state["log"].flush()


def valid_row(row):
    return (
        isinstance(row, list) and len(row) == 3
        and isinstance(row[0], (int, float)) and not isinstance(row[0], bool)
        and (row[1] is None or (isinstance(row[1], (int, float)) and not isinstance(row[1], bool)))
        and row[2] in ("F", "C")
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalThermo"

    def log_message(self, *args):  # keep the terminal quiet
        pass

    def send_json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/state":
            return self.get_state(parse_qs(url.query))
        if url.path in STATIC:
            name, mime = STATIC[url.path]
            with open(os.path.join(ROOT, name), "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def get_state(self, query):
        try:
            since = float(query.get("since", ["0"])[0])
        except ValueError:
            since = 0
        with lock:
            same = query.get("session", [""])[0] == str(state["session"])
            rows = [r for r in state["rows"] if r[0] > since] if same else list(state["rows"])
            now = now_ms()
            payload = {
                "session": state["session"],
                "status": state["status"],
                "latest": state["latest"],
                "age": None if state["frame_at"] is None else now - state["frame_at"],
                "hubAge": None if state["pushed_at"] is None else now - state["pushed_at"],
                "rows": rows,
                "local": self.client_address[0] in LOOPBACK,
                "lan": lan_address(),
                "port": state["port"],
            }
        self.send_json(payload)

    def do_POST(self):
        if urlparse(self.path).path != "/api/push":
            return self.send_error(404)
        # Readings may only come from the page running on this computer. Requiring a JSON
        # content type also stops other websites from posting here through the browser.
        if self.client_address[0] not in LOOPBACK:
            return self.send_json({"error": "only the hub computer may push"}, 403)
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self.send_json({"error": "expected application/json"}, 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                raise ValueError("bad length")
            data = json.loads(self.rfile.read(length))
            rows = data.get("rows", [])
            if not isinstance(rows, list) or not all(valid_row(r) for r in rows):
                raise ValueError("bad rows")
        except (ValueError, AttributeError):
            return self.send_json({"error": "bad request"}, 400)

        with lock:
            state["pushed_at"] = now_ms()
            if data.get("reset"):
                state["session"] = now_ms()
                state["rows"] = []
                if state["log"]:
                    state["log"].close()
                    state["log"] = None
            if data.get("from") != len(state["rows"]):
                # The page and the hub disagree (for example the hub was restarted).
                return self.send_json({"resync": True})
            state["rows"].extend(rows)
            del state["rows"][:-MAX_ROWS]
            if isinstance(data.get("status"), dict):
                state["status"] = {
                    "state": str(data["status"].get("state", "idle"))[:20],
                    "text": str(data["status"].get("text", ""))[:200],
                }
            state["latest"] = data.get("latest") if isinstance(data.get("latest"), dict) else None
            frame_at = data.get("lastFrameAt")
            state["frame_at"] = frame_at if isinstance(frame_at, (int, float)) and frame_at > 0 else None
            if rows and not data.get("demo"):
                log_rows(rows)
            count = len(state["rows"])
        self.send_json({"count": count})


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description="LocalThermo hub")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--local-only", action="store_true", help="do not accept connections from other devices")
    args = parser.parse_args()
    state["port"] = args.port

    server = Server(("127.0.0.1" if args.local_only else "0.0.0.0", args.port), Handler)
    if sys.platform == "darwin":
        # Keep the Mac from idle-sleeping while the hub runs (the display may still turn off).
        try:
            subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        except OSError:
            pass

    print(f"On this computer, open in Chrome:  http://localhost:{args.port}")
    if not args.local_only:
        lan = lan_address()
        print(f"On your phone (same network):      http://{lan or '<this computer>'}:{args.port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
