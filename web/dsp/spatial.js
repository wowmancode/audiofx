import { FX, register, Biquad, clamp, dbToLin, TAU } from './core.js';

class StereoWidth extends FX {
  static label = 'Stereo width';
  static group = 'Stereo & texture';
  static desc = 'Narrows toward mono or widens using mid/side processing.';
  static params = [
    { key: 'width', label: 'Width', min: 0, max: 2, step: 0.01, def: 1.4 },
    { key: 'mid', label: 'Center level', min: -12, max: 12, step: 0.1, def: 0, unit: ' dB' },
  ];
  update() { this.mg = dbToLin(this.p.mid); }
  process(L, R, n) {
    const w = this.p.width, mg = this.mg;
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5 * mg, s = (L[i] - R[i]) * 0.5 * w;
      L[i] = m + s; R[i] = m - s;
    }
  }
}
register('width', StereoWidth);

class Autopan extends FX {
  static label = 'Auto-pan';
  static group = 'Stereo & texture';
  static desc = 'Sweeps the sound between left and right.';
  static params = [
    { key: 'rate', label: 'Rate', min: 0.05, max: 10, step: 0.01, def: 1, unit: ' Hz', log: true },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.8 },
    { key: 'shape', label: 'Shape (smooth to square)', min: 0, max: 1, step: 0.01, def: 0 },
  ];
  init() { this.ph = 0; this.update(); }
  process(L, R, n) {
    const { rate, depth, shape } = this.p;
    const inc = rate / this.sr;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const s = Math.sin(TAU * ph);
      const lfo = (s * (1 - shape) + Math.tanh(s * 6) * shape) * depth;
      const a = (lfo + 1) * Math.PI * 0.25;
      L[i] *= Math.cos(a) * Math.SQRT2;
      R[i] *= Math.sin(a) * Math.SQRT2;
    }
    this.ph = ph;
  }
}
register('autopan', Autopan);

class Pan extends FX {
  static label = 'Pan';
  static group = 'Stereo & texture';
  static desc = 'Fixed left/right position with constant-power balance.';
  static params = [
    { key: 'pan', label: 'Position', min: -1, max: 1, step: 0.01, def: 0 },
  ];
  init() { this.cur = this.p.pan; this.update(); }
  process(L, R, n) {
    const target = this.p.pan;
    let c = this.cur;
    const step = (target - c) / n;
    for (let i = 0; i < n; i++) {
      c += step;
      const a = (c + 1) * Math.PI * 0.25;
      L[i] *= Math.cos(a) * Math.SQRT2;
      R[i] *= Math.sin(a) * Math.SQRT2;
    }
    this.cur = target;
  }
}
register('pan', Pan);

class NoiseLayer extends FX {
  static label = 'Noise & crackle';
  static group = 'Stereo & texture';
  static desc = 'Adds a bed of hiss, optionally colored, plus random clicks.';
  static params = [
    { key: 'level', label: 'Hiss level', min: -80, max: 0, step: 0.5, def: -42, unit: ' dB' },
    { key: 'color', label: 'Hiss low-pass', min: 200, max: 20000, step: 10, def: 20000, unit: ' Hz', log: true },
    { key: 'crackle', label: 'Crackle density', min: 0, max: 60, step: 0.5, def: 0, unit: ' /s' },
    { key: 'clickLevel', label: 'Crackle level', min: -50, max: 0, step: 0.5, def: -24, unit: ' dB' },
  ];
  init() { this.lpL = new Biquad(); this.lpR = new Biquad(); this.update(); }
  update() {
    this.g = dbToLin(this.p.level);
    this.cg = dbToLin(this.p.clickLevel);
    this.lpL.set('lp', clamp(this.p.color, 200, this.sr * 0.45), 0.707, 0, this.sr);
    this.lpR.copyFrom(this.lpL);
  }
  process(L, R, n) {
    const g = this.g, cg = this.cg;
    const prob = this.p.crackle / this.sr;
    const filt = this.p.color < 19000;
    for (let i = 0; i < n; i++) {
      let nl = Math.random() * 2 - 1, nr = Math.random() * 2 - 1;
      if (filt) { nl = this.lpL.run(nl) * 1.6; nr = this.lpR.run(nr) * 1.6; }
      let cl = 0, cr = 0;
      if (prob > 0 && Math.random() < prob) {
        const v = (Math.random() * 2 - 1) * cg;
        cl = v; cr = v * (0.6 + Math.random() * 0.4);
      }
      L[i] += nl * g + cl; R[i] += nr * g + cr;
    }
  }
}
register('noise', NoiseLayer);
