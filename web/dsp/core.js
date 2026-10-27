// Core DSP helpers shared by every effect. Pure JavaScript, no Web Audio
// globals, so the same code runs in the AudioWorklet and in Node tests.

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const dbToLin = (d) => Math.pow(10, d / 20);
export const linToDb = (x) => 20 * Math.log10(x > 1e-9 ? x : 1e-9);
// One-pole smoothing coefficient for a time constant in milliseconds.
export const coef = (ms, sr) => (ms <= 0 ? 0 : Math.exp(-1 / (ms * 0.001 * sr)));
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// RBJ biquad, transposed direct form II.
export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  set(type, f, q, gainDb, sr) {
    f = clamp(f, 10, sr * 0.45);
    q = clamp(q, 0.05, 40);
    const w = (TAU * f) / sr;
    const cs = Math.cos(w);
    const sn = Math.sin(w);
    const al = sn / (2 * q);
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lp':
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0;
        a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'hp':
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0;
        a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'bp':
        b0 = al; b1 = 0; b2 = -al;
        a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'notch':
        b0 = 1; b1 = -2 * cs; b2 = 1;
        a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'peak':
        b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A;
        a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; break;
      case 'lowshelf': {
        const beta = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * cs + beta);
        b1 = 2 * A * ((A - 1) - (A + 1) * cs);
        b2 = A * ((A + 1) - (A - 1) * cs - beta);
        a0 = (A + 1) + (A - 1) * cs + beta;
        a1 = -2 * ((A - 1) + (A + 1) * cs);
        a2 = (A + 1) + (A - 1) * cs - beta;
        break;
      }
      case 'highshelf': {
        const beta = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * cs + beta);
        b1 = -2 * A * ((A - 1) + (A + 1) * cs);
        b2 = A * ((A + 1) + (A - 1) * cs - beta);
        a0 = (A + 1) - (A - 1) * cs + beta;
        a1 = 2 * ((A - 1) - (A + 1) * cs);
        a2 = (A + 1) - (A - 1) * cs - beta;
        break;
      }
      default: // allpass
        b0 = 1 - al; b1 = -2 * cs; b2 = 1 + al;
        a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  copyFrom(o) {
    this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2;
    this.a1 = o.a1; this.a2 = o.a2;
  }

  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset() { this.z1 = 0; this.z2 = 0; }
}

// Topology-preserving-transform state variable filter (Zavalishin).
// Unlike a direct-form biquad it stays well behaved when its cutoff or Q is
// changed on every sample, so it is used for anything that moves.
// Modes: 'lp', 'bp' (unity-gain peak), 'hp', 'notch'.
const SVF_MODES = { lp: 0, bp: 1, hp: 2, notch: 3 };
export class SVF {
  constructor(mode = 'lp') {
    this.mode = SVF_MODES[mode] ?? 0;
    this.ic1 = 0; this.ic2 = 0;
    this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1;
  }

  setMode(mode) { this.mode = SVF_MODES[mode] ?? 0; }

  set(f, q, sr) {
    f = clamp(f, 10, sr * 0.45);
    q = clamp(q, 0.05, 40);
    const g = Math.tan((Math.PI * f) / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  copyFrom(o) { this.a1 = o.a1; this.a2 = o.a2; this.a3 = o.a3; this.k = o.k; }

  run(v0) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    switch (this.mode) {
      case 0: return v2;
      case 1: return this.k * v1;
      case 2: return v0 - this.k * v1 - v2;
      default: return v0 - this.k * v1;
    }
  }

  reset() { this.ic1 = 0; this.ic2 = 0; }
}

// Circular delay line with linear-interpolated fractional taps.
export class DelayLine {
  constructor(maxSamples) {
    let n = 8;
    while (n < maxSamples + 8) n <<= 1;
    this.mask = n - 1;
    this.buf = new Float32Array(n);
    this.w = 0;
    this.max = n - 4;
  }

  // Sample d samples behind the next write position (d = 1 is the previous
  // sample when read before push, the just-pushed sample when read after).
  tap(d) {
    if (d < 1) d = 1;
    else if (d > this.max) d = this.max;
    const p = this.w - d;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.buf[i & this.mask];
    const b = this.buf[(i + 1) & this.mask];
    return a + (b - a) * f;
  }

  push(x) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  clear() { this.buf.fill(0); }
}

// PolyBLEP residual for band-limited saw/pulse edges.
export function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// Base class for every effect. Subclasses describe their sliders in
// `static params` and implement `update()` and `process(L, R, n)`.
// process() works in place on two Float32Array blocks.
export class FX {
  constructor(sr) {
    this.sr = sr;
    this.p = {};
    for (const d of this.constructor.params) this.p[d.key] = d.def;
  }

  init() { this.update(); }

  set(key, value) {
    if (key in this.p && Number.isFinite(value)) {
      this.p[key] = value;
      this.update();
    }
  }

  update() {}
  process() {}
}

export const REGISTRY = {};
export const register = (kind, cls) => { REGISTRY[kind] = cls; };

export function createEffect(kind, sr, params) {
  const C = REGISTRY[kind];
  if (!C) throw new Error('Unknown effect: ' + kind);
  const fx = new C(sr);
  if (params) for (const k of Object.keys(params)) if (k in fx.p) fx.p[k] = params[k];
  fx.init();
  return fx;
}

export function effectMeta() {
  return Object.entries(REGISTRY).map(([kind, C]) => ({
    kind, label: C.label, group: C.group, desc: C.desc, params: C.params,
  }));
}
