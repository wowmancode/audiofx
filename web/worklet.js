// AudioWorklet host: runs the user's effect chain in real time.
import { createEffect } from './dsp/index.js';

class FxChain extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chain = [];          // [{ id, kind, params, bypass, fx }]
    this.master = 0.8;
    this.input = 1;
    this.L = new Float32Array(128);
    this.R = new Float32Array(128);
    this.blocks = 0;
    this.peak = 0;
    this.clipped = false;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  build(item) {
    item.fx = createEffect(item.kind, sampleRate, item.params);
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
      case 'notes': {
        const c = this.chain.find((x) => x.id === m.id);
        if (c && c.fx.setNotes) c.fx.setNotes(m.notes);
        break;
      }
      case 'master': this.master = m.value; break;
      case 'input': this.input = m.value; break;
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
