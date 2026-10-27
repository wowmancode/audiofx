import { FX, register, DelayLine, clamp, TAU } from './core.js';

class Delay extends FX {
  static label = 'Delay';
  static group = 'Delay & reverb';
  static desc = 'Echo with feedback and a tone control on the repeats.';
  static params = [
    { key: 'time', label: 'Time', min: 1, max: 2000, step: 1, def: 420, unit: ' ms' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, def: 0.5 },
    { key: 'tone', label: 'Repeat tone (low-pass)', min: 500, max: 16000, step: 10, def: 3500, unit: ' Hz', log: true },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.5 },
  ];
  init() {
    this.dl = new DelayLine(this.sr * 2.05); this.dr = new DelayLine(this.sr * 2.05);
    this.fl = 0; this.fr = 0;
    this.ct = this.p.time * 0.001 * this.sr;
    this.update();
  }
  update() {
    this.tt = this.p.time * 0.001 * this.sr;
    this.k = 1 - Math.exp((-TAU * Math.min(this.p.tone, this.sr * 0.45)) / this.sr);
  }
  process(L, R, n) {
    const { feedback: fb, mix } = this.p, k = this.k;
    let { ct, fl, fr } = this;
    for (let i = 0; i < n; i++) {
      ct += (this.tt - ct) * 0.0008;
      const yl = this.dl.tap(ct), yr = this.dr.tap(ct);
      fl += k * (yl - fl); fr += k * (yr - fr);
      this.dl.push(L[i] + fb * fl);
      this.dr.push(R[i] + fb * fr);
      L[i] += yl * mix; R[i] += yr * mix;
    }
    this.ct = ct; this.fl = fl; this.fr = fr;
  }
}
register('delay', Delay);

class PingPong extends FX {
  static label = 'Ping-pong delay';
  static group = 'Delay & reverb';
  static desc = 'Echoes that bounce between the left and right channels.';
  static params = [
    { key: 'time', label: 'Time', min: 20, max: 1500, step: 1, def: 240, unit: ' ms' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.92, step: 0.01, def: 0.6 },
    { key: 'tone', label: 'Repeat tone (low-pass)', min: 500, max: 16000, step: 10, def: 6000, unit: ' Hz', log: true },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.55 },
  ];
  init() {
    this.dl = new DelayLine(this.sr * 1.6); this.dr = new DelayLine(this.sr * 1.6);
    this.fl = 0; this.fr = 0;
    this.ct = this.p.time * 0.001 * this.sr;
    this.update();
  }
  update() {
    this.tt = this.p.time * 0.001 * this.sr;
    this.k = 1 - Math.exp((-TAU * Math.min(this.p.tone, this.sr * 0.45)) / this.sr);
  }
  process(L, R, n) {
    const { feedback: fb, mix } = this.p, k = this.k;
    let { ct, fl, fr } = this;
    for (let i = 0; i < n; i++) {
      ct += (this.tt - ct) * 0.0008;
      const yl = this.dl.tap(ct), yr = this.dr.tap(ct);
      fl += k * (yl - fl); fr += k * (yr - fr);
      const mono = (L[i] + R[i]) * 0.5;
      this.dl.push(mono + fb * fr);
      this.dr.push(fb * fl);
      L[i] += yl * mix; R[i] += yr * mix;
    }
    this.ct = ct; this.fl = fl; this.fr = fr;
  }
}
register('pingpong', PingPong);

// Freeverb-style reverb: 8 parallel damped combs and 4 series all-passes
// per channel, with the right channel slightly detuned for width.
const COMB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS = [556, 441, 341, 225];
const SPREAD = 23;

class Reverb extends FX {
  static label = 'Reverb';
  static group = 'Delay & reverb';
  static desc = 'Room ambience built from parallel combs and all-pass diffusers.';
  static params = [
    { key: 'size', label: 'Room size', min: 0, max: 1, step: 0.01, def: 0.85 },
    { key: 'damp', label: 'Damping', min: 0, max: 1, step: 0.01, def: 0.3 },
    { key: 'predelay', label: 'Pre-delay', min: 0, max: 150, step: 1, def: 25, unit: ' ms' },
    { key: 'width', label: 'Stereo width', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.45 },
  ];
  init() {
    const s = this.sr / 44100;
    const mk = (lens, add) => lens.map((n) => new Float32Array(Math.max(8, Math.round((n + add) * s))));
    this.cbL = mk(COMB, 0); this.cbR = mk(COMB, SPREAD);
    this.abL = mk(ALLPASS, 0); this.abR = mk(ALLPASS, SPREAD);
    this.ciL = new Int32Array(8); this.ciR = new Int32Array(8);
    this.aiL = new Int32Array(4); this.aiR = new Int32Array(4);
    this.fL = new Float32Array(8); this.fR = new Float32Array(8);
    this.pre = new DelayLine(this.sr * 0.16);
    this.update();
  }
  update() {
    this.fb = 0.7 + 0.28 * this.p.size;
    this.d1 = this.p.damp * 0.4;
    this.d2 = 1 - this.d1;
  }
  process(L, R, n) {
    const { predelay, width, mix } = this.p;
    const fb = this.fb, d1 = this.d1, d2 = this.d2;
    const pd = predelay * 0.001 * this.sr;
    const w1 = width / 2 + 0.5, w2 = (1 - width) / 2;
    for (let i = 0; i < n; i++) {
      this.pre.push((L[i] + R[i]) * 0.5);
      const inp = this.pre.tap(pd) * 0.015;
      let oL = 0, oR = 0;
      for (let c = 0; c < 8; c++) {
        let b = this.cbL[c], ix = this.ciL[c];
        let y = b[ix];
        this.fL[c] = y * d2 + this.fL[c] * d1;
        b[ix] = inp + this.fL[c] * fb;
        if (++ix >= b.length) ix = 0;
        this.ciL[c] = ix; oL += y;

        b = this.cbR[c]; ix = this.ciR[c];
        y = b[ix];
        this.fR[c] = y * d2 + this.fR[c] * d1;
        b[ix] = inp + this.fR[c] * fb;
        if (++ix >= b.length) ix = 0;
        this.ciR[c] = ix; oR += y;
      }
      for (let a = 0; a < 4; a++) {
        let b = this.abL[a], ix = this.aiL[a];
        let y = b[ix];
        b[ix] = oL + y * 0.5;
        oL = y - oL;
        if (++ix >= b.length) ix = 0;
        this.aiL[a] = ix;

        b = this.abR[a]; ix = this.aiR[a];
        y = b[ix];
        b[ix] = oR + y * 0.5;
        oR = y - oR;
        if (++ix >= b.length) ix = 0;
        this.aiR[a] = ix;
      }
      const wl = (oL * w1 + oR * w2) * 3, wr = (oR * w1 + oL * w2) * 3;
      L[i] = L[i] * (1 - mix) + wl * mix;
      R[i] = R[i] * (1 - mix) + wr * mix;
    }
  }
}
register('reverb', Reverb);

