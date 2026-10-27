import { FX, register, DelayLine, TAU } from './core.js';

// A user-written effect. The code is the body of a function that runs once
// for every audio sample, inside the audio worklet. It reads and writes the
// local variables l and r, and has four 0-1 knobs, a few helpers and a state
// object `s` that survives between samples.

export const CUSTOM_HELP = `Your code runs once for every audio sample.

Variables
  l, r                  the left and right input sample. Change them to change the output.
  knob1 .. knob4        the four sliders, 0 to 1
  sr                    sample rate in Hz
  t                     time in seconds
  s                     an object that remembers things between samples, e.g. s.x = (s.x || 0) + 1

Helpers (id is any name you choose, so each call keeps its own memory)
  read(id, seconds)     the sample that was written to delay line id that many seconds ago (up to 6 s)
  write(id, x)          store x in delay line id. Read first, then write.
  lp(id, x, hz)         low-pass filter
  hp(id, x, hz)         high-pass filter
  env(id, x, atkMs, relMs)  envelope follower, returns the level of x
  lfo(id, hz)           sine wave from -1 to 1. Call it once per sample.
  saw(id, hz)           saw wave from -1 to 1. Call it once per sample.
  noise()               random number from -1 to 1

Math functions such as sin, cos, abs, tanh, min, max, pow, exp, sqrt and PI are ready to use.
Name a slider with a comment like  // knob1: Delay time
You can use return to stop early for the current sample.
Avoid endless loops. The app checks your code before running it and will refuse code that never finishes.`;

export const CUSTOM_DEFAULT_CODE = `// Custom effect: this code runs once for every audio sample.
// Change l and r to change the sound. Open "How it works" for the full list.

// knob1: Delay time
// knob2: Feedback
// knob3: Tone
// knob4: Mix

const time = 0.05 + knob1 * 0.6;      // 50 to 650 ms
const fb = knob2 * 0.9;
const cutoff = 400 + knob3 * 7600;    // Hz

const dl = lp('toneL', read('L', time), cutoff);
const dr = lp('toneR', read('R', time), cutoff);
write('L', l + dl * fb);
write('R', r + dr * fb);

l += dl * knob4 * 2;
r += dr * knob4 * 2;
`;

export const CUSTOM_EXAMPLES = [
  { name: 'Echo with feedback', code: CUSTOM_DEFAULT_CODE },
  {
    name: 'Tremolo (volume wobble)',
    code: `// knob1: Rate
// knob2: Depth

const rate = 0.5 + knob1 * 14;       // Hz
const depth = knob2;
const g = 1 - depth * (0.5 + 0.5 * lfo('trem', rate));
l *= g;
r *= g;
`,
  },
  {
    name: 'Bit crusher',
    code: `// knob1: Bits
// knob2: Downsample
// knob3: Mix

const bits = 2 + Math.floor(knob1 * 12);
const step = 1 + Math.floor(knob2 * 30);
const levels = Math.pow(2, bits - 1);

s.count = (s.count || 0) + 1;
if (s.count >= step || s.hl === undefined) {
  s.count = 0;
  s.hl = Math.round(l * levels) / levels;
  s.hr = Math.round(r * levels) / levels;
}
l = l * (1 - knob3) + s.hl * knob3;
r = r * (1 - knob3) + s.hr * knob3;
`,
  },
  {
    name: 'Ring modulation',
    code: `// knob1: Frequency
// knob2: Mix

const f = 20 + knob1 * knob1 * 2000;   // Hz
const m = lfo('ring', f);
l = l * (1 - knob2) + l * m * knob2;
r = r * (1 - knob2) + r * m * knob2;
`,
  },
  {
    name: 'Noise gate',
    code: `// knob1: Threshold
// knob2: Release

const level = env('gate', Math.max(abs(l), abs(r)), 2, 20 + knob2 * 400);
const open = level > knob1 * 0.2 ? 1 : 0;
s.g = (s.g === undefined ? 1 : s.g) + (open - (s.g === undefined ? 1 : s.g)) * 0.002;
l *= s.g;
r *= s.g;
`,
  },
  {
    name: 'Soft distortion with tone',
    code: `// knob1: Drive
// knob2: Tone
// knob3: Output

const drive = 1 + knob1 * 30;
const out = knob3 * 1.5;
l = lp('toneL', Math.tanh(l * drive), 500 + knob2 * 9000) * out;
r = lp('toneR', Math.tanh(r * drive), 500 + knob2 * 9000) * out;
`,
  },
];

const MATH_NAMES = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'abs', 'floor', 'ceil', 'round',
  'min', 'max', 'pow', 'exp', 'log', 'sqrt', 'tanh', 'sign', 'random', 'hypot'];

// Turns user code into a factory: factory(helpers, state) returns
// run(L, R, n, sr, t0, k1, k2, k3, k4). Throws SyntaxError for bad code.
export function compileCustom(code) {
  const body = '"use strict";\n'
    + `const { ${MATH_NAMES.join(', ')} } = Math;\n`
    + 'const PI = Math.PI, TAU = Math.PI * 2;\n'
    + 'const { read, write, lp, hp, env, lfo, saw, noise } = h;\n'
    + 'let l = 0, r = 0, t = 0, sr = 48000, knob1 = 0, knob2 = 0, knob3 = 0, knob4 = 0;\n'
    + 'function sample() {\n' + code + '\n}\n'
    + 'return function run(L, R, n, rate, t0, k1, k2, k3, k4) {\n'
    + '  sr = rate; knob1 = k1; knob2 = k2; knob3 = k3; knob4 = k4;\n'
    + '  for (let i = 0; i < n; i++) {\n'
    + '    l = L[i]; r = R[i]; t = t0 + i / rate;\n'
    + '    sample();\n'
    + '    L[i] = l; R[i] = r;\n'
    + '  }\n'
    + '};';
  return new Function('h', 's', body);
}

