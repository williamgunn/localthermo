import {
  NAME_PREFIX, UPDATES_UUID, KNOWN_CHARACTERISTICS,
  decodeFrame, encodeFrame, convert, toHex, extractUuids, normalizeMac,
} from './bluedot.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const SETTINGS_KEY = 'localthermo.settings';
const SESSION_KEY = 'localthermo.session';
const MAX_ROWS = 50000;

// ---------------------------------------------------------------- state

const settings = Object.assign({
  services: [],
  mac: '00:a0:50:42:a1:d8',
  allDevices: false,
  unit: 'auto',
  interval: 5,
  highOn: false, highVal: 165,
  lowOn: false, lowVal: 40,
  alertUnit: 'F',
  soundOn: true,
}, load(SETTINGS_KEY) || {});

/** Logged readings: { t: epoch ms, v: degrees in unit u (null = no probe / gap), u: 'F' | 'C' } */
let rows = [];
let latest = null;        // last decoded frame
let lastFrameAt = 0;
let lastLoggedAt = 0;
let rangeMin = 0;         // chart window in minutes, 0 = all
let demo = false;
let mode = 'standalone';  // 'hub' (this computer relays readings) or 'viewer' (another device watching)
let device = null;
let wantConnected = false;
let retryTimer = null;
let wakeLock = null;
const tripped = { high: false, low: false };
const diag = { services: null, frames: [], notes: [] };

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
const saveSettings = () => save(SETTINGS_KEY, settings);
function saveSession() {
  if (!demo && mode !== 'viewer') save(SESSION_KEY, rows.slice(-20000).map((r) => [r.t, r.v, r.u]));
}

// ---------------------------------------------------------------- units and formatting

function displayUnit() {
  if (settings.unit !== 'auto') return settings.unit;
  return latest?.unit || rows.at(-1)?.u || 'F';
}
const shown = (r) => convert(r.v, r.u, displayUnit());
const fmtDeg = (v, digits = 0) => (v == null ? '--' : `${v.toFixed(digits)}°${displayUnit()}`);
const fmtClock = (t, seconds) => new Date(t).toLocaleTimeString([], {
  hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
});
function fmtSpan(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---------------------------------------------------------------- incoming data

function handleFrame(view, t = Date.now()) {
  diag.frames.push(`${new Date(t).toISOString()}  ${toHex(view)}`);
  if (diag.frames.length > 12) diag.frames.shift();

  const frame = decodeFrame(view);
  if (!frame) {
    showNotice(`The thermometer sent ${view.byteLength} bytes where 20 were expected, so it could not be decoded. See Diagnostics below.`);
    renderDiag();
    return;
  }
  latest = frame;
  lastFrameAt = t;

  const expected = normalizeMac(settings.mac);
  if (expected && frame.mac !== expected && !demo) {
    showNotice(`Connected to a BlueDOT with address ${frame.mac}, not the expected ${expected}. If that is the wrong thermometer, disconnect and pick the other one.`);
  }

  if (t - lastLoggedAt >= settings.interval * 1000 - 200) {
    lastLoggedAt = t;
    addRow({ t, v: frame.temp, u: frame.unit });
  }
  checkAlerts(frame);
  scheduleRender();
  pushToHub();
}

function addRow(row) {
  rows.push(row);
  if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
  if (fileHandle) filePending.push(csvLine(row));
}

function markGap() {
  if (rows.length && rows.at(-1).v != null) addRow({ t: Date.now(), v: null, u: rows.at(-1).u });
}

// ---------------------------------------------------------------- Bluetooth

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('statusText').textContent = text;
  $('connectBtn').textContent = wantConnected ? 'Disconnect' : 'Connect';
  pushToHub(true);
}

function showNotice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

async function connect() {
  if (!navigator.bluetooth) {
    showNotice('This browser cannot use Bluetooth from a web page. Use Chrome or Edge on Windows, macOS, Linux, ChromeOS or Android, and open the page from http://localhost or an https address.');
    return;
  }
  showNotice('');
  primeAudio();
  const options = settings.allDevices ? { acceptAllDevices: true } : { filters: [{ namePrefix: NAME_PREFIX }] };
  options.optionalServices = settings.services;
  setStatus('busy', 'Choose the BlueDOT in the browser prompt');
  try {
    device = await navigator.bluetooth.requestDevice(options);
  } catch (err) {
    setStatus('idle', 'Not connected');
    if (err.name !== 'NotFoundError') showNotice(`Could not open the Bluetooth chooser: ${err.message}`);
    return;
  }
  device.addEventListener('gattserverdisconnected', onDisconnected);
  wantConnected = true;
  await openGatt().catch(onConnectError);
}

