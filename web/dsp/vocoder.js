import { FX, register, Biquad, SVF, blep, clamp, dbToLin, coef, midiToHz, TAU } from './core.js';

const MAX_BANDS = 32;
const MAX_OSC = 48;
const MAX_NOTES = 6;
// Overall level calibration so the default settings come out near input level.
const WET_CAL = 13;
const SIB_CAL = 2.5;

// Filter-bank vocoder. The input (your voice) is the modulator. Its band
// envelopes are applied to the same bands of a built-in synth carrier.
// Extras that help intelligibility: high-frequency pre-emphasis and a
// sibilance path that adds gated noise for S, T and F sounds.
class Vocoder extends FX {
  static label = 'Vocoder';
  static group = 'Voice';
  static desc = 'Your voice shapes a built-in synth. Hold keys on the keyboard to pick notes; with none held it plays the carrier pitch.';
  static params = [
    { key: 'bands', label: 'Bands', min: 4, max: MAX_BANDS, step: 1, def: 16, int: true },
    { key: 'low', label: 'Lowest band', min: 60, max: 500, step: 1, def: 100, unit: ' Hz', log: true },
    { key: 'high', label: 'Highest band', min: 2000, max: 16000, step: 10, def: 9000, unit: ' Hz', log: true },
    { key: 'sharp', label: 'Band sharpness', min: 0.25, max: 4, step: 0.01, def: 1.5, unit: 'x', log: true },
    { key: 'attack', label: 'Envelope attack', min: 0.5, max: 50, step: 0.1, def: 4, unit: ' ms', log: true },
    { key: 'release', label: 'Envelope release', min: 5, max: 300, step: 1, def: 40, unit: ' ms', log: true },
    { key: 'shift', label: 'Formant shift', min: 0.5, max: 2, step: 0.01, def: 1, unit: 'x', log: true },
    { key: 'emphasis', label: 'High-frequency emphasis', min: 0, max: 24, step: 0.5, def: 9, unit: ' dB' },
    { key: 'sib', label: 'Sibilance (S, T, F)', min: 0, max: 2, step: 0.01, def: 0.7 },
    { key: 'note', label: 'Carrier pitch', min: 24, max: 96, step: 1, def: 48, unit: ' MIDI', int: true },
    { key: 'detune', label: 'Detune', min: 0, max: 60, step: 0.5, def: 12, unit: ' cents' },
    { key: 'saw', label: 'Saw level', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'pulse', label: 'Pulse level', min: 0, max: 1, step: 0.01, def: 0.4 },
    { key: 'width', label: 'Pulse width', min: 0.05, max: 0.95, step: 0.01, def: 0.5 },
    { key: 'noise', label: 'Noise in carrier', min: 0, max: 1, step: 0.01, def: 0.1 },
    { key: 'voice2', label: 'Second voice level', min: 0, max: 1, step: 0.01, def: 0 },
    { key: 'interval', label: 'Second voice interval', min: -24, max: 24, step: 1, def: 7, unit: ' semitones', int: true },
    { key: 'drive', label: 'Carrier drive', min: 0, max: 30, step: 0.5, def: 6, unit: ' dB' },
    { key: 'dry', label: 'Dry voice', min: 0, max: 1, step: 0.01, def: 0 },
    { key: 'gain', label: 'Output', min: -24, max: 24, step: 0.5, def: 0, unit: ' dB' },
  ];

  init() {
    this.notes = [];
    this.nb = 16;
    this.a1 = []; this.a2 = []; this.s1 = []; this.s2 = [];
    for (let i = 0; i < MAX_BANDS; i++) {
      this.a1.push(new SVF('bp')); this.a2.push(new SVF('bp'));
      this.s1.push(new SVF('bp')); this.s2.push(new SVF('bp'));
    }
    this.env = new Float64Array(MAX_BANDS);
    this.ph = new Float64Array(MAX_OSC);
    for (let i = 0; i < MAX_OSC; i++) this.ph[i] = (i * 0.6180339887) % 1;
    this.inc = new Float64Array(MAX_OSC);
    this.amp = new Float64Array(MAX_OSC);
    this.nosc = 0;
    this.pre = new Biquad();
    this.sibHp = new Biquad();
    this.sibNoise = new Biquad();
    this.sibEnv = 0;
    this.loEnv = 0;
    this.loLp = 0;
    this.sibGate = 0;
    this.sac = coef(0.5, this.sr);
    this.src = coef(12, this.sr);
    this.loK = 1 - Math.exp((-TAU * 2500) / this.sr);
    this.update();
  }

  // Called by the host when the on-screen keyboard changes.
  setNotes(list) {
    this.notes = list.slice(0, MAX_NOTES).filter((n) => Number.isFinite(n));
    this.update();
  }