class Helpers {
  constructor(sr) {
    this.sr = sr;
    this.lines = Object.create(null);
    this.nLines = 0;
    const lpS = Object.create(null), hpS = Object.create(null);
    const envS = Object.create(null), phS = Object.create(null);
    const line = (id) => {
      let d = this.lines[id];
      if (!d) {
        if (++this.nLines > 16) throw new Error('Too many delay lines (the limit is 16)');
        d = this.lines[id] = new DelayLine(sr * 6);
      }
      return d;
    };
    this.read = (id, seconds) => line(id).tap(seconds * sr);
    this.write = (id, x) => { line(id).push(x); };
    this.lp = (id, x, hz) => {
      const k = 1 - Math.exp((-TAU * Math.min(Math.max(hz, 1), sr * 0.45)) / sr);
      const y = (lpS[id] || 0) + k * (x - (lpS[id] || 0));
      lpS[id] = y;
      return y;
    };
    this.hp = (id, x, hz) => {
      const k = 1 - Math.exp((-TAU * Math.min(Math.max(hz, 1), sr * 0.45)) / sr);
      const y = (hpS[id] || 0) + k * (x - (hpS[id] || 0));
      hpS[id] = y;
      return x - y;
    };
    this.env = (id, x, atkMs, relMs) => {
      const a = Math.abs(x), e = envS[id] || 0;
      const c = Math.exp(-1 / (0.001 * Math.max(a > e ? atkMs : relMs, 0.01) * sr));
      const y = a + c * (e - a);
      envS[id] = y;
      return y;
    };
    this.lfo = (id, hz) => {
      let p = (phS[id] || 0) + hz / sr;
      p -= Math.floor(p);
      phS[id] = p;
      return Math.sin(TAU * p);
    };
    this.saw = (id, hz) => {
      let p = (phS['s' + id] || 0) + hz / sr;
      p -= Math.floor(p);
      phS['s' + id] = p;
      return 2 * p - 1;
    };
    this.noise = () => Math.random() * 2 - 1;
  }
}

const describe = (e) => (e && e.message ? `${e.name || 'Error'}: ${e.message}` : String(e));

class CustomCode extends FX {
  static label = 'Custom code';
  static group = 'Code';
  static desc = 'Write your own effect in JavaScript. The code runs for every audio sample, with four sliders you can use however you like.';
  static custom = true;
  static params = [
    { key: 'knob1', label: 'Knob 1', min: 0, max: 1, step: 0.001, def: 0.5 },
    { key: 'knob2', label: 'Knob 2', min: 0, max: 1, step: 0.001, def: 0.5 },
    { key: 'knob3', label: 'Knob 3', min: 0, max: 1, step: 0.001, def: 0.5 },
    { key: 'knob4', label: 'Knob 4', min: 0, max: 1, step: 0.001, def: 0.5 },
  ];

  init() {
    this.t = 0;
    this.run = null;
    this.error = '';
    this.warned = false;
    this.onError = null;
    this.setCode(CUSTOM_DEFAULT_CODE);
  }

  // Returns '' on success or an error message. On failure the effect passes
  // audio through untouched.
  setCode(code) {
    try {
      const factory = compileCustom(String(code));
      this.helpers = new Helpers(this.sr);
      this.state = {};
      this.run = factory(this.helpers, this.state);
      this.error = '';
      this.warned = false;
      return '';
    } catch (e) {
      return this.fail(e);
    }
  }

  disable() { this.run = null; }

  fail(e) {
    this.run = null;
    this.error = describe(e);
    if (this.onError) this.onError(this.error);
    return this.error;
  }

  process(L, R, n) {
    if (!this.run) return;
    const p = this.p;
    try {
      this.run(L, R, n, this.sr, this.t, p.knob1, p.knob2, p.knob3, p.knob4);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.t += n / this.sr;
    let bad = false;
    for (let i = 0; i < n; i++) {
      if (!(L[i] - L[i] === 0)) { L[i] = 0; bad = true; }
      if (!(R[i] - R[i] === 0)) { R[i] = 0; bad = true; }
    }
    if (bad && !this.warned) {
      this.warned = true;
      if (this.onError) this.onError('Warning: your code produced NaN or Infinity. Those samples were replaced with silence.');
    }
  }
}
register('custom', CustomCode);

// Runs a piece of code on a short test signal and reports whether it is safe
// to hand to the audio thread. The app runs this in a Web Worker with a
// timeout, so even an endless loop cannot freeze the audio.
export function checkCustomCode(code, sr = 48000, limitMs = 600) {
  const fx = new CustomCode(sr);
  fx.init();
  let problem = '';
  let warning = '';
  fx.onError = (m) => { if (m.startsWith('Warning')) warning = m; else problem = m; };
  const err = fx.setCode(code);
  if (err) return { ok: false, error: err };
  const L = new Float32Array(128), R = new Float32Array(128);
  const start = Date.now();
  for (let b = 0; b < 128; b++) {
    for (let i = 0; i < 128; i++) {
      const v = 0.3 * Math.sin((2 * Math.PI * 220 * (b * 128 + i)) / sr) + 0.05 * (Math.random() * 2 - 1);
      L[i] = v; R[i] = v;
    }
    fx.process(L, R, 128);
    if (problem) return { ok: false, error: problem };
    if (Date.now() - start > limitMs) {
      return { ok: false, error: 'Your code is too slow to run in real time. Simplify it or remove heavy loops.' };
    }
  }
  return warning ? { ok: true, warning } : { ok: true };
}
