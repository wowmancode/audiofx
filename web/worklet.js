// AudioWorklet host: runs the user's effect chain in real time.
import { createEffect } from './dsp/index.js';

class FxChain extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chain = [];          // [{ id, kind, params, bypass, fx }]
    this.master = 0.8;
    this.input = 1;
    // Auto level: a slow gain rider that holds the input near -20 dBFS RMS so
    // compressors, gates and distortions respond the same for a quiet phone
    // mic as for a loud file. It holds still when the input is near silent,
    // so room noise is not pumped up.
    this.auto = true;
    this.agcGain = 1;
    this.agcPow = 0;
    this.agcAtk = 1 - Math.exp(-1 / (0.03 * sampleRate));
    this.agcRel = 1 - Math.exp(-1 / (0.4 * sampleRate));
    this.agcDown = 1 - Math.exp(-1 / (0.02 * sampleRate));
    this.agcUp = 1 - Math.exp(-1 / (0.5 * sampleRate));
    this.L = new Float32Array(128);
    this.R = new Float32Array(128);
    this.blocks = 0;
    this.peak = 0;
    this.clipped = false;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  build(item) {
    item.fx = createEffect(item.kind, sampleRate, item.params);
    if (item.kind === 'custom') {
      item.fx.onError = (message) => this.port.postMessage({ type: 'error', id: item.id, message });
      // code === false means the app could not verify the code, so the
      // effect stays out of the way until it is fixed.
      if (item.code === false) item.fx.disable();
      else if (typeof item.code === 'string') item.fx.setCode(item.code);
    }
    return item;
  }

  onMessage(m) {
    switch (m.type) {
      case 'init':
        this.chain = m.chain.map((c) => this.build({ ...c, params: { ...c.params } }));
        break;
      case 'add':
        this.chain.push(this.build({ ...m.item, params: { ...m.item.params } }));
        break;
      case 'remove':
        this.chain = this.chain.filter((c) => c.id !== m.id);
        break;
      case 'order': {
        const byId = new Map(this.chain.map((c) => [c.id, c]));
        this.chain = m.ids.map((id) => byId.get(id)).filter(Boolean);
        break;
      }
      case 'set': {
        const c = this.chain.find((x) => x.id === m.id);
        if (c) { c.params[m.key] = m.value; c.fx.set(m.key, m.value); }
        break;
      }
      case 'bypass': {
        const c = this.chain.find((x) => x.id === m.id);
        if (c) c.bypass = m.value;
        break;
      }
      case 'code': {
        const c = this.chain.find((x) => x.id === m.id);
        if (c && c.fx.setCode) { c.code = m.code; c.fx.setCode(m.code); }
        break;
      }
      case 'notes': {
        const c = this.chain.find((x) => x.id === m.id);
        if (c && c.fx.setNotes) c.fx.setNotes(m.notes);
        break;
      }
      case 'master': this.master = m.value; break;
      case 'input': this.input = m.value; break;
      case 'auto': this.auto = !!m.value; break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    if (this.L.length !== n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
    const L = this.L, R = this.R;
    const inp = inputs[0];
    const g = this.input;
    if (inp && inp.length) {
      const a = inp[0], b = inp[1] || inp[0];
      for (let i = 0; i < n; i++) { L[i] = a[i] * g; R[i] = b[i] * g; }
    } else {
      L.fill(0); R.fill(0);
    }

    if (this.auto) {
      let gain = this.agcGain, pw = this.agcPow;
      for (let i = 0; i < n; i++) {
        const p = (L[i] * L[i] + R[i] * R[i]) * 0.5;
        pw += (p > pw ? this.agcAtk : this.agcRel) * (p - pw);
        const rms = Math.sqrt(pw);
        if (rms > 0.004) {
          let want = 0.1 / rms;
          if (want > 32) want = 32; else if (want < 0.05) want = 0.05;
          gain += (want - gain) * (want < gain ? this.agcDown : this.agcUp);
        }
        L[i] *= gain; R[i] *= gain;
      }
      this.agcGain = gain; this.agcPow = pw;
    }

    for (const c of this.chain) {
      if (c.bypass) continue;
      c.fx.process(L, R, n);
      // Safety net: if an effect ever produces NaN/Infinity, rebuild it.
      let bad = false;
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        if (!(l - l === 0) || !(r - r === 0)) { bad = true; break; }
      }
      if (bad) {
        L.fill(0); R.fill(0);
        this.build(c);
      }
    }

    const mg = this.master;
    let pk = 0;
    const oL = out[0], oR = out[1] || out[0];
    for (let i = 0; i < n; i++) {
      let l = L[i] * mg, r = R[i] * mg;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pk) pk = al;
      if (ar > pk) pk = ar;
      if (l > 1) l = 1; else if (l < -1) l = -1;
      if (r > 1) r = 1; else if (r < -1) r = -1;
      oL[i] = l; oR[i] = r;
    }
    if (pk > this.peak) this.peak = pk;
    if (pk > 1) this.clipped = true;
    if (++this.blocks % 8 === 0) {
      this.port.postMessage({ type: 'meter', peak: this.peak, clip: this.clipped });
      this.peak = 0; this.clipped = false;
    }
    return true;
  }
}

registerProcessor('fx-chain', FxChain);
