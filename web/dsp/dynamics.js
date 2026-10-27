import { FX, register, clamp, dbToLin, linToDb, coef, TAU } from './core.js';

class Gain extends FX {
  static label = 'Gain';
  static group = 'Dynamics';
  static desc = 'Simple volume control with click-free smoothing.';
  static params = [
    { key: 'gain', label: 'Gain', min: -60, max: 24, step: 0.1, def: 0, unit: ' dB' },
  ];
  init() { this.cur = dbToLin(this.p.gain); this.update(); }
  update() { this.tgt = dbToLin(this.p.gain); }
  process(L, R, n) {
    let g = this.cur;
    const step = (this.tgt - g) / n;
    for (let i = 0; i < n; i++) { g += step; L[i] *= g; R[i] *= g; }
    this.cur = this.tgt;
  }
}
register('gain', Gain);

class Compressor extends FX {
  static label = 'Compressor';
  static group = 'Dynamics';
  static desc = 'Evens out loud and quiet parts. Stereo-linked, soft knee.';
  static params = [
    { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 0.5, def: -24, unit: ' dB' },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, def: 4, unit: ':1' },
    { key: 'knee', label: 'Knee', min: 0, max: 24, step: 0.5, def: 6, unit: ' dB' },
    { key: 'attack', label: 'Attack', min: 0.1, max: 100, step: 0.1, def: 8, unit: ' ms', log: true },
    { key: 'release', label: 'Release', min: 10, max: 1000, step: 1, def: 150, unit: ' ms', log: true },
    { key: 'makeup', label: 'Makeup gain', min: 0, max: 30, step: 0.5, def: 3, unit: ' dB' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() { this.env = 0; this.update(); }
  update() {
    const p = this.p;
    this.ac = coef(p.attack, this.sr);
    this.rc = coef(p.release, this.sr);
    this.mk = dbToLin(p.makeup);
    this.slope = 1 - 1 / Math.max(1, p.ratio);
  }
  process(L, R, n) {
    const th = this.p.threshold, knee = this.p.knee, slope = this.slope, mix = this.p.mix;
    let env = this.env;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      const over = linToDb(a) - th;
      let gr;
      if (knee > 0) {
        if (2 * over < -knee) gr = 0;
        else if (2 * over > knee) gr = slope * over;
        else { const x = over + knee / 2; gr = (slope * x * x) / (2 * knee); }
      } else gr = over > 0 ? slope * over : 0;
      const c = gr > env ? this.ac : this.rc;
      env = gr + c * (env - gr);
      const g = 1 - mix + dbToLin(-env) * this.mk * mix;
      L[i] *= g; R[i] *= g;
    }
    this.env = env;
  }
}
register('compressor', Compressor);

class Limiter extends FX {
  static label = 'Limiter';
  static group = 'Dynamics';
  static desc = 'Brick-wall ceiling so nothing goes over the level you set.';
  static params = [
    { key: 'ceiling', label: 'Ceiling', min: -24, max: 0, step: 0.1, def: -1, unit: ' dB' },
    { key: 'release', label: 'Release', min: 5, max: 500, step: 1, def: 80, unit: ' ms', log: true },
  ];
  init() { this.g = 1; this.update(); }
  update() { this.ceil = dbToLin(this.p.ceiling); this.rc = coef(this.p.release, this.sr); }
  process(L, R, n) {
    const ceil = this.ceil;
    let g = this.g;
    for (let i = 0; i < n; i++) {
      const pk = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      const target = pk > ceil ? ceil / pk : 1;
      g = target < g ? target : target + this.rc * (g - target);
      L[i] = clamp(L[i] * g, -ceil, ceil);
      R[i] = clamp(R[i] * g, -ceil, ceil);
    }
    this.g = g;
  }
}
register('limiter', Limiter);

class Gate extends FX {
  static label = 'Noise gate';
  static group = 'Dynamics';
  static desc = 'Silences the signal when it falls below the threshold.';
  static params = [
    { key: 'threshold', label: 'Threshold', min: -90, max: 0, step: 0.5, def: -50, unit: ' dB' },
    { key: 'attack', label: 'Attack', min: 0.1, max: 50, step: 0.1, def: 2, unit: ' ms', log: true },
    { key: 'release', label: 'Release', min: 5, max: 1000, step: 1, def: 120, unit: ' ms', log: true },
    { key: 'range', label: 'Range', min: -80, max: 0, step: 1, def: -60, unit: ' dB' },
  ];
  init() { this.env = 0; this.g = 0; this.open = false; this.update(); }
  update() {
    this.ac = coef(this.p.attack, this.sr);
    this.rc = coef(this.p.release, this.sr);
    this.floor = dbToLin(this.p.range);
    this.dec = coef(30, this.sr);
  }
  process(L, R, n) {
    const th = this.p.threshold;
    let { env, g, open } = this;
    if (g < this.floor) g = this.floor;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      env = a > env ? a : a + this.dec * (env - a);
      const lv = linToDb(env);
      if (lv > th) open = true; else if (lv < th - 4) open = false;
      const target = open ? 1 : this.floor;
      const c = target > g ? this.ac : this.rc;
      g = target + c * (g - target);
      L[i] *= g; R[i] *= g;
    }
    this.env = env; this.g = g; this.open = open;
  }
}
register('gate', Gate);

