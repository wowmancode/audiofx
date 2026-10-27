import { effectMeta } from './dsp/index.js';

const META = effectMeta();
const BY_KIND = Object.fromEntries(META.map((m) => [m.kind, m]));
const GROUP_ORDER = ['Dynamics', 'Distortion', 'Filter & EQ', 'Modulation', 'Delay & reverb', 'Pitch & frequency', 'Stereo & texture', 'Voice'];

const $ = (id) => document.getElementById(id);
const uid = () => 'fx' + Math.random().toString(36).slice(2, 9);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

// ---------------------------------------------------------------- state
const STORE = 'audiofx.state.v1';
const defaults = (kind) => Object.fromEntries(BY_KIND[kind].params.map((d) => [d.key, d.def]));

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && Array.isArray(s.chain)) {
      return {
        master: Number.isFinite(s.master) ? s.master : 0.8,
        inputGain: Number.isFinite(s.inputGain) ? s.inputGain : 0,
        chain: s.chain.filter((c) => BY_KIND[c.kind]).map((c) => ({
          id: c.id || uid(), kind: c.kind, params: { ...defaults(c.kind), ...c.params },
          bypass: !!c.bypass, open: c.open !== false,
        })),
      };
    }
  } catch { /* ignore corrupt or unavailable storage */ }
  return { master: 0.8, inputGain: 0, chain: [] };
}

const state = loadState();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }, 200);
}

// ---------------------------------------------------------------- audio engine
let ctx = null, node = null, micStream = null, micSrc = null, fileSrc = null;
let recDest = null, recorder = null;
const player = $('player');
const post = (m) => { if (node) node.port.postMessage(m); };

function setStatus(t) { $('status').textContent = t; }

const chainPayload = () => state.chain.map((c) => ({ id: c.id, kind: c.kind, params: { ...c.params }, bypass: c.bypass }));

