// Web Worker that pre-checks user code before it reaches the audio thread.
// If the code never returns, the page terminates this worker after a timeout.
import { checkCustomCode } from './dsp/custom.js';

self.onmessage = (e) => {
  let result;
  try {
    result = checkCustomCode(e.data.code, e.data.sr || 48000);
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  self.postMessage(result);
};