class Saturation extends FX {
  static label = 'Saturation';
  static group = 'Distortion';
  static desc = 'Smooth tanh drive from warm to heavy, with a tone filter after it.';
  static params = [
    { key: 'drive', label: 'Drive', min: 0, max: 40, step: 0.5, def: 14, unit: ' dB' },
    { key: 'tone', label: 'Tone (low-pass)', min: 500, max: 20000, step: 10, def: 9000, unit: ' Hz', log: true },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'output', label: 'Output', min: -30, max: 12, step: 0.5, def: -6, unit: ' dB' },
  ];
  init() { this.lpL = 0; this.lpR = 0; this.update(); }
  update() {
    this.dg = dbToLin(this.p.drive);
    this.out = dbToLin(this.p.output);
    this.k = 1 - Math.exp((-TAU * Math.min(this.p.tone, this.sr * 0.45)) / this.sr);
  }
  process(L, R, n) {
    const { dg, out, k } = this; const mix = this.p.mix;
    let a = this.lpL, b = this.lpR;
    for (let i = 0; i < n; i++) {
      const x = L[i], y = R[i];
      a += k * (Math.tanh(x * dg) - a);
      b += k * (Math.tanh(y * dg) - b);
      L[i] = x * (1 - mix) + a * out * mix;
      R[i] = y * (1 - mix) + b * out * mix;
    }
    this.lpL = a; this.lpR = b;
  }
}
register('saturation', Saturation);

class HardClip extends FX {
  static label = 'Hard clip';
  static group = 'Distortion';
  static desc = 'Chops the waveform flat at a threshold for a harsh, buzzy distortion.';
  static params = [
    { key: 'drive', label: 'Drive', min: 0, max: 40, step: 0.5, def: 12, unit: ' dB' },
    { key: 'threshold', label: 'Clip level', min: 0.05, max: 1, step: 0.01, def: 0.4 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'output', label: 'Output', min: -24, max: 12, step: 0.5, def: 0, unit: ' dB' },
  ];
  update() { this.dg = dbToLin(this.p.drive); this.out = dbToLin(this.p.output); }
  process(L, R, n) {
    const t = this.p.threshold, mix = this.p.mix, dg = this.dg, out = this.out;
    for (let i = 0; i < n; i++) {
      const x = L[i], y = R[i];
      L[i] = x * (1 - mix) + clamp(x * dg, -t, t) * out * mix;
      R[i] = y * (1 - mix) + clamp(y * dg, -t, t) * out * mix;
    }
  }
}
register('hardclip', HardClip);

class Wavefolder extends FX {
  static label = 'Wavefolder';
  static group = 'Distortion';
  static desc = 'Folds the waveform back on itself, adding metallic harmonics.';
  static params = [
    { key: 'fold', label: 'Fold', min: 1, max: 20, step: 0.1, def: 3 },
    { key: 'offset', label: 'Asymmetry', min: -0.5, max: 0.5, step: 0.01, def: 0.1 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'output', label: 'Output', min: -30, max: 6, step: 0.5, def: -6, unit: ' dB' },
  ];
  init() { this.xl = 0; this.yl = 0; this.xr = 0; this.yr = 0; this.update(); }
  update() { this.out = dbToLin(this.p.output); }
  process(L, R, n) {
    const { fold, offset, mix } = this.p, out = this.out;
    let xl = this.xl, yl = this.yl, xr = this.xr, yr = this.yr;
    const q = TAU / 4, s = 2 / Math.PI;
    for (let i = 0; i < n; i++) {
      const x = L[i], y = R[i];
      const fl = Math.asin(Math.sin((x * fold + offset * fold) * q)) * s;
      const fr = Math.asin(Math.sin((y * fold + offset * fold) * q)) * s;
      // DC blocker: the asymmetry control would otherwise add an offset.
      yl = fl - xl + 0.995 * yl; xl = fl;
      yr = fr - xr + 0.995 * yr; xr = fr;
      L[i] = x * (1 - mix) + yl * out * mix;
      R[i] = y * (1 - mix) + yr * out * mix;
    }
    this.xl = xl; this.yl = yl; this.xr = xr; this.yr = yr;
  }
}
register('wavefolder', Wavefolder);

class Bitcrusher extends FX {
  static label = 'Bitcrusher';
  static group = 'Distortion';
  static desc = 'Lowers bit depth and sample rate for a crunchy digital grit.';
  static params = [
    { key: 'bits', label: 'Bit depth', min: 1, max: 16, step: 1, def: 8, unit: ' bit', int: true },
    { key: 'down', label: 'Sample-rate divide', min: 1, max: 64, step: 0.5, def: 4, unit: 'x' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() { this.c = 0; this.hl = 0; this.hr = 0; this.update(); }
  update() { this.q = Math.pow(2, Math.round(this.p.bits) - 1); }
  process(L, R, n) {
    const q = this.q, down = this.p.down, mix = this.p.mix;
    let c = this.c, hl = this.hl, hr = this.hr;
    for (let i = 0; i < n; i++) {
      c += 1;
      if (c >= down) { c -= down; hl = Math.round(L[i] * q) / q; hr = Math.round(R[i] * q) / q; }
      L[i] = L[i] * (1 - mix) + hl * mix;
      R[i] = R[i] * (1 - mix) + hr * mix;
    }
    this.c = c; this.hl = hl; this.hr = hr;
  }
}
register('bitcrusher', Bitcrusher);