async function openGatt() {
  setStatus('busy', 'Connecting');
  const server = await device.gatt.connect();

  let services = [];
  try { services = await server.getPrimaryServices(); } catch { /* none of the allowed services exist */ }
  diag.services = [];
  let updates = null;
  for (const service of services) {
    let chars = [];
    try { chars = await service.getCharacteristics(); } catch { /* empty or blocked service */ }
    diag.services.push({
      uuid: service.uuid,
      chars: chars.map((c) => ({
        uuid: c.uuid,
        props: Object.keys(Object.getPrototypeOf(c.properties)).filter((p) => c.properties[p] === true),
      })),
    });
    updates ||= chars.find((c) => c.uuid === UPDATES_UUID);
  }
  renderDiag();

  if (!updates) {
    wantConnected = false;
    device.gatt.disconnect();
    setStatus('error', 'Setup needed');
    showNotice(settings.services.length
      ? 'Connected, but none of the saved service UUIDs contains the BlueDOT temperature characteristic. Check the list under "Bluetooth setup and diagnostics".'
      : 'Connected, but the page is not allowed to read the temperature yet. Add the BlueDOT service UUID under "Bluetooth setup and diagnostics" (a one-time step), then connect again.');
    $('setup').open = true;
    $('setup').scrollIntoView({ behavior: 'smooth' });
    return;
  }

  updates.addEventListener('characteristicvaluechanged', (e) => handleFrame(e.target.value));
  await updates.startNotifications();
  if (updates.properties.read) updates.readValue().catch(() => {}); // prompt first value; arrives via the event
  setStatus('live', `Connected to ${device.name || 'BlueDOT'}`);
  requestWakeLock();
}

function onConnectError(err) {
  diag.notes.push(`${new Date().toISOString()}  ${err.name}: ${err.message}`);
  renderDiag();
  if (wantConnected) scheduleRetry();
  else setStatus('error', 'Connection failed');
}

function onDisconnected() {
  markGap();
  scheduleRender();
  if (wantConnected) scheduleRetry();
  else setStatus('idle', 'Not connected');
}

function scheduleRetry(delay = 2000) {
  clearTimeout(retryTimer);
  setStatus('busy', 'Connection lost, reconnecting');
  retryTimer = setTimeout(() => {
    if (!wantConnected) return;
    openGatt().catch(() => scheduleRetry(Math.min(delay * 2, 30000)));
  }, delay);
}

function disconnect() {
  wantConnected = false;
  clearTimeout(retryTimer);
  if (device?.gatt.connected) device.gatt.disconnect();
  else setStatus('idle', 'Not connected');
  wakeLock?.release().catch(() => {});
  saveSession();
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not allowed right now */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantConnected) requestWakeLock();
});

// Redraw periodically so a silent thermometer (out of range, flat batteries) gets flagged.
setInterval(() => { if (latest) scheduleRender(); }, 5000);

// ---------------------------------------------------------------- hub relay
// With server.py running, the page on the hub computer pushes readings to it and
// other devices poll them. Pushes ride on incoming Bluetooth frames, so they keep
// flowing even when the browser slows this tab's timers in the background.

let hubSent = 0;        // rows the server already has
let hubReset = true;    // start the server's session over on the next push
let hubBusy = false;
let hubPushedAt = 0;

async function pushToHub(force) {
  if (mode !== 'hub' || hubBusy) return;
  if (!force && Date.now() - hubPushedAt < 2000) return;
  hubBusy = true;
  hubPushedAt = Date.now();
  const reset = hubReset;
  const from = reset ? 0 : hubSent;
  const batch = rows.slice(from, from + 5000);
  try {
    const res = await fetch('api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reset, from, demo, latest, lastFrameAt,
        rows: batch.map((r) => [r.t, r.v, r.u]),
        status: { state: $('status').dataset.state, text: $('statusText').textContent },
      }),
    });
    const out = await res.json();
    if (out.resync || !res.ok) hubReset = true;
    else if (rows[from] === batch[0]) { hubReset = false; hubSent = from + batch.length; }
    else hubReset = true; // the session changed while this request was in flight
  } catch { /* server stopped; keep trying */ }
  hubBusy = false;
}

