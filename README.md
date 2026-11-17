# LocalThermo

Reads a ThermoWorks BlueDOT thermometer over Bluetooth and shows it in a web page:
live readout, temperature chart, alerts and CSV logging. One computer near the
thermometer acts as the hub; a phone or anything else on your network can watch along.
Nothing leaves your network, and there is no account.

## Run it

On the computer that will sit near the thermometer (the hub, for example a Mac):

```
python3 -m pip install bleak
python3 server.py --address 00:a0:50:42:a1:d8
```

`server.py` connects to the BlueDOT itself and prints two addresses:

- `http://localhost:8000` for the hub computer, in **any browser**
- `http://<hub address>:8000` for **your phone or any other device on the same
  network**, also in any browser

Try it without a thermometer using `python3 server.py --demo`.

Things to know:

- Close the ThermoWorks phone app first: the BlueDOT takes one connection at a time.
- `--address` is optional. Without it the hub uses the first device named BlueDOT. On
  macOS, which hides Bluetooth addresses, the hub connects by name and then checks the
  address the thermometer reports about itself, skipping any BlueDOT that is not yours.
- macOS asks once to let your terminal app use Bluetooth (System Settings → Privacy &
  Security → Bluetooth), and may ask whether Python can accept incoming connections.
  Allow both.
- The hub must stay awake. On a Mac `server.py` prevents idle sleep while it runs, but
  closing a laptop lid still sleeps it.
- Readings are saved on the hub as CSV in `logs/`, one file per session. **New
  session** (hub computer only) starts a fresh chart and file.
- Alerts are set per device and only fire while the page is open with the screen on.
  Tap the page once (for example **Test alert**) so a phone allows sound.
- Anyone on your network can view the readings; only the hub computer can reset them.
  `--local-only` turns off access from other devices. `--interval 15` logs less often.
- The terminal shows connection progress, the services found and the first raw frame,
  which is what to copy if readings look wrong.

## Alternative: Bluetooth in the browser

`python3 server.py --browser-bluetooth` needs no `bleak`. Instead the page at
`http://localhost:8000` does the Bluetooth itself through Web Bluetooth, which means
Chrome or Edge only on the hub, and that page has to stay open. Other devices still
watch in any browser. The same page also works with no server at all from any https
host (GitHub Pages, say) as a single-device app.

This mode needs a one-time setup, because a browser only lets a page touch Bluetooth
services the page names up front and the BlueDOT's service UUID is not documented
anywhere I could find:

1. In Chrome open `chrome://bluetooth-internals/#devices`, press **Start Scan**, find
   **BlueDOT** and press **Inspect**.
2. Copy the text under **Services** and paste it into **Bluetooth setup and
   diagnostics** at the bottom of the app, then **Save** and **Connect**.

`python3 tools/discover.py` prints the same UUID.

## Features

- Live temperature, rate of change, session low/high, and the alarm set on the device
- Chart with 15 min / 1 hour / all ranges, hover readout, and a table view
- High and low alerts with sound, an on-page banner and (on the hub computer) optional
  desktop notifications, plus a rough time-to-target estimate
- CSV logging on the hub, and **Download CSV** from any device
- Reconnects automatically if the Bluetooth link drops

The app only reads from the thermometer. It never writes settings to it.

## Protocol

ThermoWorks does not publish the protocol. `server.py` and `bluedot.js` follow community reverse
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
The hub, viewers and alerts were tested with simulated readings. The Bluetooth
connection itself has not been tested against a physical BlueDOT in either mode.
