import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, encodeFrame, convert, extractUuids, normalizeMac, UPDATES_UUID } from '../bluedot.js';

const frame = (hex) => new DataView(Uint8Array.from(hex.split('-').map((b) => parseInt(b, 16))).buffer);

test('decodes the captured frame from wnoisephx/thermoworks-ble Docs/BlueDot.txt', () => {
  const r = decodeFrame(frame('00-5C-00-00-00-A5-00-00-00-00-00-01-00-00-A0-50-B0-31-94-00'));
  assert.deepEqual(r, {
    probeConnected: true,
    temp: 92,
    alarmTemp: 165,
    alarmSilenced: false,
    alarmDisabled: false,
    unit: 'F',
    mac: '00:a0:50:b0:31:94',
    alarmActive: false,
  });
});

test('reports no temperature when the probe is unplugged', () => {
  const r = decodeFrame(frame('03-00-00-00-00-A5-00-00-00-00-00-00-00-00-A0-50-42-A1-D8-00'));
  assert.equal(r.probeConnected, false);
  assert.equal(r.temp, null);
  assert.equal(r.unit, 'C');
  assert.equal(r.mac, '00:a0:50:42:a1:d8');
});

test('handles negative and multi-byte temperatures', () => {
  assert.equal(decodeFrame(encodeFrame({ temp: -18, unit: 'C' })).temp, -18);
  assert.equal(decodeFrame(encodeFrame({ temp: 572 })).temp, 572);
});

test('rejects frames of the wrong length', () => {
  assert.equal(decodeFrame(new DataView(new ArrayBuffer(5))), null);
});

test('converts units', () => {
  assert.equal(convert(212, 'F', 'C'), 100);
  assert.equal(convert(100, 'C', 'F'), 212);
  assert.equal(convert(50, 'F', 'F'), 50);
  assert.equal(convert(null, 'F', 'C'), null);
});

test('extracts service UUIDs from pasted text', () => {
  const text = `Service 0x1800 primary\nUUID: ABCDEF01-2345-6789-abcd-ef0123456789\n${UPDATES_UUID}`;
  assert.deepEqual(extractUuids(text), [
    'abcdef01-2345-6789-abcd-ef0123456789',
    '00001800-0000-1000-8000-00805f9b34fb',
  ]);
});

test('normalizes MAC addresses', () => {
  assert.equal(normalizeMac('00:A0:50:42:A1:D8'), '00:a0:50:42:a1:d8');
  assert.equal(normalizeMac('00A05042A1D8'), '00:a0:50:42:a1:d8');
  assert.equal(normalizeMac('nope'), '');
});