let viewSession = '';

async function pollHub() {
  try {
    const res = await fetch(`api/state?session=${viewSession}&since=${rows.at(-1)?.t || 0}`, { cache: 'no-store' });
    const s = await res.json();
    if (String(s.session) !== viewSession) {
      viewSession = String(s.session);
      rows = [];
      tripped.high = tripped.low = false;
    }
    for (const [t, v, u] of s.rows) rows.push({ t, v, u });
    latest = s.latest;
    lastFrameAt = s.age == null ? 0 : Date.now() - s.age;
    if (s.hubAge == null || s.hubAge > 15000) {
      setStatus('error', 'Hub page is not reporting. Open it in Chrome on the hub computer.');
    } else {
      setStatus(s.status.state, s.status.text);
      if (latest && s.age < 30000) checkAlerts(latest);
    }
  } catch {
    setStatus('error', 'Cannot reach the hub computer');
  }
  scheduleRender();
}

// ---------------------------------------------------------------- alerts

let audio = null;
let beepTimer = null;

function primeAudio() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* no audio */ }
}

function beep() {
  if (!audio || !settings.soundOn) return;
  for (let i = 0; i < 3; i++) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.25;
    osc.connect(gain).connect(audio.destination);
    const at = audio.currentTime + i * 0.3;
    osc.start(at);
    osc.stop(at + 0.18);
  }
}

function raiseAlert(text) {
  $('bannerText').textContent = text;
  $('banner').hidden = false;
  clearInterval(beepTimer);
  beep();
  beepTimer = setInterval(beep, 2500);
  if (window.Notification?.permission === 'granted') {
    try { new Notification('LocalThermo', { body: text, tag: 'localthermo-alert' }); } catch { /* needs a service worker on Android */ }
  }
}

function silence() {
  clearInterval(beepTimer);
  $('banner').hidden = true;
}

function checkAlerts(frame) {
  if (frame.temp == null) return;
  const unit = displayUnit();
  const now = convert(frame.temp, frame.unit, unit);
  // Re-arm only after the temperature has moved a degree back past the limit.
  if (settings.highOn && Number.isFinite(settings.highVal)) {
    if (!tripped.high && now >= settings.highVal) {
      tripped.high = true;
      raiseAlert(`Probe is at ${now.toFixed(0)}°${unit}, at or above your ${settings.highVal}°${unit} alert.`);
    } else if (now < settings.highVal - 1) tripped.high = false;
  }
  if (settings.lowOn && Number.isFinite(settings.lowVal)) {
    if (!tripped.low && now <= settings.lowVal) {
      tripped.low = true;
      raiseAlert(`Probe is at ${now.toFixed(0)}°${unit}, at or below your ${settings.lowVal}°${unit} alert.`);
    } else if (now > settings.lowVal + 1) tripped.low = false;
  }
}

// ---------------------------------------------------------------- CSV and file logging

const CSV_HEADER = 'time,temp_f,temp_c,probe_connected\n';
function csvLine(r) {
  const f = convert(r.v, r.u, 'F');
  const c = convert(r.v, r.u, 'C');
  return `${new Date(r.t).toISOString()},${f == null ? '' : f.toFixed(1)},${c == null ? '' : c.toFixed(1)},${r.v == null ? 0 : 1}\n`;
}

function downloadCsv() {
  const blob = new Blob([CSV_HEADER, ...rows.map(csvLine)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bluedot-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let fileHandle = null;
let filePending = [];
let fileBusy = false;

async function pickLogFile() {
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName: `bluedot-${new Date().toISOString().slice(0, 10)}.csv`,
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
    });
  } catch { return; } // cancelled
  const writable = await fileHandle.createWritable();
  await writable.write(CSV_HEADER + rows.map(csvLine).join(''));
  await writable.close();
  filePending = [];
  renderLogNote();
}

