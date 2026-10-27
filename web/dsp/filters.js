import { FX, register, Biquad, SVF, clamp, dbToLin, coef } from './core.js';

const MAX_STAGES = 4;

function makeFilter(kind, label, mode, desc, defFreq, defQ, defStages, defGain) {
  class Filter extends FX {
    static label = label;
    static group = 'Filter & EQ';
    static desc = desc;
    static params = [
      { key: 'freq', label: 'Frequency', min: 20, max: 20000, step: 1, def: defFreq, unit: ' Hz', log: true },
      { key: 'q', label: 'Resonance (Q)', min: 0.1, max: 20, step: 0.01, def: defQ, log: true },
      { key: 'stages', label: 'Steepness (stages)', min: 1, max: MAX_STAGES, step: 1, def: defStages, int: true },
      { key: 'gain', label: 'Output level', min: -12, max: 24, step: 0.5, def: defGain, unit: ' dB' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
    ];
    init() {
      this.bl = []; this.br = [];
      for (let i = 0; i < MAX_STAGES; i++) { this.bl.push(new SVF(mode)); this.br.push(new SVF(mode)); }
      // Frequency and Q are smoothed (in the log domain) once per block so
      // dragging a slider never produces a click.
      this.sf = Math.log(this.p.freq); this.sq = Math.log(this.p.q);
      this.apply();
    }
    apply() {
      const f = Math.exp(this.sf), q = Math.exp(this.sq);
      for (let i = 0; i < MAX_STAGES; i++) {
        // Resonance applies to the first stage of LP/HP; extra stages are
        // Butterworth-like so the slope steepens without piling up resonance.
        const qs = (mode === 'lp' || mode === 'hp') && i > 0 ? 0.707 : q;
        this.bl[i].set(f, qs, this.sr);
        this.br[i].copyFrom(this.bl[i]);
      }
    }
    process(L, R, n) {
      this.sf += (Math.log(this.p.freq) - this.sf) * 0.3;
      this.sq += (Math.log(this.p.q) - this.sq) * 0.3;
      this.apply();
      const st = Math.round(this.p.stages), mix = this.p.mix;
      const og = dbToLin(this.p.gain);
      const bl = this.bl, br = this.br;
      for (let s = st; s < MAX_STAGES; s++) { bl[s].reset(); br[s].reset(); }
      for (let i = 0; i < n; i++) {
        let x = L[i], y = R[i];
        for (let s = 0; s < st; s++) { x = bl[s].run(x); y = br[s].run(y); }
        L[i] = L[i] * (1 - mix) + x * og * mix;
        R[i] = R[i] * (1 - mix) + y * og * mix;
      }
    }
  }
  register(kind, Filter);
}

makeFilter('lowpass', 'Low-pass filter', 'lp', 'Removes highs above the cutoff.', 900, 2, 2, 0);
makeFilter('highpass', 'High-pass filter', 'hp', 'Removes lows below the cutoff.', 900, 1.2, 2, 0);
makeFilter('bandpass', 'Band-pass filter', 'bp', 'Keeps only a band around the frequency.', 1400, 1.5, 2, 9);
makeFilter('notch', 'Notch filter', 'notch', 'Cuts a band around the frequency. Lower Q makes a wider scoop.', 1200, 0.7, 2, 0);

class EQ3 extends FX {
  static label = 'Equalizer';
  static group = 'Filter & EQ';
  static desc = 'Low shelf, one parametric mid band and a high shelf.';
  static params = [
    { key: 'lowFreq', label: 'Low shelf frequency', min: 40, max: 800, step: 1, def: 200, unit: ' Hz', log: true },
    { key: 'lowGain', label: 'Low gain', min: -18, max: 18, step: 0.1, def: -10, unit: ' dB' },
    { key: 'midFreq', label: 'Mid frequency', min: 200, max: 6000, step: 1, def: 1800, unit: ' Hz', log: true },
    { key: 'midGain', label: 'Mid gain', min: -18, max: 18, step: 0.1, def: 10, unit: ' dB' },
    { key: 'midQ', label: 'Mid width (Q)', min: 0.2, max: 8, step: 0.01, def: 1.2, log: true },
    { key: 'highFreq', label: 'High shelf frequency', min: 1500, max: 16000, step: 10, def: 5000, unit: ' Hz', log: true },
    { key: 'highGain', label: 'High gain', min: -18, max: 18, step: 0.1, def: 8, unit: ' dB' },
  ];
  init() {
    this.l = [new Biquad(), new Biquad(), new Biquad()];
    this.r = [new Biquad(), new Biquad(), new Biquad()];
    const p = this.p;
    // Smoothed copies of the controls (frequencies in log domain).
    this.s = {
      lf: Math.log(p.lowFreq), lg: p.lowGain, mf: Math.log(p.midFreq), mg: p.midGain,
      mq: Math.log(p.midQ), hf: Math.log(p.highFreq), hg: p.highGain,
    };
    this.apply();
  }
  apply() {
    const s = this.s, sr = this.sr;
    this.l[0].set('lowshelf', Math.exp(s.lf), 0.707, s.lg, sr);
    this.l[1].set('peak', Math.exp(s.mf), Math.exp(s.mq), s.mg, sr);
    this.l[2].set('highshelf', Math.exp(s.hf), 0.707, s.hg, sr);
    for (let i = 0; i < 3; i++) this.r[i].copyFrom(this.l[i]);
  }
  process(L, R, n) {
    const p = this.p, s = this.s, k = 0.25;
    s.lf += (Math.log(p.lowFreq) - s.lf) * k; s.lg += (p.lowGain - s.lg) * k;
    s.mf += (Math.log(p.midFreq) - s.mf) * k; s.mg += (p.midGain - s.mg) * k;
    s.mq += (Math.log(p.midQ) - s.mq) * k;
    s.hf += (Math.log(p.highFreq) - s.hf) * k; s.hg += (p.highGain - s.hg) * k;
    this.apply();
    const l = this.l, r = this.r;
    for (let i = 0; i < n; i++) {
      L[i] = l[2].run(l[1].run(l[0].run(L[i])));
      R[i] = r[2].run(r[1].run(r[0].run(R[i])));
    }
  }
}
register('eq', EQ3);

class AutoWah extends FX {
  static label = 'Auto-wah';
  static group = 'Filter & EQ';
  static desc = 'A band-pass filter that opens and closes with how hard you sing or play.';
  static params = [
    { key: 'sens', label: 'Sensitivity', min: 0, max: 1, step: 0.01, def: 0.6 },
    { key: 'base', label: 'Lowest frequency', min: 100, max: 1500, step: 1, def: 350, unit: ' Hz', log: true },
    { key: 'range', label: 'Sweep range', min: 0.5, max: 5, step: 0.1, def: 3, unit: ' oct' },
    { key: 'q', label: 'Resonance (Q)', min: 1, max: 20, step: 0.1, def: 6 },
    { key: 'attack', label: 'Attack', min: 1, max: 50, step: 0.5, def: 4, unit: ' ms', log: true },
    { key: 'release', label: 'Release', min: 20, max: 500, step: 1, def: 150, unit: ' ms', log: true },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() { this.bl = new SVF('bp'); this.br = new SVF('bp'); this.env = 0; this.cnt = 0; this.update(); }
  update() {
    this.ac = coef(this.p.attack, this.sr);
    this.rc = coef(this.p.release, this.sr);
  }
  process(L, R, n) {
    const { sens, base, range, q, mix } = this.p;
    let env = this.env;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      env = a + (a > env ? this.ac : this.rc) * (env - a);
      if ((this.cnt++ & 7) === 0) {
        const x = clamp(env * sens * 8, 0, 1);
        this.bl.set(base * Math.pow(2, range * x), q, this.sr);
        this.br.copyFrom(this.bl);
      }
      const wl = this.bl.run(L[i]) * 2.5, wr = this.br.run(R[i]) * 2.5;
      L[i] = L[i] * (1 - mix) + wl * mix;
      R[i] = R[i] * (1 - mix) + wr * mix;
    }
    this.env = env;
  }
}
register('autowah', AutoWah);

class FilterSweep extends FX {
  static label = 'Filter sweep (LFO)';
  static group = 'Filter & EQ';
  static desc = 'A resonant filter swept up and down automatically.';
  static params = [
    { key: 'mode', label: 'Filter type', type: 'select', options: ['Low-pass', 'Band-pass', 'High-pass'], def: 0 },
    { key: 'rate', label: 'Rate', min: 0.05, max: 10, step: 0.01, def: 0.35, unit: ' Hz', log: true },
    { key: 'min', label: 'Lowest frequency', min: 80, max: 4000, step: 1, def: 200, unit: ' Hz', log: true },
    { key: 'max', label: 'Highest frequency', min: 200, max: 12000, step: 1, def: 4000, unit: ' Hz', log: true },
    { key: 'q', label: 'Resonance (Q)', min: 0.5, max: 15, step: 0.1, def: 5, log: true },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() { this.bl = new SVF('lp'); this.br = new SVF('lp'); this.ph = 0; this.cnt = 0; this.update(); }
  update() {
    const m = ['lp', 'bp', 'hp'][Math.round(this.p.mode)] || 'lp';
    this.bl.setMode(m); this.br.setMode(m);
  }
  process(L, R, n) {
    const { rate, min, q, mix } = this.p;
    const max = Math.max(this.p.max, min * 1.01);
    const ratio = max / min;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      ph += rate / this.sr; if (ph >= 1) ph -= 1;
      if ((this.cnt++ & 7) === 0) {
        const f = min * Math.pow(ratio, 0.5 + 0.5 * Math.sin(ph * 6.283185307));
        this.bl.set(f, q, this.sr);
        this.br.copyFrom(this.bl);
      }
      const wl = this.bl.run(L[i]), wr = this.br.run(R[i]);
      L[i] = L[i] * (1 - mix) + wl * mix;
      R[i] = R[i] * (1 - mix) + wr * mix;
    }
    this.ph = ph;
  }
}
register('sweep', FilterSweep);

// Formant table (F1, F2, F3 in Hz) for five vowel positions. The slider
// interpolates continuously between them.
const FORMANTS = [
  [800, 1150, 2900],
  [400, 1600, 2700],
  [350, 1700, 2700],
  [450, 800, 2830],
  [325, 700, 2530],
];
const FORMANT_GAIN = [1, 0.7, 0.45];

class FormantFilter extends FX {
  static label = 'Formant filter';
  static group = 'Filter & EQ';
  static desc = 'Three resonances that sculpt vowel-like timbres. Slide the vowel position and scale the formants.';
  static params = [
    { key: 'vowel', label: 'Vowel position', min: 0, max: 4, step: 0.01, def: 0 },
    { key: 'scale', label: 'Formant scale', min: 0.5, max: 2, step: 0.01, def: 1, unit: 'x', log: true },
    { key: 'q', label: 'Resonance (Q)', min: 2, max: 20, step: 0.1, def: 8 },
    { key: 'gain', label: 'Level', min: -12, max: 24, step: 0.5, def: 9, unit: ' dB' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() {
    this.bl = [new SVF('bp'), new SVF('bp'), new SVF('bp')];
    this.br = [new SVF('bp'), new SVF('bp'), new SVF('bp')];
    this.update();
  }
  update() {
    const v = clamp(this.p.vowel, 0, 4 - 1e-6);
    const i = Math.floor(v), f = v - i;
    for (let k = 0; k < 3; k++) {
      const freq = (FORMANTS[i][k] * (1 - f) + FORMANTS[Math.min(4, i + 1)][k] * f) * this.p.scale;
      this.bl[k].set(freq, this.p.q, this.sr);
      this.br[k].copyFrom(this.bl[k]);
    }
    this.g = dbToLin(this.p.gain);
  }
  process(L, R, n) {
    const mix = this.p.mix, g = this.g, bl = this.bl, br = this.br;
    for (let i = 0; i < n; i++) {
      const x = L[i], y = R[i];
      const wl = (bl[0].run(x) * FORMANT_GAIN[0] + bl[1].run(x) * FORMANT_GAIN[1] + bl[2].run(x) * FORMANT_GAIN[2]) * g;
      const wr = (br[0].run(y) * FORMANT_GAIN[0] + br[1].run(y) * FORMANT_GAIN[1] + br[2].run(y) * FORMANT_GAIN[2]) * g;
      L[i] = x * (1 - mix) + wl * mix;
      R[i] = y * (1 - mix) + wr * mix;
    }
  }
}
register('formant', FormantFilter);
