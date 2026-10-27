import { FX, register, DelayLine, clamp, TAU } from './core.js';

class Tremolo extends FX {
  static label = 'Tremolo';
  static group = 'Modulation';
  static desc = 'Wobbles the volume. Shape morphs from smooth to chopped.';
  static params = [
    { key: 'rate', label: 'Rate', min: 0.1, max: 20, step: 0.01, def: 6, unit: ' Hz', log: true },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.9 },
    { key: 'shape', label: 'Shape (smooth to square)', min: 0, max: 1, step: 0.01, def: 0.35 },
    { key: 'stereo', label: 'Stereo offset', min: 0, max: 1, step: 0.01, def: 0 },
  ];
  init() { this.ph = 0; this.update(); }
  process(L, R, n) {
    const { rate, depth, shape, stereo } = this.p;
    let ph = this.ph;
    const inc = rate / this.sr;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      const s1 = Math.sin(TAU * ph);
      const s2 = Math.sin(TAU * (ph + stereo * 0.5));
      const l = s1 * (1 - shape) + Math.tanh(s1 * 8) * shape;
      const r = s2 * (1 - shape) + Math.tanh(s2 * 8) * shape;
      L[i] *= 1 - depth * (0.5 - 0.5 * l);
      R[i] *= 1 - depth * (0.5 - 0.5 * r);
    }
    this.ph = ph;
  }
}
register('tremolo', Tremolo);

class Chorus extends FX {
  static label = 'Chorus';
  static group = 'Modulation';
  static desc = 'Three slowly modulated delay taps per side for thickening.';
  static params = [
    { key: 'rate', label: 'Rate', min: 0.05, max: 5, step: 0.01, def: 0.6, unit: ' Hz', log: true },
    { key: 'depth', label: 'Depth', min: 0, max: 10, step: 0.1, def: 6, unit: ' ms' },
    { key: 'delay', label: 'Base delay', min: 5, max: 40, step: 0.5, def: 22, unit: ' ms' },
    { key: 'spread', label: 'Stereo spread', min: 0, max: 1, step: 0.01, def: 0.8 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.6 },
  ];
  init() {
    this.dl = new DelayLine(this.sr * 0.07); this.dr = new DelayLine(this.sr * 0.07);
    this.ph = 0; this.update();
  }
  process(L, R, n) {
    const { rate, depth, delay, spread, mix } = this.p;
    const sr = this.sr, ms = 0.001 * sr;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      ph += rate / sr; if (ph >= 1) ph -= 1;
      this.dl.push(L[i]); this.dr.push(R[i]);
      let wl = 0, wr = 0;
      for (let v = 0; v < 3; v++) {
        wl += this.dl.tap((delay + depth * Math.sin(TAU * (ph + v / 3))) * ms);
        wr += this.dr.tap((delay + depth * Math.sin(TAU * (ph + v / 3 + spread * 0.25))) * ms);
      }
      L[i] = L[i] * (1 - mix) + (wl / 3) * mix;
      R[i] = R[i] * (1 - mix) + (wr / 3) * mix;
    }
    this.ph = ph;
  }
}
register('chorus', Chorus);

class Flanger extends FX {
  static label = 'Flanger';
  static group = 'Modulation';
  static desc = 'Short swept delay with feedback for jet-like comb sweeps.';
  static params = [
    { key: 'rate', label: 'Rate', min: 0.02, max: 5, step: 0.01, def: 0.25, unit: ' Hz', log: true },
    { key: 'depth', label: 'Depth', min: 0, max: 5, step: 0.05, def: 3.5, unit: ' ms' },
    { key: 'delay', label: 'Base delay', min: 0.2, max: 10, step: 0.05, def: 1, unit: ' ms' },
    { key: 'feedback', label: 'Feedback', min: -0.95, max: 0.95, step: 0.01, def: 0.7 },
    { key: 'spread', label: 'Stereo spread', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.5 },
  ];
  init() {
    this.dl = new DelayLine(this.sr * 0.03); this.dr = new DelayLine(this.sr * 0.03);
    this.ph = 0; this.update();
  }
  process(L, R, n) {
    const { rate, depth, delay, feedback, spread, mix } = this.p;
    const sr = this.sr, ms = 0.001 * sr;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      ph += rate / sr; if (ph >= 1) ph -= 1;
      const wl = this.dl.tap((delay + depth * (0.5 + 0.5 * Math.sin(TAU * ph))) * ms);
      const wr = this.dr.tap((delay + depth * (0.5 + 0.5 * Math.sin(TAU * (ph + spread * 0.5)))) * ms);
      this.dl.push(L[i] + feedback * wl);
      this.dr.push(R[i] + feedback * wr);
      L[i] = L[i] * (1 - mix) + wl * mix;
      R[i] = R[i] * (1 - mix) + wr * mix;
    }
    this.ph = ph;
  }
}
register('flanger', Flanger);

