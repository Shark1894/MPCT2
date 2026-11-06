// Offline speech recognition for hands-free training in browsers without a built-in recogniser
// (Firefox): Vosk compiled to WebAssembly (web/vendor/vosk, Lichess's fork of vosk-browser),
// running in a worker, restricted to chess words. The model (about 30 MB) is fetched from the
// server the first time and kept in the browser's storage (IndexedDB) after that.
//
// Same interface as the built-in listener in handsfree.js: listen(), stop(), running,
// available, and the onHeard / onState callbacks.

import { api } from './api.js';
import { VOSK_WORDS } from './speech-core.js';

const vendor = (file) => new URL(`../vendor/vosk/${file}`, import.meta.url).href;

export class VoskListener {
  constructor(onHeard, onState) {
    this.onHeard = onHeard; // (alternatives[]) => void
    this.onState = onState; // ('loading'|'listening'|'idle'|'blocked'|'error', message?) => void
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.available = Boolean(window.WebAssembly && window.Worker && navigator.mediaDevices?.getUserMedia && Ctx);
    this.want = false;
    this.ready = false;
    this.loading = null; // promise while starting
    this.fed = false; // audio sent since the last result
    this.skip = 0; // flushed results to ignore
    this.failed = null;
  }

  get running() {
    return this.want && this.ready;
  }

  listen() {
    if (!this.available) return;
    if (this.failed) {
      this.onState('error', this.failed); // can't work here (no model, microphone refused): say so again
      return;
    }
    this.want = true;
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this.onState('listening');
      return;
    }
    this.loading ??= this._start();
  }

  stop() {
    const was = this.want;
    this.want = false;
    if (was && this.ready && this.fed) {
      this.skip += 1; // what was said so far comes back as a result: not wanted
      this.recognizer.retrieveFinalResult();
      this.fed = false;
    }
    if (was) this.onState('idle');
  }

  /** Let go of the microphone (hands-free switched off). The model stays loaded. */
  release() {
    this.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.recognizer?.remove();
    Object.assign(this, { stream: null, node: null, ctx: null, recognizer: null, ready: false, loading: null });
  }

  async _start() {
    this.onState('loading');
    try {
      if (!this.client) {
        const { model_url: modelUrl } = await api.voice();
        if (!modelUrl) throw Object.assign(new Error('The offline speech model isn’t installed on the server (rebuild the image with internet access). Type your moves meanwhile.'), { fatal: true });
        const { createVoskClient } = await import('../vendor/vosk/vosk.wasm.js');
        this.client = await createVoskClient({ modelUrl, workerUrl: vendor('vosk.worker.js'), wasmUrl: vendor('vosk.wasm'), logLevel: -1 });
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.recognizer = new this.client.KaldiRecognizer(this.ctx.sampleRate, JSON.stringify(VOSK_WORDS));
      this.recognizer.on('result', (m) => this._result(m?.result?.text ?? ''));
      this.recognizer.on('error', (m) => this.onState('error', `Speech recognition failed: ${m?.error ?? 'unknown error'}`));
      // ScriptProcessor works everywhere (AudioWorklet would need another file); audio is only
      // passed on while listening, so the app never hears itself speak.
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = (e) => {
        if (!this.want) return;
        this.fed = true;
        this.recognizer.acceptWaveform(e.inputBuffer);
      };
      this.ctx.createMediaStreamSource(this.stream).connect(this.node);
      this.node.connect(this.ctx.destination); // silent: the output buffer is left empty
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      this.ready = true;
      this.loading = null;
      if (this.want) this.onState('listening');
      else this.onState('idle');
    } catch (err) {
      this.loading = null;
      const blocked = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      const message = blocked
        ? 'Microphone not allowed: allow it for this site, or type your moves.'
        : err?.name === 'NotFoundError'
          ? 'No microphone found. Type your moves.'
          : err?.message || 'Couldn’t start offline speech recognition. Type your moves.';
      if (blocked || err?.fatal || err?.name === 'NotFoundError') this.failed = message;
      this.want = false;
      this.onState(blocked ? 'blocked' : 'error', message);
    }
  }

  _result(text) {
    this.fed = false;
    if (this.skip > 0) {
      this.skip -= 1;
      return;
    }
    const t = text.replace(/\[unk\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!this.want || !t) return;
    this.want = false;
    this.onState('idle');
    this.onHeard([t]);
  }
}
