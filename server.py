#!/usr/bin/env python3
"""LocalThermo hub: reads a ThermoWorks BlueDOT and shows it to any browser on your network.

    pip install bleak
    python3 server.py                               # find a BlueDOT by name
    python3 server.py --address 00:a0:50:42:a1:d8   # insist on one particular BlueDOT
    python3 server.py --demo                        # simulated readings, no thermometer

This program talks to the thermometer itself, so any browser works as a display:
http://localhost:8000 on this computer, http://<this computer>:8000 elsewhere.

    python3 server.py --browser-bluetooth

skips that and lets the Chrome/Edge page on this computer do the Bluetooth instead
(Web Bluetooth), relaying its readings through this server. Needs no bleak.
"""
import argparse
import asyncio
import json
import math
import os
import socket
import struct
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
    "source": "browser",  # "server": this program reads the thermometer; "browser": the hub page does
    "demo": False,
    "interval": 5.0,      # seconds between logged readings
    "logged_at": 0,
}

NAME_PREFIX = "BlueDOT"
UPDATES_UUID = "783f2991-23e0-4bdc-ac16-78601bd84b39"


def decode_frame(data):
    """Decode the 20-byte status frame. Layout and sources are documented in bluedot.js."""
    if len(data) != 20:
        return None
    connected = data[0] == 0
    temp, alarm = struct.unpack_from("<ii", data, 1)
    return {
        "probeConnected": connected,
        "temp": temp if connected else None,
        "alarmTemp": alarm,
        "alarmSilenced": data[9] != 0,
        "alarmDisabled": data[10] != 0,
        "unit": "F" if data[11] == 1 else "C",
        "mac": ":".join(f"{b:02x}" for b in data[13:19]),
        "alarmActive": data[19] != 0,
    }


def encode_frame(temp, alarm=203, unit="F", mac="00:a0:50:00:00:00"):
    return struct.pack("<Bii3B", 0, round(temp), alarm, 0, 0, 1 if unit == "F" else 0) + b"\0" + bytes.fromhex(mac.replace(":", "")) + b"\0"


def normalize_mac(text):
    digits = "".join(c for c in (text or "").lower() if c in "0123456789abcdef")
    return ":".join(digits[i:i + 2] for i in range(0, 12, 2)) if len(digits) == 12 else ""


def set_status(kind, text):
    with lock:
        changed = state["status"]["text"] != text
        state["status"] = {"state": kind, "text": text}
    if changed:
        print(f"[{datetime.now():%H:%M:%S}] {text}")


def record_frame(data, t=None):
    """Take one frame from the thermometer; log a row if the interval has passed."""
    frame = decode_frame(data)
    if frame is None:
        return None
    t = t or now_ms()
    with lock:
        state["latest"] = frame
        state["frame_at"] = t
        if t - state["logged_at"] >= state["interval"] * 1000 - 200:
            state["logged_at"] = t
            add_rows([[t, frame["temp"], frame["unit"]]])
    return frame


def mark_gap():
    """Break the chart line where the connection dropped."""
    with lock:
        if state["rows"] and state["rows"][-1][1] is not None:
            add_rows([[now_ms(), None, state["rows"][-1][2]]])


def add_rows(rows):
    """Caller holds the lock."""
    state["rows"].extend(rows)
    del state["rows"][:-MAX_ROWS]
    if not state["demo"]:
        log_rows(rows)


def new_session():
    """Caller holds the lock."""
    state["session"] = now_ms()
    state["rows"] = []
    state["logged_at"] = 0
    if state["log"]:
        state["log"].close()
        state["log"] = None


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
                "hubAge": 0 if state["source"] == "server"
                else None if state["pushed_at"] is None else now - state["pushed_at"],
                "source": state["source"],
                "demo": state["demo"],
                "rows": rows,
                "local": self.client_address[0] in LOOPBACK,
                "lan": lan_address(),
                "port": state["port"],
            }
        self.send_json(payload)

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/push", "/api/reset"):
            return self.send_error(404)
        # Changes may only come from this computer. Requiring a JSON content type also
        # stops other websites from posting here through the browser.
        if self.client_address[0] not in LOOPBACK:
            return self.send_json({"error": "only the hub computer may do this"}, 403)
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self.send_json({"error": "expected application/json"}, 415)
        if path == "/api/reset":
            with lock:
                new_session()
            return self.send_json({"ok": True})
        if state["source"] != "browser":
            return self.send_json({"error": "this hub reads the thermometer itself"}, 409)
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
                new_session()
            if data.get("from") != len(state["rows"]):
                # The page and the hub disagree (for example the hub was restarted).
                return self.send_json({"resync": True})
            state["demo"] = bool(data.get("demo"))
            if isinstance(data.get("status"), dict):
                state["status"] = {
                    "state": str(data["status"].get("state", "idle"))[:20],
                    "text": str(data["status"].get("text", ""))[:200],
                }
            state["latest"] = data.get("latest") if isinstance(data.get("latest"), dict) else None
            frame_at = data.get("lastFrameAt")
            state["frame_at"] = frame_at if isinstance(frame_at, (int, float)) and frame_at > 0 else None
            if rows:
                add_rows(rows)
            count = len(state["rows"])
        self.send_json({"count": count})


