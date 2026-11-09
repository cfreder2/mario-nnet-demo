// NES sound out through an AudioWorklet ring buffer.
//
// Browsers only start audio after a key press or click. On a kiosk, launch
// Chrome with --autoplay-policy=no-user-gesture-required (start-kiosk.command
// does) and the sound starts on its own. Gamepad presses do not count as a
// gesture in Chrome, so without that flag the first keyboard press unlocks it.

const WORKLET = `
class NesOut extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(32768);
    this.r = 0; this.w = 0; this.n = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      for (let i = 0; i < d.length; i++) {
        if (this.n === this.buf.length) { this.r = (this.r + 1) % this.buf.length; this.n--; }
        this.buf[this.w] = d[i]; this.w = (this.w + 1) % this.buf.length; this.n++;
      }
      // keep latency bounded: drop the oldest audio beyond ~120 ms
      const max = Math.floor(sampleRate * 0.12);
      while (this.n > max) { this.r = (this.r + 1) % this.buf.length; this.n--; }
    };
    this.tick = 0;
  }
  process(_, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.n > 0) { out[i] = this.buf[this.r]; this.r = (this.r + 1) % this.buf.length; this.n--; }
      else out[i] = 0;
    }
    if ((this.tick++ & 15) === 0) this.port.postMessage(this.n);
    return true;
  }
}
registerProcessor('nes-out', NesOut);
`;

export class NesAudio {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.sampleRate = this.ctx.sampleRate;
    this.node = null;
    this.gain = null;
    this.pending = [];
    this.chunk = new Float32Array(4096);
    this.len = 0;
    this.fill = 0; // samples queued in the worklet
    this.muted = false;
    this.ready = this.#init();
    const unlock = () => this.resume();
    addEventListener('keydown', unlock);
    addEventListener('pointerup', unlock);
    addEventListener('touchend', unlock);
  }

  async #init() {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    this.node = new AudioWorkletNode(this.ctx, 'nes-out', { outputChannelCount: [1] });
    this.node.port.onmessage = (e) => (this.fill = e.data);
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.7;
    this.node.connect(this.gain).connect(this.ctx.destination);
    this.resume();
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  /** jsnes onAudioSample callback (stereo in, mono out). */
  sample = (l, r) => {
    if (this.len < this.chunk.length) this.chunk[this.len++] = (l + r) * 0.5;
  };

  /** Call once per emulated frame. */
  flush() {
    if (!this.node || this.len === 0) { this.len = 0; return; }
    const out = this.chunk.slice(0, this.len);
    this.len = 0;
    if (this.muted || this.ctx.state !== 'running') return;
    this.node.port.postMessage(out, [out.buffer]);
  }

  setMuted(m) {
    this.muted = m;
  }

  /** How far the queue is from ~3 frames' worth: positive = too full. */
  drift() {
    if (!this.node || this.muted || this.ctx.state !== 'running') return 0;
    return this.fill - this.sampleRate * 0.05;
  }
}
