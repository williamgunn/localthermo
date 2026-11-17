// ThermoWorks BlueDOT Bluetooth LE protocol helpers.
//
// ThermoWorks does not publish this protocol. The layout below comes from
// community reverse engineering, cross-checked across three projects:
//   - https://github.com/jeffsf/pyDE1 (src/pyDE1/thermometer/bluedot.py)
//   - https://github.com/jamesshannon/thermoworks-ha (ble/bluedot.py)
//   - https://github.com/wnoisephx/thermoworks-ble (Docs/BlueDot.txt)

export const NAME_PREFIX = 'BlueDOT';

// Characteristic that notifies a 20-byte status frame (also readable).
export const UPDATES_UUID = '783f2991-23e0-4bdc-ac16-78601bd84b39';

// Other characteristics listed by pyDE1. This app never writes to them; they
// are only used to label what the diagnostics panel finds.
export const KNOWN_CHARACTERISTICS = {
  [UPDATES_UUID]: 'status updates (notify)',
  '60721d99-6698-4eec-8e0a-50d0c37f17b9': 'update interval',
  'de0415cf-d54a-4ea4-a58f-c7aa07f79baa': 'high alarm',
  'bfdbeb45-11a3-4406-bcb4-ed7c6f939fbc': 'low alarm',
  'c86cf012-5c33-48aa-82d1-84a57c908ca0': 'units',
};

export const FRAME_LENGTH = 20;

/**
 * Decode a status frame.
 *
 *   0      probe status (0 = connected, 3 = no probe)
 *   1-4    temperature, int32 little-endian, whole degrees in the device's unit
 *   5-8    alarm temperature set on the device, same encoding
 *   9      alarm silenced
 *   10     alarm disabled
 *   11     unit (0 = Celsius, 1 = Fahrenheit)
 *   12     unknown
 *   13-18  the device's Bluetooth MAC address
 *   19     alarm currently sounding
 *
 * @param {DataView} view
 * @returns {object|null} null when the frame is not 20 bytes long
 */
export function decodeFrame(view) {
  if (!view || view.byteLength !== FRAME_LENGTH) return null;
  const mac = [];
  for (let i = 13; i < 19; i++) mac.push(view.getUint8(i).toString(16).padStart(2, '0'));
  const probeConnected = view.getUint8(0) === 0;
  return {
    probeConnected,
    temp: probeConnected ? view.getInt32(1, true) : null,
    alarmTemp: view.getInt32(5, true),
    alarmSilenced: view.getUint8(9) !== 0,
    alarmDisabled: view.getUint8(10) !== 0,
    unit: view.getUint8(11) === 1 ? 'F' : 'C',
    mac: mac.join(':'),
    alarmActive: view.getUint8(19) !== 0,
  };
}

export function convert(value, from, to) {
  if (value == null || from === to) return value;
  return to === 'C' ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32;
}

export function toHex(view) {
  const out = [];
  for (let i = 0; i < view.byteLength; i++) out.push(view.getUint8(i).toString(16).padStart(2, '0'));
  return out.join(' ');
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHORT_RE = /\b0x([0-9a-f]{4})\b/gi;

/**
 * Pull every Bluetooth UUID out of free text (for example a copy of
 * chrome://bluetooth-internals), so the user can paste without tidying up.
 * Characteristic UUIDs we already know are dropped: only services are wanted.
 */
export function extractUuids(text) {
  const found = new Set();
  for (const m of String(text).matchAll(UUID_RE)) found.add(m[0].toLowerCase());
  for (const m of String(text).matchAll(SHORT_RE)) {
    found.add(`0000${m[1].toLowerCase()}-0000-1000-8000-00805f9b34fb`);
  }
  for (const known of Object.keys(KNOWN_CHARACTERISTICS)) found.delete(known);
  return [...found];
}

export function normalizeMac(text) {
  const hex = String(text || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex.match(/../g).join(':') : '';
}

/** Build a frame; used by demo mode and the tests. */
export function encodeFrame({ temp = 0, alarmTemp = 0, unit = 'F', probeConnected = true, mac = '00:a0:50:00:00:00', alarmActive = false } = {}) {
  const view = new DataView(new ArrayBuffer(FRAME_LENGTH));
  view.setUint8(0, probeConnected ? 0 : 3);
  view.setInt32(1, Math.round(temp), true);
  view.setInt32(5, Math.round(alarmTemp), true);
  view.setUint8(11, unit === 'F' ? 1 : 0);
  normalizeMac(mac).split(':').forEach((b, i) => view.setUint8(13 + i, parseInt(b, 16)));
  view.setUint8(19, alarmActive ? 1 : 0);
  return view;
}