class CombFilter extends FX {
  static label = 'Comb resonator';
  static group = 'Delay & reverb';
  static desc = 'A very short feedback delay that rings at a pitch you choose.';
  static params = [
    { key: 'freq', label: 'Resonant pitch', min: 40, max: 2000, step: 0.5, def: 180, unit: ' Hz', log: true },
    { key: 'feedback', label: 'Feedback', min: -0.98, max: 0.98, step: 0.01, def: 0.85 },
    { key: 'damp', label: 'Damping', min: 0, max: 0.95, step: 0.01, def: 0.3 },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 0.7 },
  ];
  init() {
    this.dl = new DelayLine(this.sr / 30 + 8); this.dr = new DelayLine(this.sr / 30 + 8);
    this.fl = 0; this.fr = 0; this.update();
  }
  process(L, R, n) {
    const { freq, feedback: fb, damp, mix } = this.p;
    const D = clamp(this.sr / freq, 2, this.sr / 30);
    const comp = 1 - 0.6 * Math.abs(fb);
    let { fl, fr } = this;
    for (let i = 0; i < n; i++) {
      const yl = this.dl.tap(D), yr = this.dr.tap(D);
      fl = yl * (1 - damp) + fl * damp;
      fr = yr * (1 - damp) + fr * damp;
      const vl = L[i] + fb * fl, vr = R[i] + fb * fr;
      this.dl.push(vl); this.dr.push(vr);
      L[i] = L[i] * (1 - mix) + vl * comp * mix;
      R[i] = R[i] * (1 - mix) + vr * comp * mix;
    }
    this.fl = fl; this.fr = fr;
  }
}
register('comb', CombFilter);

class Stutter extends FX {
  static label = 'Stutter';
  static group = 'Delay & reverb';
  static desc = 'Randomly captures a slice of the audio and repeats it a few times.';
  static params = [
    { key: 'length', label: 'Slice length', min: 20, max: 500, step: 1, def: 120, unit: ' ms' },
    { key: 'chance', label: 'Chance per slice', min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: 'repeats', label: 'Max repeats', min: 1, max: 8, step: 1, def: 3, int: true },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, def: 1 },
  ];
  init() {
    this.size = Math.ceil(this.sr * 0.6);
    this.rl = new Float32Array(this.size); this.rr = new Float32Array(this.size);
    this.cl = new Float32Array(this.size); this.cr = new Float32Array(this.size);
    this.w = 0; this.pos = 0; this.reps = 0; this.curLen = 0; this.update();
  }
  process(L, R, n) {
    const { chance, mix } = this.p;
    const len = Math.max(32, Math.round(this.p.length * 0.001 * this.sr));
    const maxRep = Math.round(this.p.repeats);
    const fade = Math.min(Math.round(this.sr * 0.002), len >> 2);
    for (let i = 0; i < n; i++) {
      this.rl[this.w] = L[i]; this.rr[this.w] = R[i];
      this.w = (this.w + 1) % this.size;
      if (this.pos >= (this.reps > 0 ? this.curLen : len)) {
        this.pos = 0;
        if (this.reps > 0) this.reps--;
        else if (Math.random() < chance) {
          this.curLen = len;
          for (let j = 0; j < len; j++) {
            const ix = (this.w - len + j + this.size) % this.size;
            this.cl[j] = this.rl[ix]; this.cr[j] = this.rr[ix];
          }
          this.reps = Math.floor(Math.random() * maxRep) + 1;
        }
      }
      if (this.reps > 0) {
        const j = this.pos;
        const e = Math.min(1, j / fade, (this.curLen - j) / fade);
        const wl = this.cl[j] * e, wr = this.cr[j] * e;
        L[i] = L[i] * (1 - mix) + wl * mix;
        R[i] = R[i] * (1 - mix) + wr * mix;
      }
      this.pos++;
    }
  }
}
register('stutter', Stutter);
