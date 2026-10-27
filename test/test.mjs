// Offline checks for every effect: output must be finite, bounded, audible,
// survive extreme/random parameters, and run comfortably faster than real time.
import { createEffect, effectMeta } from '../web/dsp/index.js';

const BLOCK = 128;
const meta = effectMeta();
let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL ' + msg); };

// Voice-like test signal: harmonic source with three formant bumps,
// syllable envelope and a few noise bursts.
function makeInput(sr, seconds) {
  const n = Math.floor(sr * seconds);
  const L = new Float32Array(n), R = new Float32Array(n);
  const formants = [700, 1200, 2600];
  const weight = (f) => formants.reduce((s, F) => s + Math.exp(-(((f - F) / 180) ** 2)), 0.02);
  const w = [];
  for (let k = 1; k <= 40; k++) w.push(weight(k * 120));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (120 + 15 * Math.sin(2 * Math.PI * 0.7 * t)) / sr; ph -= Math.floor(ph);
    let s = 0;
    for (let k = 1; k <= 40; k++) s += (w[k - 1] / k) * Math.sin(2 * Math.PI * k * ph);
    const env = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 1.6 * t)), 0.5);
    let v = s * env * 0.5;
    if (Math.floor(t * 3) % 3 === 2) v += (Math.random() * 2 - 1) * 0.15 * env;
    L[i] = v; R[i] = v * 0.9;
  }
  return { L, R, n };
}

const rms = (a) => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); };
const finite = (a) => { for (const v of a) if (!(v - v === 0)) return false; return true; };
const peak = (a) => { let m = 0; for (const v of a) { const x = Math.abs(v); if (x > m) m = x; } return m; };

function run(fx, input, onBlock) {
  const L = Float32Array.from(input.L), R = Float32Array.from(input.R);
  for (let o = 0, b = 0; o + BLOCK <= input.n; o += BLOCK, b++) {
    if (onBlock) onBlock(fx, b);
    fx.process(L.subarray(o, o + BLOCK), R.subarray(o, o + BLOCK), BLOCK);
  }
  return { L, R };
}

const rand = (a, b) => a + Math.random() * (b - a);
function randomValue(d) {
  if (d.type === 'select') return Math.floor(Math.random() * d.options.length);
  const r = Math.random();
  let v = r < 0.2 ? d.min : r < 0.4 ? d.max : d.log ? Math.exp(rand(Math.log(d.min), Math.log(d.max))) : rand(d.min, d.max);
  if (d.int) v = Math.round(v);
  return v;
}

console.log(`Testing ${meta.length} effects\n`);
console.log('effect'.padEnd(22) + 'group'.padEnd(20) + 'in rms'.padEnd(10) + 'out rms'.padEnd(10) + 'peak'.padEnd(9) + 'CPU @48k');

if (meta.length < 30) fail(`expected at least 30 effects, found ${meta.length}`);
const kinds = new Set();

for (const sr of [48000, 44100]) {
  const input = makeInput(sr, 2);
  const inRms = rms(input.L);
  for (const m of meta) {
    kinds.add(m.kind);
    // metadata sanity
    for (const d of m.params) {
      if (d.type === 'select') { if (!(d.def >= 0 && d.def < d.options.length)) fail(`${m.kind}.${d.key} bad select default`); }
      else if (!(d.def >= d.min && d.def <= d.max)) fail(`${m.kind}.${d.key} default ${d.def} outside ${d.min}..${d.max}`);
    }

    // default settings
    const fx = createEffect(m.kind, sr);
    if (m.kind === 'vocoder') fx.setNotes([48, 55]);
    const t0 = performance.now();
    const out = run(fx, input);
    const ms = performance.now() - t0;
    const o = rms(out.L), pk = Math.max(peak(out.L), peak(out.R));
    if (!finite(out.L) || !finite(out.R)) fail(`${m.kind} @${sr}: non-finite output`);
    if (pk > 20) fail(`${m.kind} @${sr}: peak ${pk.toFixed(1)} too high`);
    if (!(o > 1e-5)) fail(`${m.kind} @${sr}: output is silent`);
    const cpu = ms / 2000; // fraction of real time (2 s signal)
    if (cpu > 0.25) fail(`${m.kind} @${sr}: uses ${(cpu * 100).toFixed(0)}% of real time`);
    if (sr === 48000) {
      console.log(m.kind.padEnd(22) + m.group.padEnd(20) + inRms.toFixed(3).padEnd(10) + o.toFixed(3).padEnd(10) + pk.toFixed(2).padEnd(9) + (cpu * 100).toFixed(1) + '%');
    }

    // fuzz: random and extreme parameters, changed while running
    const short = makeInput(sr, 0.4);
    for (let it = 0; it < 25; it++) {
      const f2 = createEffect(m.kind, sr);
      if (m.kind === 'vocoder' && it % 2) f2.setNotes([40 + (it % 12), 52, 59]);
      for (const d of m.params) f2.set(d.key, randomValue(d));
      const res = run(f2, short, (e, b) => {
        if (b % 4 === 0) { const d = m.params[Math.floor(Math.random() * m.params.length)]; e.set(d.key, randomValue(d)); }
      });
      const p2 = Math.max(peak(res.L), peak(res.R));
      if (!finite(res.L) || !finite(res.R)) { fail(`${m.kind} @${sr}: fuzz produced non-finite output (iteration ${it}) params=${JSON.stringify(f2.p)}`); break; }
      if (p2 > 500) { fail(`${m.kind} @${sr}: fuzz peak ${p2.toFixed(0)} (iteration ${it}) params=${JSON.stringify(f2.p)}`); break; }
    }
  }
}

// Chain test: everything at default, in series.
{
  const sr = 48000;
  const input = makeInput(sr, 1);
  const chain = [...kinds].map((k) => createEffect(k, sr));
  const L = Float32Array.from(input.L), R = Float32Array.from(input.R);
  for (let o = 0; o + BLOCK <= input.n; o += BLOCK) {
    for (const fx of chain) fx.process(L.subarray(o, o + BLOCK), R.subarray(o, o + BLOCK), BLOCK);
  }
  if (!finite(L) || !finite(R)) fail('full chain produced non-finite output');
}

console.log(failures ? `\n${failures} check(s) failed` : `\nAll ${kinds.size} effects passed.`);
process.exit(failures ? 1 : 0);
