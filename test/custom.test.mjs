import { createEffect, } from '../web/dsp/index.js';
import { checkCustomCode, CUSTOM_DEFAULT_CODE, CUSTOM_EXAMPLES } from '../web/dsp/custom.js';
import assert from 'node:assert/strict';

const sr = 48000;
const sig = (n) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 220 * i / sr));
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
function render(fx, n = 24000) {
  const L = sig(n), R = sig(n);
  for (let i = 0; i < n; i += 128) fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128);
  return L;
}
const make = (code, p) => { const fx = createEffect('custom', sr, p); const e = fx.setCode(code); return { fx, e }; };

// syntax error -> message, passthrough
{ const { fx, e } = make('l = ;'); assert.ok(e.includes('SyntaxError')); const o = render(fx); assert.ok(Math.abs(rms(o) - rms(sig(24000))) < 1e-6); }
// runtime error -> onError, passthrough
{ const fx = createEffect('custom', sr); let msg = ''; fx.onError = (m) => { msg = m; }; fx.setCode('nope.x = 1;'); render(fx); assert.ok(msg.includes('ReferenceError'), msg); }
// NaN -> silence + warning
{ const fx = createEffect('custom', sr); let msg = ''; fx.onError = (m) => { msg = m; }; fx.setCode('l = 0/0;'); const o = render(fx); assert.equal(rms(o), 0); assert.ok(msg.startsWith('Warning')); }
// helpers + return + knobs
{ const { fx } = make('if (knob1 > 0.9) return; l *= 0.5; r = lp("a", r, 1000) + hp("b", r, 100) * 0 + noise() * 0;', { knob1: 0.2 }); assert.ok(rms(render(fx)) < rms(sig(24000))); }
// default code audible change
{ const fx = createEffect('custom', sr); const o = render(fx, 48000); const d = sig(48000); let diff = 0; for (let i = 0; i < o.length; i++) diff += (o[i] - d[i]) ** 2; assert.ok(Math.sqrt(diff / o.length) > 0.02); }
// all examples pass the check
for (const ex of CUSTOM_EXAMPLES) { const r = checkCustomCode(ex.code); assert.ok(r.ok, ex.name + ': ' + r.error); }
assert.ok(checkCustomCode(CUSTOM_DEFAULT_CODE).ok);
assert.ok(!checkCustomCode('while(false){} l = ;').ok);
console.log('Custom code checks passed.');
