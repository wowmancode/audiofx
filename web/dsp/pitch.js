import { FX, register, DelayLine, clamp, TAU } from './core.js';

// Two-tap windowed delay-line pitch shifter. Used for pitch shift,
// harmonizer and reverse (ratio = -1 reads the buffer backwards).
class Grain {
  constructor(sr, maxMs) {
    this.sr = sr;
    this.maxW = Math.floor(sr * maxMs * 0.001);
    this.dl = new DelayLine(this.maxW + 16);
    this.phase = 0;
    this.W = 1024;
  }
  setWindow(ms) { this.W = clamp(Math.round(ms * 0.001 * this.sr), 64, this.maxW); }
  run(x, ratio) {
    this.dl.push(x);
    const p1 = this.phase;
    let p2 = p1 + 0.5; if (p2 >= 1) p2 -= 1;
    const W = this.W;
    const y = this.dl.tap(p1 * W + 1) * (0.5 - 0.5 * Math.cos(TAU * p1))
            + this.dl.tap(p2 * W + 1) * (0.5 - 0.5 * Math.cos(TAU * p2));
    this.phase += (1 - ratio) / W;
    if (this.phase >= 1) this.phase -= 1; else if (this.phase < 0) this.phase += 1;
    return y;
  }
}

class PitchShifter extends FX {
  static label = 'Pitch shifter';
  static group = 'Pitch & frequency';
  static desc = 'Shifts pitch up or down without changing speed.';
  static params = [
    { key: 'semi', label: 'Shift', min: -24, max: 24, step: 0.01, def: 4, unit: ' semitones' },
    { key: 'grain', label: 'Window size', min: 20, max: 200, step: 1, def: 60, unit: ' ms' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() { this.gl = new Grain(this.sr, 220); this.gr = new Grain(this.sr, 220); this.update(); }
  update() {
    this.ratio = Math.pow(2, this.p.semi / 12);
    this.gl.setWindow(this.p.grain); this.gr.setWindow(this.p.grain);
  }
  process(L, R, n) {
    const mix = this.p.mix, r = this.ratio;
    for (let i = 0; i < n; i++) {
      const wl = this.gl.run(L[i], r), wr = this.gr.run(R[i], r);
      L[i] = L[i] * (1 - mix) + wl * mix;
      R[i] = R[i] * (1 - mix) + wr * mix;
    }
  }
}
register('pitch', PitchShifter);

class Harmonizer extends FX {
  static label = 'Harmonizer';
  static group = 'Pitch & frequency';
  static desc = 'Two independently pitch-shifted voices mixed with the original.';
  static params = [
    { key: 'semi1', label: 'Voice 1 shift', min: -24, max: 24, step: 0.01, def: 4, unit: ' semitones' },
    { key: 'level1', label: 'Voice 1 level', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'semi2', label: 'Voice 2 shift', min: -24, max: 24, step: 0.01, def: 7, unit: ' semitones' },
    { key: 'level2', label: 'Voice 2 level', min: 0, max: 1, step: 0.01, def: 0.4 },
    { key: 'dry', label: 'Original level', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'grain', label: 'Window size', min: 20, max: 200, step: 1, def: 60, unit: ' ms' },
  ];
  init() {
    this.g = [0, 1, 2, 3].map(() => new Grain(this.sr, 220));
    this.update();
  }
  update() {
    this.r1 = Math.pow(2, this.p.semi1 / 12);
    this.r2 = Math.pow(2, this.p.semi2 / 12);
    for (const g of this.g) g.setWindow(this.p.grain);
  }
  process(L, R, n) {
    const { level1, level2, dry } = this.p;
    const g = this.g, r1 = this.r1, r2 = this.r2;
    for (let i = 0; i < n; i++) {
      const x = L[i], y = R[i];
      L[i] = x * dry + g[0].run(x, r1) * level1 + g[1].run(x, r2) * level2;
      R[i] = y * dry + g[2].run(y, r1) * level1 + g[3].run(y, r2) * level2;
    }
  }
}
register('harmonizer', Harmonizer);

class Reverse extends FX {
  static label = 'Reverse';
  static group = 'Pitch & frequency';
  static desc = 'Plays the audio backwards in short overlapping chunks.';
  static params = [
    { key: 'chunk', label: 'Chunk length', min: 50, max: 1000, step: 1, def: 300, unit: ' ms' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() { this.gl = new Grain(this.sr, 1100); this.gr = new Grain(this.sr, 1100); this.update(); }
  update() { this.gl.setWindow(this.p.chunk); this.gr.setWindow(this.p.chunk); }
  process(L, R, n) {
    const mix = this.p.mix;
    for (let i = 0; i < n; i++) {
      const wl = this.gl.run(L[i], -1), wr = this.gr.run(R[i], -1);
      L[i] = L[i] * (1 - mix) + wl * mix;
      R[i] = R[i] * (1 - mix) + wr * mix;
    }
  }
}
register('reverse', Reverse);

// Hilbert transformer based frequency shifter (single-sideband modulation).
// Unlike pitch shifting this moves every partial by the same number of Hz,
// so harmonics become inharmonic.
const HN = 127;
const HM = (HN - 1) / 2;
const HILBERT = (() => {
  const h = new Float32Array(HN);
  for (let j = 0; j < HN; j++) {
    const m = j - HM;
    if (m % 2 !== 0) {
      const win = 0.42 - 0.5 * Math.cos((TAU * j) / (HN - 1)) + 0.08 * Math.cos((2 * TAU * j) / (HN - 1));
      h[j] = (2 / (Math.PI * m)) * win;
    }
  }
  return h;
})();
const HTAPS = [];
for (let j = 0; j < HN; j++) if (HILBERT[j] !== 0) HTAPS.push(j);

class FreqShifter extends FX {
  static label = 'Frequency shifter';
  static group = 'Pitch & frequency';
  static desc = 'Shifts all frequencies by a fixed number of Hz for bell-like, inharmonic tones.';
  static params = [
    { key: 'shift', label: 'Shift', min: -1000, max: 1000, step: 0.5, def: 50, unit: ' Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.7 },
  ];
  init() {
    this.bl = new Float32Array(HN * 2); this.br = new Float32Array(HN * 2);
    this.pos = 0; this.ph = 0; this.update();
  }
  process(L, R, n) {
    const { shift, mix } = this.p;
    const inc = shift / this.sr;
    const bl = this.bl, br = this.br;
    let pos = this.pos, ph = this.ph;
    for (let i = 0; i < n; i++) {
      // Double-length buffer: write twice so reads never wrap.
      bl[pos] = bl[pos + HN] = L[i];
      br[pos] = br[pos + HN] = R[i];
      // newest sample sits at index pos; sample k steps back is at pos - k
      let il = 0, ir = 0;
      for (let t = 0; t < HTAPS.length; t++) {
        const j = HTAPS[t];
        const ix = pos + HN - j;
        il += HILBERT[j] * bl[ix]; ir += HILBERT[j] * br[ix];
      }
      const rix = pos + HN - HM;
      const rl = bl[rix], rr = br[rix];
      ph += inc; ph -= Math.floor(ph);
      const c = Math.cos(TAU * ph), s = Math.sin(TAU * ph);
      const wl = rl * c - il * s, wr = rr * c - ir * s;
      L[i] = L[i] * (1 - mix) + wl * mix;
      R[i] = R[i] * (1 - mix) + wr * mix;
      if (++pos >= HN) pos = 0;
    }
    this.pos = pos; this.ph = ph;
  }
}
register('freqshift', FreqShifter);

class RingMod extends FX {
  static label = 'Ring modulator';
  static group = 'Pitch & frequency';
  static desc = 'Multiplies the input by an oscillator, producing sum and difference tones.';
  static params = [
    { key: 'freq', label: 'Frequency', min: 1, max: 5000, step: 0.5, def: 200, unit: ' Hz', log: true },
    { key: 'wave', label: 'Oscillator', type: 'select', options: ['Sine', 'Square', 'Triangle', 'Saw'], def: 0 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() { this.ph = 0; this.update(); }
  process(L, R, n) {
    const { freq, mix } = this.p;
    const wave = Math.round(this.p.wave);
    const inc = freq / this.sr;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      ph += inc; if (ph >= 1) ph -= 1;
      let c;
      if (wave === 0) c = Math.sin(TAU * ph);
      else if (wave === 1) c = ph < 0.5 ? 1 : -1;
      else if (wave === 2) c = 4 * Math.abs(ph - 0.5) - 1;
      else c = 2 * ph - 1;
      L[i] = L[i] * (1 - mix) + L[i] * c * mix;
      R[i] = R[i] * (1 - mix) + R[i] * c * mix;
    }
    this.ph = ph;
  }
}
register('ringmod', RingMod);