async function ensureEngine() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.AudioWorkletNode) throw new Error('This browser has no AudioWorklet support');
    ctx = new AC({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('worklet.js');
    node = new AudioWorkletNode(ctx, 'fx-chain', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = onNodeMessage;
    node.connect(ctx.destination);
    post({ type: 'init', chain: chainPayload() });
    post({ type: 'master', value: state.master });
    post({ type: 'input', value: Math.pow(10, state.inputGain / 20) });
  }
  if (ctx.state !== 'running') await ctx.resume();
}

function latencyText() {
  const lat = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
  return `${Math.round(ctx.sampleRate / 100) / 10} kHz` + (lat ? `, about ${Math.round(lat * 1000)} ms output latency` : '');
}

function onNodeMessage(e) {
  if (e.data.type !== 'meter') return;
  const db = 20 * Math.log10(Math.max(e.data.peak, 1e-4));
  const bar = $('meterBar');
  bar.style.width = clamp(((db + 60) / 60) * 100, 0, 100) + '%';
  bar.classList.toggle('clip', e.data.clip);
}

function stopSources() {
  if (micSrc) { micSrc.disconnect(); micSrc = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  player.pause();
}

async function useMic() {
  try {
    await ensureEngine();
    stopSources();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    micSrc = ctx.createMediaStreamSource(micStream);
    micSrc.connect(node);
    player.hidden = true;
    setStatus('Live: microphone (' + latencyText() + ')');
  } catch (err) {
    setStatus('Microphone unavailable: ' + (err && err.message ? err.message : err));
  }
}

async function useFile(file) {
  try {
    await ensureEngine();
    stopSources();
    if (!fileSrc) { fileSrc = ctx.createMediaElementSource(player); fileSrc.connect(node); }
    if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
    player.dataset.url = URL.createObjectURL(file);
    player.src = player.dataset.url;
    player.hidden = false;
    setStatus('Playing: ' + file.name + ' (' + latencyText() + ')');
    try { await player.play(); } catch { setStatus('Tap play to start: ' + file.name); }
  } catch (err) {
    setStatus('Could not play file: ' + (err && err.message ? err.message : err));
  }
}

async function stopAll() {
  stopSources();
  if (ctx && ctx.state === 'running') await ctx.suspend();
  $('meterBar').style.width = '0';
  setStatus('Stopped');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function toggleRecord() {
  const btn = $('btnRec'), info = $('recInfo');
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  if (!ctx || !node) { info.textContent = 'Start an input first.'; return; }
  if (!window.MediaRecorder) { info.textContent = 'Recording is not supported in this browser.'; return; }
  if (!recDest) { recDest = ctx.createMediaStreamDestination(); node.connect(recDest); }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  const chunks = [];
  recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    const type = recorder.mimeType || 'audio/webm';
    const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
    const name = `audiofx-${Date.now()}.${ext}`;
    const blob = new Blob(chunks, { type });
    btn.textContent = 'Record output';
    btn.classList.remove('on');
    if (window.AudioFXNative) {
      // Inside the Android app a WebView cannot download blob: links, so the
      // app saves the file for us.
      try {
        const where = window.AudioFXNative.saveFile(name, type.split(';')[0], await blobToBase64(blob));
        info.textContent = where ? `Saved to ${where}` : 'Could not save the recording.';
      } catch {
        info.textContent = 'Could not save the recording.';
      }
      return;
    }
    info.replaceChildren(h('a', { href: URL.createObjectURL(blob), download: name }, 'Download recording'));
  };
  recorder.start();
  btn.textContent = 'Stop recording';
  btn.classList.add('on');
  info.textContent = 'Recording...';
}

// ---------------------------------------------------------------- controls
const decimals = (d) => (d.step >= 1 ? 0 : d.step >= 0.1 ? 1 : d.step >= 0.01 ? 2 : 3);
const fmt = (d, v) => (d.type === 'select' ? d.options[v] : v.toFixed(decimals(d)) + (d.unit || ''));
const toSlider = (d, v) => clamp(d.log ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min), 0, 1);
function fromSlider(d, t) {
  let v = d.log ? d.min * Math.pow(d.max / d.min, t) : d.min + t * (d.max - d.min);
  if (d.int) v = Math.round(v);
  else if (d.step) v = Math.round(v / d.step) * d.step;
  return clamp(+v.toFixed(6), d.min, d.max);
}

function paramRow(item, d) {
  const id = `${item.id}-${d.key}`;
  const out = h('output', { for: id });
  const label = h('label', { for: id, title: 'Double-tap the name to reset' }, d.label, out);
  let control;

  const commit = (v) => {
    item.params[d.key] = v;
    out.textContent = fmt(d, v);
    post({ type: 'set', id: item.id, key: d.key, value: v });
    save();
  };

  if (d.type === 'select') {
    control = h('select', { id }, d.options.map((o, i) => h('option', { value: i }, o)));
    control.value = item.params[d.key];
    control.addEventListener('change', () => commit(Number(control.value)));
  } else {
    control = h('input', { type: 'range', id, min: 0, max: 1000, step: 1 });
    control.value = Math.round(toSlider(d, item.params[d.key]) * 1000);
    control.addEventListener('input', () => {
      const v = fromSlider(d, control.value / 1000);
      commit(v);
      if (d.int) control.value = Math.round(toSlider(d, v) * 1000);
    });
  }
  label.addEventListener('dblclick', () => {
    control.value = d.type === 'select' ? d.def : Math.round(toSlider(d, d.def) * 1000);
    commit(d.def);
  });
  out.textContent = fmt(d, item.params[d.key]);
  return h('div', { class: 'param' }, label, control);
}

// On-screen keyboard that picks the vocoder's carrier notes.
function keyboard(item) {
  let base = 48;
  let latch = false;
  const held = new Set();
  const keys = new Map();
  const pointers = new Map();
  const kbd = h('div', { class: 'kbd', role: 'group', 'aria-label': 'Carrier note keyboard' });
  const octLabel = h('span');
  const send = () => post({ type: 'notes', id: item.id, notes: [...held].sort((a, b) => a - b) });
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function build() {
    kbd.replaceChildren(); keys.clear(); held.clear(); pointers.clear(); send();
    const whites = [0, 2, 4, 5, 7, 9, 11];
    const blacks = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 };
    for (let i = 0; i < 14; i++) {
      const midi = base + Math.floor(i / 7) * 12 + whites[i % 7];
      const el = h('div', { class: 'key', 'data-midi': midi });
      kbd.append(el); keys.set(midi, el);
    }
    for (let i = 0; i < 13; i++) {
      const off = blacks[i % 7];
      if (off === undefined) continue;
      const midi = base + Math.floor(i / 7) * 12 + off;
      const el = h('div', { class: 'key black', 'data-midi': midi });
      el.style.left = `calc(${((i + 1) / 14) * 100}% - 2.6%)`;
      kbd.append(el); keys.set(midi, el);
    }
    octLabel.textContent = `${names[base % 12]}${Math.floor(base / 12) - 1} to ${names[base % 12]}${Math.floor(base / 12) + 1}`;
  }

  kbd.addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.key');
    if (!k) return;
    e.preventDefault();
    const m = Number(k.dataset.midi);
    if (latch && held.has(m)) { held.delete(m); k.classList.remove('down'); }
    else { held.add(m); k.classList.add('down'); }
    pointers.set(e.pointerId, m);
    if (k.setPointerCapture) k.setPointerCapture(e.pointerId);
    send();
  });
  const release = (e) => {
    const m = pointers.get(e.pointerId);
    if (m === undefined) return;
    pointers.delete(e.pointerId);
    if (!latch) { held.delete(m); const k = keys.get(m); if (k) k.classList.remove('down'); send(); }
  };
  kbd.addEventListener('pointerup', release);
  kbd.addEventListener('pointercancel', release);

  const latchBox = h('input', { type: 'checkbox', id: item.id + '-latch' });
  latchBox.addEventListener('change', () => {
    latch = latchBox.checked;
    if (!latch) { held.clear(); keys.forEach((k) => k.classList.remove('down')); send(); }
  });
  const shift = (d) => () => { base = clamp(base + d, 24, 84); build(); };

  build();
  return h('div', { class: 'kbd-wrap' },
    h('div', { class: 'kbd-bar' },
      h('button', { onclick: shift(-12), 'aria-label': 'Octave down' }, 'Oct -'),
      octLabel,
      h('button', { onclick: shift(12), 'aria-label': 'Octave up' }, 'Oct +'),
      h('label', { for: item.id + '-latch' }, latchBox, 'Latch notes')),
    kbd,
    h('p', { class: 'note' }, 'Hold keys while you speak. With no keys held, the Carrier pitch slider plays.'));
}