  update() {
    const p = this.p, sr = this.sr;
    const nb = clamp(Math.round(p.bands), 4, MAX_BANDS);
    this.nb = nb;
    const high = Math.max(p.high, p.low * 2);
    // Bands are log-spaced; Q follows the spacing so any band count tiles the
    // spectrum, and "sharpness" narrows or widens them from there.
    const q = clamp((1.44 * (nb - 1) / Math.log2(high / p.low)) * p.sharp, 0.7, 40);
    for (let b = 0; b < nb; b++) {
      const f = p.low * Math.pow(high / p.low, b / (nb - 1));
      this.a1[b].set(f, q, sr);
      this.a2[b].copyFrom(this.a1[b]);
      this.s1[b].set(f * p.shift, q, sr);
      this.s2[b].copyFrom(this.s1[b]);
    }
    this.ac = coef(p.attack, sr);
    this.rc = coef(p.release, sr);
    this.pre.set('highshelf', 2500, 0.7, p.emphasis, sr);
    this.sibHp.set('hp', 5500, 0.7, 0, sr);
    this.sibNoise.set('hp', 6000, 0.7, 0, sr);

    const list = this.notes.length ? this.notes : [p.note];
    const dets = [-p.detune, 0, p.detune];
    let k = 0;
    const add = (midi, level) => {
      const f = midiToHz(midi);
      for (const d of dets) {
        if (k >= MAX_OSC) return;
        this.inc[k] = Math.min(0.45, (f * Math.pow(2, d / 1200)) / sr);
        this.amp[k] = level;
        k++;
      }
    };
    for (const nt of list) {
      add(nt, 1);
      if (p.voice2 > 0) add(nt + p.interval, p.voice2);
    }
    this.nosc = k;
    this.oscNorm = 1 / Math.sqrt(Math.max(1, k));
    this.drv = dbToLin(p.drive);
    // Wider bands pass more energy; compensate so level stays comparable.
    this.outG = dbToLin(p.gain);
    this.qNorm = Math.pow(q / 5, 1.1);
  }

  process(L, R, n) {
    const p = this.p;
    const nb = this.nb, ac = this.ac, rc = this.rc, env = this.env;
    const sawM = p.saw, pulM = p.pulse, pw = p.width, noiM = p.noise;
    const sibG = p.sib * SIB_CAL * this.outG, dry = p.dry, outG = this.outG * this.qNorm * WET_CAL;
    const drv = this.drv, nosc = this.nosc, norm = this.oscNorm;
    const { ph, inc, amp, a1, a2, s1, s2 } = this;
    let sibEnv = this.sibEnv, loEnv = this.loEnv, loLp = this.loLp, sibGate = this.sibGate;
    const loK = this.loK;

    for (let i = 0; i < n; i++) {
      const x = L[i], y = R[i];
      const m = this.pre.run((x + y) * 0.5);

      // Carrier: bank of detuned band-limited saw and pulse oscillators.
      let c = 0;
      for (let k = 0; k < nosc; k++) {
        let t = ph[k];
        const dt = inc[k];
        const saw = 2 * t - 1 - blep(t, dt);
        let u = t - pw + 1; u -= Math.floor(u);
        const pul = (t < pw ? 1 : -1) + blep(t, dt) - blep(u, dt);
        c += amp[k] * (sawM * saw + pulM * pul);
        t += dt; if (t >= 1) t -= 1;
        ph[k] = t;
      }
      c = c * norm + noiM * (Math.random() * 2 - 1) * 0.5;
      c = Math.tanh(c * drv);

      // Analysis bands -> envelopes -> synthesis bands.
      let sum = 0;
      for (let b = 0; b < nb; b++) {
        const v = a2[b].run(a1[b].run(m));
        const r = v < 0 ? -v : v;
        let e = env[b];
        e = r + (r > e ? ac : rc) * (e - r);
        env[b] = e;
        sum += s2[b].run(s1[b].run(c)) * e;
      }

      // Sibilance path: high-passed noise following the voice's HF energy,
      // opened only when HF dominates the low band (S, T, F), so vowels
      // stay free of hiss.
      const hf = this.sibHp.run(m);
      const hr = hf < 0 ? -hf : hf;
      sibEnv = hr + (hr > sibEnv ? this.sac : this.src) * (sibEnv - hr);
      loLp += loK * ((x + y) * 0.5 - loLp);
      const lr = loLp < 0 ? -loLp : loLp;
      loEnv = lr + (lr > loEnv ? this.sac : this.src) * (loEnv - lr);
      let gv = (sibEnv / (loEnv + 1e-5) - 0.4) * 1.7;
      gv = gv < 0 ? 0 : gv > 1 ? 1 : gv;
      sibGate += 0.02 * (gv - sibGate);
      const nz = this.sibNoise.run(Math.random() * 2 - 1) * sibEnv * sibGate * sibG;

      const w = sum * outG + nz;
      L[i] = x * dry + w;
      R[i] = y * dry + w;
    }
    this.sibEnv = sibEnv; this.loEnv = loEnv; this.loLp = loLp; this.sibGate = sibGate;
  }
}
register('vocoder', Vocoder);