async function flushFile() {
  if (!fileHandle || fileBusy || !filePending.length) return;
  fileBusy = true;
  const chunk = filePending.join('');
  const count = filePending.length;
  try {
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    await writable.seek((await fileHandle.getFile()).size);
    await writable.write(chunk);
    await writable.close();
    filePending.splice(0, count);
  } catch (err) {
    showNotice(`Could not write to ${fileHandle.name}: ${err.message}. Readings are still kept in the page; use Download CSV.`);
    fileHandle = null;
  }
  fileBusy = false;
  renderLogNote();
}
setInterval(flushFile, 15000);
setInterval(saveSession, 30000);
addEventListener('pagehide', () => { saveSession(); flushFile(); });
addEventListener('pointerdown', primeAudio, { once: true }); // phones only allow sound after a tap

function renderLogNote() {
  const where = fileHandle ? `Appending to ${fileHandle.name} every 15 seconds. ` : '';
  const kept = demo ? ' (demo, not saved)'
    : mode === 'viewer' ? ', relayed from the hub'
    : mode === 'hub' ? ', also saved as CSV in the logs folder next to server.py'
    : ', kept in this browser until you start a new session';
  $('logNote').textContent = `${where}${rows.length} readings in this session${kept}.`;
}

// ---------------------------------------------------------------- rendering

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const unit = displayUnit();

  // Keep alert thresholds meaningful if the display unit changes.
  if (settings.alertUnit !== unit) {
    settings.highVal = Math.round(convert(settings.highVal, settings.alertUnit, unit));
    settings.lowVal = Math.round(convert(settings.lowVal, settings.alertUnit, unit));
    settings.alertUnit = unit;
    $('highVal').value = settings.highVal;
    $('lowVal').value = settings.lowVal;
    saveSettings();
  }
  document.querySelectorAll('.u').forEach((el) => { el.textContent = `°${unit}`; });
  $('thTemp').textContent = `Temperature (°${unit})`;

  // Hero
  if (latest) {
    const now = convert(latest.temp, latest.unit, unit);
    $('temp').textContent = now == null ? '--' : now.toFixed(0);
    $('tempUnit').textContent = now == null ? '' : `°${unit}`;
    const quiet = Date.now() - lastFrameAt;
    $('tempNote').textContent = quiet > 20000 ? `No update for ${fmtSpan(quiet)}; last reading shown`
      : latest.probeConnected ? `Updated ${fmtClock(lastFrameAt, true)}`
      : 'No probe detected. Check that the probe is plugged in.';
    const dev = convert(latest.alarmTemp, latest.unit, unit);
    $('devAlarm').textContent = fmtDeg(dev);
    $('devAlarmNote').textContent = latest.alarmActive ? 'Sounding now'
      : latest.alarmDisabled ? 'Alarm switched off on the device'
      : latest.alarmSilenced ? 'Silenced on the device' : 'Alarm is armed on the device';
  }

  // Session stats
  const good = rows.filter((r) => r.v != null);
  if (good.length) {
    const vals = good.map(shown);
    $('minmax').textContent = `${Math.min(...vals).toFixed(0)}° / ${Math.max(...vals).toFixed(0)}°`;
    $('elapsed').textContent = `Since ${fmtClock(rows[0].t)} (${fmtSpan(rows.at(-1).t - rows[0].t)})`;
  } else {
    $('minmax').textContent = '--';
    $('elapsed').textContent = 'No readings yet';
  }

  // Rate over the last five minutes, and a rough time to the high alert.
  const last = good.at(-1);
  const recent = last ? good.filter((r) => r.t >= last.t - 5 * 60000) : [];
  $('eta').textContent = 'over the last 5 minutes';
  if (recent.length > 1 && last.t - recent[0].t >= 30000) {
    const perMin = (shown(last) - shown(recent[0])) / ((last.t - recent[0].t) / 60000);
    $('rate').textContent = `${perMin >= 0 ? '+' : '−'}${Math.abs(perMin).toFixed(1)}°/min`;
    const toGo = settings.highVal - shown(last);
    if (settings.highOn && perMin > 0.05 && toGo > 0) {
      $('eta').textContent = `about ${fmtSpan((toGo / perMin) * 60000)} to ${settings.highVal}° at this rate`;
    }
  } else {
    $('rate').textContent = '--';
  }

  renderChart();
  renderTable();
  renderLogNote();
}

function niceStep(span, target) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
}

let chartGeom = null;

