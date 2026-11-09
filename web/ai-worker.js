// One emulator per worker. Visible workers draw to an OffscreenCanvas and
// advance a few frames per "tick" from the page; hidden workers evaluate a
// genome start to finish as fast as the CPU allows.

import { createNES, playerCentre } from './shared/smb.js';
import { Trial, makeStartState } from './shared/trial.js';

let nes, start, trial = null, job = 0, think = 5, extras = false, timeWeight = 0.5;
let ctx = null, img = null, u32 = null, frameBuf = null;

onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'init') {
    nes = createNES({ onFrame: (b) => (frameBuf = b) });
    start = makeStartState(nes, msg.rom);
    think = msg.think || 5;
    extras = !!msg.extras;
    timeWeight = msg.timeWeight ?? 0.5;
    if (msg.canvas) {
      ctx = msg.canvas.getContext('2d');
      img = ctx.createImageData(256, 240);
      u32 = new Uint32Array(img.data.buffer);
    }
    postMessage({ type: 'ready' });
  } else if (msg.cmd === 'eval') {
    const r = new Trial(nes, start, msg.genome, { thinkEvery: think, extras, timeWeight }).runToEnd();
    postMessage({ type: 'result', result: r });
  } else if (msg.cmd === 'run') {
    trial = new Trial(nes, start, msg.genome, { thinkEvery: think, extras, timeWeight });
    job = msg.job;
    draw();
  } else if (msg.cmd === 'tick') {
    if (!trial || msg.job !== job) return postMessage({ type: 'tick', idle: true });
    let done = false;
    for (let i = 0; i < msg.frames && !done; i++) done = trial.step();
    draw();
    const p = playerCentre(trial.mem);
    postMessage({
      type: 'tick',
      job,
      progress: trial.progress,
      frames: trial.frames,
      view: msg.wantView ? Array.from(trial.view) : null,
      outputs: Array.from(trial.outputs),
      player: p,
      done,
      result: done ? trial.result() : null,
    });
    if (done) trial = null;
  }
};

function draw() {
  if (!ctx || !frameBuf) return;
  for (let i = 0; i < 256 * 240; i++) u32[i] = 0xff000000 | frameBuf[i];
  // rows 32..231: the playfield without SMB's score/timer bar, which means nothing here
  ctx.putImageData(img, 0, -32, 0, 32, 256, 200);
}