// ---------------------------------------------------------------- chain UI
const chainEl = $('chain'), emptyEl = $('empty');

function move(id, dir) {
  const i = state.chain.findIndex((c) => c.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= state.chain.length) return;
  [state.chain[i], state.chain[j]] = [state.chain[j], state.chain[i]];
  post({ type: 'order', ids: state.chain.map((c) => c.id) });
  save(); renderChain();
}

function removeItem(id) {
  state.chain = state.chain.filter((c) => c.id !== id);
  post({ type: 'remove', id });
  save(); renderChain();
}

function resetItem(item) {
  item.params = defaults(item.kind);
  for (const [key, value] of Object.entries(item.params)) post({ type: 'set', id: item.id, key, value });
  save(); renderChain();
}

function cardFor(item, index) {
  const meta = BY_KIND[item.kind];
  const body = h('div', { class: 'card-body' },
    h('p', { class: 'desc' }, meta.desc),
    meta.params.map((d) => paramRow(item, d)));
  if (item.kind === 'vocoder') body.append(keyboard(item));
  body.append(h('div', { class: 'card-foot' }, h('button', { onclick: () => resetItem(item) }, 'Reset controls')));
  body.hidden = !item.open;

  const card = h('article', { class: 'card' + (item.bypass ? ' bypassed' : '') });
  const title = h('button', { class: 'card-title', 'aria-expanded': String(item.open) },
    `${index + 1}. ${meta.label}`, h('small', {}, meta.group));
  title.addEventListener('click', () => {
    item.open = !item.open; body.hidden = !item.open;
    title.setAttribute('aria-expanded', String(item.open)); save();
  });
  const sw = h('button', { class: 'switch', 'aria-pressed': String(!item.bypass), title: 'Turn this effect on or off' }, item.bypass ? 'Off' : 'On');
  sw.addEventListener('click', () => {
    item.bypass = !item.bypass;
    sw.setAttribute('aria-pressed', String(!item.bypass));
    sw.textContent = item.bypass ? 'Off' : 'On';
    card.classList.toggle('bypassed', item.bypass);
    post({ type: 'bypass', id: item.id, value: item.bypass }); save();
  });
  card.append(
    h('div', { class: 'card-head' }, title, sw,
      h('button', { class: 'icon', 'aria-label': 'Move up', onclick: () => move(item.id, -1) }, '↑'),
      h('button', { class: 'icon', 'aria-label': 'Move down', onclick: () => move(item.id, 1) }, '↓'),
      h('button', { class: 'icon', 'aria-label': 'Remove effect', onclick: () => removeItem(item.id) }, '✕')),
    body);
  return card;
}