function renderChart() {
  const svg = $('chart');
  const W = svg.clientWidth;
  const H = svg.clientHeight;
  svg.replaceChildren();
  chartGeom = null;
  $('tip').hidden = true;

  const end = rows.length ? rows.at(-1).t : 0;
  const view = rangeMin ? rows.filter((r) => r.t >= end - rangeMin * 60000) : rows;
  const pts = view.filter((r) => r.v != null);
  $('chartEmpty').hidden = pts.length > 0;
  if (!pts.length || !W) return;

  const m = { l: 44, r: 14, t: 14, b: 26 };
  const limits = [];
  if (settings.highOn && Number.isFinite(settings.highVal)) limits.push({ v: settings.highVal, label: `High alert ${settings.highVal}°` });
  if (settings.lowOn && Number.isFinite(settings.lowVal)) limits.push({ v: settings.lowVal, label: `Low alert ${settings.lowVal}°` });

  const vals = pts.map(shown).concat(limits.map((l) => l.v));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.08, 2);
  lo -= pad; hi += pad;
  const t0 = view[0].t;
  const t1 = Math.max(view.at(-1).t, t0 + 60000);
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const el = (name, attrs, text) => {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    svg.append(node);
    return node;
  };

  // Horizontal grid and y labels
  const yStep = niceStep(hi - lo, 5);
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
    el('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) });
    el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, `${v}°`);
  }

  // Time labels
  const spanMin = (t1 - t0) / 60000;
  const maxTicks = Math.max(2, Math.floor((W - m.l - m.r) / 70));
  const xStep = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480].find((s) => spanMin / s <= maxTicks) || 720;
  const first = new Date(t0);
  first.setSeconds(0, 0);
  first.setMinutes(Math.ceil((first.getMinutes() + (t0 > first.getTime() ? 1 : 0)) / xStep) * xStep);
  for (let t = first.getTime(); t <= t1; t += xStep * 60000) {
    el('text', { x: x(t), y: H - 8, 'text-anchor': 'middle' }, fmtClock(t));
  }

  // Alert thresholds, labelled directly
  for (const limit of limits) {
    el('line', { class: 'limit', x1: m.l, x2: W - m.r, y1: y(limit.v), y2: y(limit.v) });
    el('text', { class: 'limit-label', x: W - m.r - 4, y: y(limit.v) - 5, 'text-anchor': 'end' }, limit.label);
  }

  // The series; breaks where the probe was out or the link dropped. Thin out very long sessions.
  const stride = Math.ceil(view.length / 1500);
  let d = '';
  let pen = false;
  view.forEach((r, i) => {
    if (r.v == null) { pen = false; return; }
    if (i % stride && i !== view.length - 1 && view[i - 1]?.v != null && view[i + 1]?.v != null) return;
    d += `${pen ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(shown(r)).toFixed(1)}`;
    pen = true;
  });
  el('path', { class: 'line', d });
  const tail = pts.at(-1);
  el('circle', { class: 'pt', cx: x(tail.t), cy: y(shown(tail)), r: 4 });

  const cross = el('line', { class: 'cross', y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const dot = el('circle', { class: 'pt', r: 5, visibility: 'hidden' });
  chartGeom = { pts, x, y, cross, dot, W };
  if (hoverX != null) showTip(); // keep the readout up while live data redraws the chart
}

let hoverX = null;

function hideTip() {
  hoverX = null;
  $('tip').hidden = true;
  chartGeom?.cross.setAttribute('visibility', 'hidden');
  chartGeom?.dot.setAttribute('visibility', 'hidden');
}

function onChartPointer(e) {
  hoverX = e.clientX - $('chart').getBoundingClientRect().left;
  showTip();
}

function showTip() {
  if (!chartGeom) return;
  const { pts, x, y, cross, dot, W } = chartGeom;
  const px = hoverX;
  let best = pts[0];
  for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
  const bx = x(best.t);
  cross.setAttribute('x1', bx); cross.setAttribute('x2', bx); cross.setAttribute('visibility', 'visible');
  dot.setAttribute('cx', bx); dot.setAttribute('cy', y(shown(best))); dot.setAttribute('visibility', 'visible');
  const tip = $('tip');
  tip.replaceChildren();
  const value = document.createElement('b');
  value.textContent = fmtDeg(shown(best), best.u === displayUnit() ? 0 : 1);
  const when = document.createElement('span');
  when.textContent = fmtClock(best.t, true);
  tip.append(value, when);
  tip.hidden = false;
  const left = bx + 12 + tip.offsetWidth > W ? bx - 12 - tip.offsetWidth : bx + 12;
  tip.style.left = `${Math.max(0, left)}px`;
}

let tableStamp = '';
function renderTable() {
  if (!document.querySelector('.table-view').open) return;
  const stamp = `${rows.length}/${rows.at(-1)?.t}/${displayUnit()}`;
  if (stamp === tableStamp) return;
  tableStamp = stamp;
  const exact = (r) => (r.u === displayUnit() ? 0 : 1);
  $('rows').replaceChildren(...rows.slice(-100).reverse().map((r) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    const b = document.createElement('td');
    a.textContent = new Date(r.t).toLocaleString();
    b.textContent = r.v == null ? 'no reading' : shown(r).toFixed(exact(r));
    tr.append(a, b);
    return tr;
  }));
}