class Phaser extends FX {
  static label = 'Phaser';
  static group = 'Modulation';
  static desc = 'A chain of all-pass filters swept to create moving notches.';
  static params = [
    { key: 'rate', label: 'Rate', min: 0.02, max: 8, step: 0.01, def: 0.5, unit: ' Hz', log: true },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'center', label: 'Center frequency', min: 100, max: 4000, step: 1, def: 700, unit: ' Hz', log: true },
    { key: 'stages', label: 'Stages', min: 2, max: 12, step: 2, def: 6, int: true },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, def: 0.65 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() {
    this.zl = new Float64Array(12); this.zr = new Float64Array(12);
    this.fl = 0; this.fr = 0; this.ph = 0; this.cnt = 0; this.a = 0;
    this.update();
  }
  process(L, R, n) {
    const { rate, depth, center, feedback, mix } = this.p;
    const st = Math.round(this.p.stages);
    const sr = this.sr, zl = this.zl, zr = this.zr;
    let ph = this.ph, a = this.a, fl = this.fl, fr = this.fr;
    for (let i = 0; i < n; i++) {
      ph += rate / sr; if (ph >= 1) ph -= 1;
      if ((this.cnt++ & 3) === 0) {
        const f = clamp(center * Math.pow(2, depth * 2 * Math.sin(TAU * ph)), 20, sr * 0.45);
        const t = Math.tan((Math.PI * f) / sr);
        a = (t - 1) / (t + 1);
      }
      let xl = L[i] + feedback * fl, xr = R[i] + feedback * fr;
      for (let s = 0; s < st; s++) {
        let y = a * xl + zl[s]; zl[s] = xl - a * y; xl = y;
        y = a * xr + zr[s]; zr[s] = xr - a * y; xr = y;
      }
      fl = xl; fr = xr;
      L[i] = L[i] * (1 - mix * 0.5) + xl * mix * 0.5;
      R[i] = R[i] * (1 - mix * 0.5) + xr * mix * 0.5;
    }
    this.ph = ph; this.a = a; this.fl = fl; this.fr = fr;
  }
}
register('phaser', Phaser);

class Vibrato extends FX {
  static label = 'Vibrato';
  static group = 'Modulation';
  static desc = 'Pitch wobble from a modulated delay.';
  static params = [
    { key: 'rate', label: 'Rate', min: 0.1, max: 14, step: 0.01, def: 5.5, unit: ' Hz', log: true },
    { key: 'depth', label: 'Depth', min: 0, max: 5, step: 0.05, def: 2.2, unit: ' ms' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() {
    this.dl = new DelayLine(this.sr * 0.02); this.dr = new DelayLine(this.sr * 0.02);
    this.ph = 0; this.update();
  }
  process(L, R, n) {
    const { rate, depth, mix } = this.p;
    const sr = this.sr, ms = 0.001 * sr;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      ph += rate / sr; if (ph >= 1) ph -= 1;
      this.dl.push(L[i]); this.dr.push(R[i]);
      const d = (depth + depth * Math.sin(TAU * ph)) * ms + 2;
      L[i] = L[i] * (1 - mix) + this.dl.tap(d) * mix;
      R[i] = R[i] * (1 - mix) + this.dr.tap(d) * mix;
    }
    this.ph = ph;
  }
}
register('vibrato', Vibrato);

class TapeWobble extends FX {
  static label = 'Tape wobble';
  static group = 'Modulation';
  static desc = 'Slow wow and fast flutter with a random drift, like an unstable tape transport.';
  static params = [
    { key: 'wow', label: 'Wow depth', min: 0, max: 6, step: 0.05, def: 3, unit: ' ms' },
    { key: 'wowRate', label: 'Wow rate', min: 0.1, max: 2, step: 0.01, def: 0.5, unit: ' Hz', log: true },
    { key: 'flutter', label: 'Flutter depth', min: 0, max: 1, step: 0.01, def: 0.5, unit: ' ms' },
    { key: 'flutterRate', label: 'Flutter rate', min: 3, max: 20, step: 0.1, def: 9, unit: ' Hz', log: true },
    { key: 'random', label: 'Randomness', min: 0, max: 1, step: 0.01, def: 0.6 },
  ];
  init() {
    this.dl = new DelayLine(this.sr * 0.03); this.dr = new DelayLine(this.sr * 0.03);
    this.p1 = 0; this.p2 = 0; this.n1 = 0; this.n2 = 0; this.update();
  }
  process(L, R, n) {
    const { wow, wowRate, flutter, flutterRate, random } = this.p;
    const sr = this.sr, ms = 0.001 * sr;
    const k1 = TAU * wowRate / sr, k2 = TAU * flutterRate / sr;
    // Filtered noise is scaled back up to roughly unit amplitude.
    const g1 = 1 / (0.577 * Math.sqrt(k1 / 2)), g2 = 1 / (0.577 * Math.sqrt(k2 / 2));
    let { p1, p2, n1, n2 } = this;
    for (let i = 0; i < n; i++) {
      p1 += wowRate / sr; if (p1 >= 1) p1 -= 1;
      p2 += flutterRate / sr; if (p2 >= 1) p2 -= 1;
      n1 += k1 * (Math.random() * 2 - 1 - n1);
      n2 += k2 * (Math.random() * 2 - 1 - n2);
      const l1 = Math.sin(TAU * p1) * (1 - random) + clamp(n1 * g1, -1.5, 1.5) * random;
      const l2 = Math.sin(TAU * p2) * (1 - random) + clamp(n2 * g2, -1.5, 1.5) * random;
      const d = (wow * (1 + l1) + flutter * (1 + l2)) * ms + 2;
      this.dl.push(L[i]); this.dr.push(R[i]);
      L[i] = this.dl.tap(d);
      R[i] = this.dr.tap(d);
    }
    this.p1 = p1; this.p2 = p2; this.n1 = n1; this.n2 = n2;
  }
}
register('tape', TapeWobble);
