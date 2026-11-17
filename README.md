# LocalThermo

A web page that reads a ThermoWorks BlueDOT thermometer directly over Bluetooth
(Web Bluetooth), with a live readout, a temperature chart, alerts and CSV logging.
An optional hub server lets a phone or other device on your network watch along.
Nothing leaves your network, and there is no account.

## Run it

On the computer that will sit near the thermometer (the hub, for example a Mac):

```
python3 server.py        # or: npm start
```

It prints two addresses:

- `http://localhost:8000`: open this in **Chrome or Edge on the hub**. This page talks
  to the BlueDOT (Web Bluetooth does not work in Safari or Firefox). Press **Demo** to
  try it with simulated readings.
- `http://<hub address>:8000`: open this on **your phone or any other device on the
  same network**, in any browser including iPhone Safari. It shows the same readout,
  chart and alerts, fed by the hub.

How the hub works, and its limits:

- The hub's Chrome page must stay open and connected; it is what reads the BlueDOT.
  Give it its own window rather than a background tab. On a Mac, `server.py` keeps the
  computer from idle-sleeping while it runs, but closing a laptop lid still sleeps it.
- Readings are also saved on the hub as CSV in `logs/`, one file per session.
- Alerts on a phone are set on that phone and only fire while the page is open with
  the screen on. Tap the page once (for example **Test alert**) so the phone allows sound.
- Anyone on your network can view the readings; only the hub itself can send them.
  Use `python3 server.py --local-only` to turn off access from other devices.
- macOS may ask whether to allow incoming connections for Python the first time; allow it.

The folder is plain static files, so it also works without `server.py` on any https
host (GitHub Pages, say) as a single-device app with no relay.

## One-time setup: the service UUID

A browser only lets a page touch Bluetooth services the page names up front, and the
BlueDOT's service UUID is not documented anywhere I could find. You need to look it up
once:

1. Close the ThermoWorks app on your phone (the BlueDOT takes one connection at a time).
2. In Chrome open `chrome://bluetooth-internals/#devices`, press **Start Scan**, find
   **BlueDOT** and press **Inspect**.
3. Copy the text under **Services** and paste it into **Bluetooth setup and
   diagnostics** at the bottom of the app, then **Save**. The app picks the UUIDs out
   of whatever you paste.

Alternatives: the nRF Connect phone app, or `pip install bleak && python3 tools/discover.py`.

Then press **Connect** and choose the BlueDOT in the browser's prompt. Browsers do not
allow connecting by MAC address, so the address is used differently: the BlueDOT
reports its own address in every reading, and the app warns you if it is not the one
you expect (`00:a0:50:42:a1:d8` by default; change it in setup).

## Features

- Live temperature, rate of change, session low/high, and the alarm set on the device
- Chart with 15 min / 1 hour / all ranges, hover readout, and a table view
- High and low alerts with sound, an on-page banner and optional desktop notifications,
  plus a rough time-to-target estimate
- Logging: readings persist in the browser across reloads; **Download CSV** at any
  time, or **Log continuously to a file** (desktop Chrome/Edge) to append every 15 s
- Reconnects automatically if the link drops; keeps the screen awake while connected

The app only reads from the thermometer. It never writes settings to it.

## Protocol

ThermoWorks does not publish the protocol. `bluedot.js` follows community reverse
engineering, which agrees across three independent projects:

- [jeffsf/pyDE1](https://github.com/jeffsf/pyDE1) `src/pyDE1/thermometer/bluedot.py`
- [jamesshannon/thermoworks-ha](https://github.com/jamesshannon/thermoworks-ha) `custom_components/thermoworks_bt/ble/bluedot.py`
- [wnoisephx/thermoworks-ble](https://github.com/wnoisephx/thermoworks-ble) `Docs/BlueDot.txt`

Characteristic `783f2991-23e0-4bdc-ac16-78601bd84b39` notifies a 20-byte frame:

| Bytes | Meaning |
|-------|---------|
| 0 | Probe status: 0 connected, 3 no probe |
| 1-4 | Temperature, int32 little-endian, whole degrees in the device's unit |
| 5-8 | Alarm temperature set on the device, same encoding |
| 9 | Alarm silenced |
| 10 | Alarm disabled |
| 11 | Unit: 0 Celsius, 1 Fahrenheit |
| 12 | Unknown |
| 13-18 | Device MAC address |
| 19 | Alarm sounding |

If readings look wrong, open **Diagnostics** in the app and copy the raw frames.

## Tests

```
npm test
```

Covers the frame decoder (including a real captured frame from the wnoisephx notes).
The hub relay was tested with simulated readings. The Bluetooth connection itself has
not been tested against a physical BlueDOT.