function renderDiag() {
  const lines = [`Browser: ${navigator.userAgent}`, `Saved service UUIDs: ${settings.services.join(', ') || 'none'}`, ''];
  if (diag.services) {
    lines.push(`Services visible to this page: ${diag.services.length || 'none'}`);
    for (const s of diag.services) {
      lines.push(`  service ${s.uuid}`);
      for (const c of s.chars) {
        lines.push(`    characteristic ${c.uuid} [${c.props.join(', ')}]${KNOWN_CHARACTERISTICS[c.uuid] ? `  <- ${KNOWN_CHARACTERISTICS[c.uuid]}` : ''}`);
      }
    }
  } else lines.push('No connection attempted yet.');
  if (diag.notes.length) lines.push('', 'Errors:', ...diag.notes.slice(-5).map((n) => `  ${n}`));
  if (diag.frames.length) lines.push('', 'Latest raw frames:', ...diag.frames.map((f) => `  ${f}`));
  if (latest) lines.push('', `Decoded: ${JSON.stringify(latest)}`);
  $('diag').textContent = lines.join('\n');
}
setInterval(() => { if ($('setup').open) renderDiag(); }, 2000);

// ---------------------------------------------------------------- demo mode

function startDemo() {
  demo = true;
  showNotice('');
  rows = [];
  hubReset = true;
  latest = null;
  $('demoBtn').textContent = 'Exit demo';
  $('connectBtn').disabled = true;
  setStatus('live', 'Demo: simulated readings');
  const start = Date.now() - 40 * 60000;
  const tempAt = (t) => 68 + 140 * (1 - Math.exp(-(t - start) / (28 * 60000))) + Math.sin(t / 47000) * 0.6;
  const frameAt = (t) => encodeFrame({ temp: tempAt(t), alarmTemp: 203, unit: 'F', mac: settings.mac });
  for (let t = start; t < Date.now(); t += settings.interval * 1000) {
    lastLoggedAt = 0;
    handleFrame(frameAt(t), t);
  }
  setInterval(() => handleFrame(frameAt(Date.now())), 1000);
}

// ---------------------------------------------------------------- wiring

function bindSetting(id, key, parse = (el) => el.value) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = settings[key]; else el.value = settings[key];
  el.addEventListener('change', () => {
    settings[key] = el.type === 'checkbox' ? el.checked : parse(el);
    tripped.high = tripped.low = false;
    saveSettings();
    scheduleRender();
  });
}
const num = (el) => (el.value === '' ? NaN : Number(el.value));
bindSetting('highOn', 'highOn');
bindSetting('highVal', 'highVal', num);
bindSetting('lowOn', 'lowOn');
bindSetting('lowVal', 'lowVal', num);
bindSetting('soundOn', 'soundOn');
bindSetting('unitSel', 'unit');
bindSetting('intervalSel', 'interval', num);
bindSetting('allDevices', 'allDevices');

