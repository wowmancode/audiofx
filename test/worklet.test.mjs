// Drives web/worklet.js the way the browser does: global AudioWorkletProcessor
// stub, then the same messages app.js sends.
let Registered;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { posted: [], postMessage(m) { this.posted.push(m); }, onmessage: null }; }
};
globalThis.registerProcessor = (name, cls) => { Registered = { name, cls }; };

await import('../web/worklet.js');

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL ' + msg); } };

check(Registered && Registered.name === 'fx-chain', 'processor registered as fx-chain');
const p = new Registered.cls();
const send = (m) => p.port.onmessage({ data: m });

const sine = (freq, n, off) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * freq * (i + off)) / 48000));
let t = 0;
let lastIn = 0;
function block(input = true) {
  const inp = input ? [[sine(220, 128, t), sine(220, 128, t)]] : [[]];
  lastIn = input ? Math.sqrt(inp[0][0].reduce((s, v) => s + v * v, 0) / 128) : 0;
  t += 128;
  const out = [[new Float32Array(128), new Float32Array(128)]];
  p.process(inp, out);
  return out[0];
}
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

// Empty chain passes audio through scaled by the master volume.
send({ type: 'master', value: 1 });
send({ type: 'auto', value: false });
let o = block();
check(Math.abs(rms(o[0]) / lastIn - 1) < 0.01, 'empty chain passes input through');
check(rms(block(false)[0]) === 0, 'no input gives silence');

// Add effects, bypass, reorder, remove.
send({ type: 'init', chain: [{ id: 'a', kind: 'gain', params: { gain: -6 }, bypass: false }] });
for (let i = 0; i < 20; i++) o = block();
check(Math.abs(rms(o[0]) / lastIn - 0.5012) < 0.02, 'gain -6 dB halves the level');
send({ type: 'bypass', id: 'a', value: true });
o = block();
check(Math.abs(rms(o[0]) / lastIn - 1) < 0.01, 'bypass restores level');
send({ type: 'bypass', id: 'a', value: false });
send({ type: 'set', id: 'a', key: 'gain', value: 0 });
for (let i = 0; i < 20; i++) o = block();
check(Math.abs(rms(o[0]) / lastIn - 1) < 0.02, 'set message updates a parameter');

send({ type: 'add', item: { id: 'b', kind: 'vocoder', params: {}, bypass: false } });
send({ type: 'notes', id: 'b', notes: [48, 55, 60] });
send({ type: 'add', item: { id: 'c', kind: 'reverb', params: { mix: 0.5 }, bypass: false } });
send({ type: 'order', ids: ['c', 'b', 'a'] });
for (let i = 0; i < 200; i++) o = block();
check(rms(o[0]) > 1e-4 && Number.isFinite(rms(o[0])), 'three-effect chain produces finite audio');
send({ type: 'remove', id: 'b' });
check(p.chain.length === 2, 'remove drops an effect');

// Output never exceeds full scale, and bad values never poison the chain.
send({ type: 'master', value: 1.5 });
send({ type: 'set', id: 'a', key: 'gain', value: 24 });
let max = 0;
for (let i = 0; i < 100; i++) { o = block(); max = Math.max(max, ...o[0].map(Math.abs)); }
check(max <= 1, 'output is hard-limited to full scale');
send({ type: 'set', id: 'a', key: 'gain', value: NaN });
send({ type: 'set', id: 'zzz', key: 'gain', value: 1 });
o = block();
check(o[0].every(Number.isFinite), 'NaN parameter and unknown id are ignored');

// Auto level: a quiet input is brought up to about -20 dBFS RMS, a loud one
// is brought down, near-silence is left alone, and turning it off is exact.
{
  const q = new Registered.cls();
  const go = (m) => q.port.onmessage({ data: m });
  go({ type: 'master', value: 1 });
  go({ type: 'init', chain: [] });
  const run = (amp, seconds) => {
    let sum = 0, cnt = 0, tt = 0;
    for (let b = 0; b < (seconds * 48000) / 128; b++) {
      const inp = [[Float32Array.from({ length: 128 }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * (tt + i)) / 48000))]];
      tt += 128;
      const out = [[new Float32Array(128), new Float32Array(128)]];
      q.process(inp, out);
      if (b > (seconds * 48000) / 128 - 100) for (const v of out[0][0]) { sum += v * v; cnt++; }
    }
    return Math.sqrt(sum / cnt);
  };
  const quiet = run(0.028, 6);            // about -34 dBFS RMS
  check(quiet > 0.07 && quiet < 0.14, `auto level lifts a quiet input to about 0.1 RMS (got ${quiet.toFixed(3)})`);
  const loud = run(0.9, 6);               // about -4 dBFS RMS
  check(loud > 0.07 && loud < 0.14, `auto level lowers a loud input to about 0.1 RMS (got ${loud.toFixed(3)})`);
  const hush = new Registered.cls();
  hush.port.onmessage({ data: { type: 'master', value: 1 } });
  let hs = 0, hc = 0;
  for (let b = 0; b < 400; b++) {
    const inp = [[Float32Array.from({ length: 128 }, () => 0.0006 * (Math.random() * 2 - 1))]];
    const out = [[new Float32Array(128), new Float32Array(128)]];
    hush.process(inp, out);
    for (const v of out[0][0]) { hs += v * v; hc++; }
  }
  check(Math.sqrt(hs / hc) < 0.002, 'auto level does not pump up near-silent noise');
  go({ type: 'auto', value: false });
  const off = run(0.028, 1);
  check(Math.abs(off / (0.028 / Math.SQRT2) - 1) < 0.05, 'auto level off passes the input through unchanged');
}

// Meter messages are posted periodically.
check(p.port.posted.some((m) => m.type === 'meter'), 'meter messages are sent');

console.log(failures ? `\n${failures} worklet check(s) failed` : 'Worklet protocol checks passed.');
process.exit(failures ? 1 : 0);