class Server(ThreadingHTTPServer):
    daemon_threads = True


async def bluetooth_loop(expected_mac):
    """Find the BlueDOT, stay subscribed to it, and reconnect whenever the link drops."""
    from bleak import BleakClient, BleakScanner

    loop = asyncio.get_running_loop()
    rejected = set()   # BlueDOTs that turned out to be a different unit
    by_address = bool(expected_mac) and sys.platform != "darwin"  # macOS hides real addresses

    def wanted(device, adv):
        if device.address in rejected:
            return False
        if by_address and device.address.lower() == expected_mac:
            return True
        return (device.name or adv.local_name or "").startswith(NAME_PREFIX)

    while True:
        set_status("busy", "Looking for the BlueDOT")
        problem = None
        try:
            device = await BleakScanner.find_device_by_filter(wanted, timeout=15)
            if device is None:
                set_status("busy", "Looking for the BlueDOT. Is it on, in range, and not connected to the phone app?")
                continue
            done = asyncio.Event()
            seen = {"first": True, "wrong": None}

            def on_frame(_sender, data):
                frame = record_frame(bytes(data))
                if seen["first"]:
                    seen["first"] = False
                    print(f"  first frame: {bytes(data).hex(' ')}")
                    if frame is None:
                        print("  That is not the expected 20-byte frame; readings cannot be decoded.")
                if frame and expected_mac and frame["mac"] != expected_mac:
                    seen["wrong"] = frame["mac"]
                    loop.call_soon_threadsafe(done.set)

            set_status("busy", f"Connecting to {device.name or device.address}")
            async with BleakClient(device, disconnected_callback=lambda _c: loop.call_soon_threadsafe(done.set)) as client:
                for service in client.services:
                    print(f"  service {service.uuid}")
                await client.start_notify(UPDATES_UUID, on_frame)
                try:
                    on_frame(None, await client.read_gatt_char(UPDATES_UUID))
                except Exception:
                    pass  # not readable; the first notification will arrive shortly
                set_status("live", f"Connected to {device.name or 'BlueDOT'}")
                await done.wait()
            if seen["wrong"]:
                rejected.add(device.address)
                print(f"  That BlueDOT is {seen['wrong']}, not {expected_mac}; ignoring it.")
        except Exception as err:  # Bluetooth off, out of range, permission refused...
            problem = f"{type(err).__name__}: {err}"
        mark_gap()
        if problem:
            set_status("error", f"Bluetooth problem on the hub ({problem}). Retrying.")
            await asyncio.sleep(10)
        else:
            set_status("busy", "Connection lost, reconnecting")
            await asyncio.sleep(3)


async def demo_loop():
    start = now_ms() - 40 * 60000

    def frame_at(t):
        temp = 68 + 140 * (1 - math.exp(-(t - start) / (28 * 60000))) + math.sin(t / 47000) * 0.6
        return encode_frame(temp, mac="00:a0:50:42:a1:d8")

    for t in range(start, now_ms(), int(state["interval"] * 1000)):
        record_frame(frame_at(t), t)
    set_status("live", "Demo: simulated readings")
    while True:
        record_frame(frame_at(now_ms()))
        await asyncio.sleep(1)


def main():
    parser = argparse.ArgumentParser(description="LocalThermo hub")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--address", help="Bluetooth address of your BlueDOT, e.g. 00:a0:50:42:a1:d8")
    parser.add_argument("--interval", type=float, default=5, help="seconds between logged readings (default 5)")
    parser.add_argument("--demo", action="store_true", help="simulated readings, no thermometer needed")
    parser.add_argument("--browser-bluetooth", action="store_true",
                        help="let the Chrome/Edge page on this computer do the Bluetooth instead")
    parser.add_argument("--local-only", action="store_true", help="do not accept connections from other devices")
    args = parser.parse_args()
    state["port"] = args.port
    state["interval"] = max(args.interval, 1)
    state["demo"] = args.demo
    expected_mac = normalize_mac(args.address)
    if args.address and not expected_mac:
        sys.exit(f"--address should look like 00:a0:50:42:a1:d8, not {args.address!r}")

    job = None
    if args.demo:
        job = demo_loop()
    elif not args.browser_bluetooth:
        try:
            import bleak  # noqa: F401
            job = bluetooth_loop(expected_mac)
        except ImportError:
            print("The 'bleak' Bluetooth library is not installed, so this program cannot read the")
            print("thermometer itself. Install it and start again:\n\n    python3 -m pip install bleak\n")
            print("Carrying on in --browser-bluetooth mode: use Chrome or Edge on this computer.\n")
    state["source"] = "server" if job else "browser"

    server = Server(("127.0.0.1" if args.local_only else "0.0.0.0", args.port), Handler)
    if sys.platform == "darwin":
        # Keep the Mac from idle-sleeping while the hub runs (the display may still turn off).
        try:
            subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
        except OSError:
            pass

    browser = "any browser" if job else "Chrome or Edge"
    print(f"On this computer, open in {browser}:  http://localhost:{args.port}")
    if not args.local_only:
        lan = lan_address()
        print(f"On your phone (same network):  http://{lan or '<this computer>'}:{args.port}")
    print("Press Ctrl+C to stop.\n")
    try:
        if job:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            asyncio.run(job)
        else:
            server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
