// Guards against effects drifting back to sounding like the dry signal, or like each other.
import { createEffect, effectMeta } from '../web/dsp/index.js';
const sr = 48000, N = 128, SECS = 4;

function makeVoice(rmsTarget) {
  const n = sr * SECS, x = new Float32Array(n);
  const formants = [[700, 1200, 2600], [350, 2300, 3000], [500, 900, 2500]];
  let ph = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, vowel = formants[Math.floor(t * 1.5) % 3];
    const f0 = 115 + 25 * Math.sin(2 * Math.PI * 0.8 * t) + 10 * Math.sin(2 * Math.PI * 3 * t);
    ph += f0 / sr; ph -= Math.floor(ph);
    let s = 0;
    for (let k = 1; k <= 45; k++) {
      const f = k * f0, w = vowel.reduce((a, F) => a + Math.exp(-(((f - F) / 200) ** 2)), 0.01);
      s += (w / k) * Math.sin(2 * Math.PI * k * ph);
    }
    const syl = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 1.5 * t + 0.4)), 0.6);
    let v = s * syl;
    if (((t * 1.5) % 1) > 0.85) v += (Math.random() * 2 - 1) * 0.5; // fricative burst between syllables
    x[i] = v; sum += v * v;
  }
  const g = rmsTarget / Math.sqrt(sum / n);
  // Room noise about 30 dB below the voice, as any real microphone has.
  for (let i = 0; i < n; i++) x[i] = x[i] * g + (Math.random() * 2 - 1) * rmsTarget * 0.055;
  return x;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      } }
  }
}
const FN = 4096, HOP = 2048, EDGES = []; // 1/6-octave band edges 100 Hz .. 12 kHz
for (let e = 100; e < 12000; e *= Math.pow(2, 1 / 6)) EDGES.push(e);
const bandOf = (k) => { const f = (k * sr) / FN; for (let b = 0; b < EDGES.length - 1; b++) if (f >= EDGES[b] && f < EDGES[b + 1]) return b; return -1; };
const BIN = new Int16Array(FN / 2).map((_, k) => bandOf(k)); const NB = EDGES.length - 1;
function bandFrames(x) {
  const frames = [];
  for (let o = 0; o + FN <= x.length; o += HOP) {
    const re = new Float64Array(FN), im = new Float64Array(FN);
    for (let i = 0; i < FN; i++) re[i] = x[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FN));
    fft(re, im);
    const p = new Float64Array(NB);
    for (let k = 1; k < FN / 2; k++) if (BIN[k] >= 0) p[BIN[k]] += re[k] * re[k] + im[k] * im[k];
    frames.push(Array.from(p, (v) => 10 * Math.log10(v + 1e-12)));
  }
  return frames;
}
function run(kind, x) {
  const fx = createEffect(kind, sr); if (kind === 'vocoder') fx.setNotes([48, 55]);
  const L = Float32Array.from(x), R = Float32Array.from(x);
  for (let o = 0; o + N <= x.length; o += N) fx.process(L.subarray(o, o + N), R.subarray(o, o + N), N);
  return { L, R };
}
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };


// Measures every effect at its default settings on a voice-like signal at the
// level Auto level delivers (about -20 dBFS RMS), against the dry signal and
// against each other.
const LEVEL = 0.1;
const dry = makeVoice(LEVEL), dryF = bandFrames(dry);
const rows = [];
for (const m of effectMeta()) {
  const out = run(m.kind, dry), wet = out.L, wetF = bandFrames(wet);
  let dl = 0, sl = 0;
  for (let i = 0; i < wet.length; i++) { const d = out.L[i] - out.R[i]; dl += d * d; sl += out.L[i] * out.L[i] + out.R[i] * out.R[i]; }
  const stereo = Math.sqrt(dl / (sl + 1e-20));   // 0 = identical channels, ~1 = fully different
  let dd = 0, dw = 0, ww = 0;
  for (let i = 0; i < dry.length; i++) { dd += dry[i] * dry[i]; dw += dry[i] * wet[i]; ww += wet[i] * wet[i]; }
  const resid = Math.sqrt(Math.max(0, 1 - (dw * dw) / (dd * ww + 1e-20)));
  const level_dB = 20 * Math.log10(rms(wet) / rms(dry));
  const sf = wetF.map((fr, i) => fr.map((v, b) => v - dryF[i][b]));
  const shape = [], shapeStd = [];
  for (let b = 0; b < NB; b++) { const col = sf.map((fr) => fr[b]); shape.push(mean(col)); shapeStd.push(std(col)); }
  const lv = mean(shape);
  rows.push({
    kind: m.kind, resid, stereo, level_dB, dShape: mean(shape.map((v) => Math.abs(v - lv))), modStd: mean(shapeStd),
    vec: [...shape.map((v) => v - lv), ...shapeStd.map((v) => v * 0.5), resid * 20, stereo * 30],
  });
}

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL ' + m); };
const REPORT = process.argv.includes('--report');

console.log('effect'.padEnd(13), 'resid'.padEnd(7), 'level dB'.padEnd(9), 'shape dB'.padEnd(9), 'mod dB'.padEnd(7), 'stereo');
for (const r of rows.sort((a, b) => a.resid - b.resid)) {
  console.log(r.kind.padEnd(13), r.resid.toFixed(2).padEnd(7), r.level_dB.toFixed(1).padStart(6).padEnd(9), r.dShape.toFixed(1).padEnd(9), r.modStd.toFixed(1).padEnd(7), r.stereo.toFixed(2));
  const audible = r.resid >= 0.25 || r.dShape >= 2.5 || Math.abs(r.level_dB) >= 3 || r.modStd >= 3 || r.stereo >= 0.25;
  if (!audible) fail(`${r.kind} sounds like the dry signal at its default settings`);
}

const pairs = [];
for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
  pairs.push([Math.sqrt(mean(rows[i].vec.map((v, k) => (v - rows[j].vec[k]) ** 2))), rows[i].kind, rows[j].kind]);
}
pairs.sort((a, b) => a[0] - b[0]);
console.log('\nclosest pairs (smaller = more alike):');
for (const p of pairs.slice(0, 10)) console.log(' ', p[0].toFixed(2).padStart(5), p[1], '~', p[2]);
const MIN_PAIR = Number(process.env.MIN_PAIR || 0.6);
for (const p of pairs) if (p[0] < MIN_PAIR) fail(`${p[1]} and ${p[2]} sound alike at their defaults (distance ${p[0].toFixed(2)} < ${MIN_PAIR})`);

if (!REPORT) { console.log(failures ? `\n${failures} distinctness check(s) failed` : '\nEvery effect is audibly different from dry and from every other effect.'); process.exit(failures ? 1 : 0); }