$('connectBtn').addEventListener('click', () => (wantConnected ? disconnect() : connect()));
$('demoBtn').addEventListener('click', () => {
  if (demo) { location.href = location.pathname; return; }
  primeAudio();
  startDemo();
});
$('ackBtn').addEventListener('click', silence);
$('csvBtn').addEventListener('click', downloadCsv);
$('fileBtn').hidden = !window.showSaveFilePicker;
$('fileBtn').addEventListener('click', pickLogFile);
$('clearBtn').addEventListener('click', () => {
  if (rows.length && !confirm('Start a new session? This clears the readings shown here. Download the CSV first if you want to keep them.')) return;
  rows = [];
  hubReset = true;
  lastLoggedAt = 0;
  fileHandle = null;
  filePending = [];
  saveSession();
  scheduleRender();
});
$('notifyBtn').addEventListener('click', async () => {
  if (!window.Notification) { showNotice('This browser does not support notifications.'); return; }
  const result = await Notification.requestPermission();
  $('notifyBtn').textContent = result === 'granted' ? 'Desktop notifications on' : 'Notifications blocked in browser settings';
});
if (window.Notification?.permission === 'granted') $('notifyBtn').textContent = 'Desktop notifications on';
$('testAlertBtn').addEventListener('click', () => { primeAudio(); raiseAlert('Test alert. This is how a temperature alert looks and sounds.'); });

$('svcText').value = settings.services.join('\n');
$('macVal').value = settings.mac;
$('macHint').textContent = settings.mac ? ` (address ${settings.mac.toUpperCase()})` : '';
$('saveSetupBtn').addEventListener('click', () => {
  settings.services = extractUuids($('svcText').value);
  settings.mac = normalizeMac($('macVal').value);
  $('svcText').value = settings.services.join('\n');
  $('macVal').value = settings.mac;
  saveSettings();
  renderDiag();
  $('setupSaved').textContent = settings.services.length
    ? `Saved ${settings.services.length} UUID${settings.services.length > 1 ? 's' : ''}. Press Connect to use ${settings.services.length > 1 ? 'them' : 'it'}.`
    : 'Saved, but no UUID was found in that text.';
});
$('copyDiagBtn').addEventListener('click', async () => {
  renderDiag();
  await navigator.clipboard.writeText($('diag').textContent).catch(() => {});
  $('copyDiagBtn').textContent = 'Copied';
});

document.querySelectorAll('.seg button').forEach((btn) => btn.addEventListener('click', () => {
  rangeMin = Number(btn.dataset.range);
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b === btn));
  scheduleRender();
}));
$('chart').addEventListener('pointermove', onChartPointer);
$('chart').addEventListener('pointerdown', onChartPointer);
$('chart').addEventListener('pointerleave', hideTip);
document.querySelector('.table-view').addEventListener('toggle', renderTable);
new ResizeObserver(scheduleRender).observe($('chartWrap'));

async function init() {
  // Is server.py behind this page? If so, are we the hub computer or a device looking in?
  let hub = null;
  try {
    const res = await fetch('api/state?since=9e15', { cache: 'no-store' });
    if (res.ok) hub = await res.json();
  } catch { /* plain static hosting: no relay */ }
  const params = new URLSearchParams(location.search);
  if (hub) mode = hub.local && !params.has('view') ? 'hub' : 'viewer';

  if (mode === 'viewer') {
    document.body.classList.add('viewer');
    $('hubInfo').textContent = 'Showing readings relayed from the hub computer. Alerts set here sound on this device only, and only while this page is open on screen.';
    $('hubInfo').hidden = false;
    render();
    pollHub();
    setInterval(pollHub, 2000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollHub(); });
    return;
  }

  // Restore the previous session so a reload mid-cook keeps the chart.
  rows = (load(SESSION_KEY) || []).map(([t, v, u]) => ({ t, v, u }));
  if (rows.length) markGap();

  if (mode === 'hub') {
    $('hubInfo').textContent = hub.lan
      ? `Hub mode: on your phone or another device on this network, open http://${hub.lan}:${hub.port}`
      : 'Hub mode: other devices on this network can open this computer\'s address to watch.';
    $('hubInfo').hidden = false;
    setInterval(pushToHub, 3000); // heartbeat, so viewers can tell the hub page is open
  }
  if (!navigator.bluetooth) {
    showNotice('This browser cannot use Bluetooth from a web page. Use Chrome or Edge on Windows, macOS, Linux, ChromeOS or Android. You can still press Demo to look around.');
  } else if (!settings.services.length) {
    showNotice('One-time setup: the page needs the BlueDOT service UUID before it can read temperatures. Open "Bluetooth setup and diagnostics" at the bottom of the page.');
  }
  renderDiag();
  render();
  if (params.has('demo')) startDemo();
}
init();