function renderChain() {
  chainEl.replaceChildren(...state.chain.map(cardFor));
  emptyEl.hidden = state.chain.length > 0;
}

function addEffect(kind) {
  const item = { id: uid(), kind, params: defaults(kind), bypass: false, open: true };
  state.chain.push(item);
  post({ type: 'add', item: { id: item.id, kind, params: { ...item.params }, bypass: false } });
  save(); renderChain();
  const last = chainEl.lastElementChild;
  if (last) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------------------------------------------------------------- picker
const picker = $('picker'), pickerList = $('pickerList');
function buildPicker() {
  const groups = GROUP_ORDER.concat([...new Set(META.map((m) => m.group))].filter((g) => !GROUP_ORDER.includes(g)));
  for (const g of groups) {
    const items = META.filter((m) => m.group === g);
    if (!items.length) continue;
    pickerList.append(h('div', { class: 'group-title', 'data-group': g }, g));
    for (const m of items) {
      const b = h('button', { class: 'pick', 'data-group': g, 'data-text': `${m.label} ${m.desc} ${g}`.toLowerCase() },
        h('span', {}, m.label), h('small', {}, m.desc));
      b.addEventListener('click', () => { picker.close(); addEffect(m.kind); });
      pickerList.append(b);
    }
  }
}
$('search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const shown = new Set();
  pickerList.querySelectorAll('.pick').forEach((b) => {
    const ok = !q || b.dataset.text.includes(q);
    b.hidden = !ok;
    if (ok) shown.add(b.dataset.group);
  });
  pickerList.querySelectorAll('.group-title').forEach((t) => { t.hidden = !shown.has(t.dataset.group); });
});

// ---------------------------------------------------------------- wiring
$('btnAdd').addEventListener('click', () => { $('search').value = ''; $('search').dispatchEvent(new Event('input')); picker.showModal(); });
$('btnClear').addEventListener('click', () => {
  if (!state.chain.length || !confirm('Remove every effect from the chain?')) return;
  state.chain = []; post({ type: 'init', chain: [] }); save(); renderChain();
});
$('btnMic').addEventListener('click', useMic);
$('btnStop').addEventListener('click', stopAll);
$('btnRec').addEventListener('click', toggleRecord);
// Create the audio context during the tap itself so autoplay rules allow it.
document.querySelector('label[for="file"]').addEventListener('click', () => { ensureEngine().catch(() => {}); });
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) useFile(f); e.target.value = ''; });

const inGain = $('inGain'), master = $('master');
inGain.value = state.inputGain; $('inGainOut').textContent = `${state.inputGain} dB`;
master.value = state.master; $('masterOut').textContent = `${Math.round(state.master * 100)}%`;
inGain.addEventListener('input', () => {
  state.inputGain = Number(inGain.value);
  $('inGainOut').textContent = `${state.inputGain} dB`;
  post({ type: 'input', value: Math.pow(10, state.inputGain / 20) }); save();
});
master.addEventListener('input', () => {
  state.master = Number(master.value);
  $('masterOut').textContent = `${Math.round(state.master * 100)}%`;
  post({ type: 'master', value: state.master }); save();
});

buildPicker();
renderChain();
