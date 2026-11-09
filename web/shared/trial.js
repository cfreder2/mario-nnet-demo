// One AI attempt at 1-1: restore the start-of-level savestate, let a NEAT
// network drive the controller, and score the run.
//
// Fitness (MarI/O's): how far right Mario got, minus half a point per frame,
// plus 1000 for reaching the flag. A run ends on death, at the flagpole, or
// when Mario stops making progress (the patience grows the longer he lives).

import { buildNetwork, activate } from './neat.js';
import { BTN, RAM, DeathWatcher, readView, playerLevelX, setButtons, bootToTitle, startFromTitle, VIEW_CELLS, LEVEL_1_1_END } from './smb.js';

// Optional extra inputs after the 169 grid cells: Mario's own speed. A
// feed-forward network sees one still frame; without these it cannot tell a
// standing Mario from a running one, which matters for when to jump.
export const EXTRA_INPUTS = ['run speed', 'rise / fall'];
export const aiInputCount = (extras) => VIEW_CELLS + (extras ? EXTRA_INPUTS.length : 0) + 1; // + bias
export const AI_INPUTS = aiInputCount(false);
export const AI_OUTPUTS = ['A', 'B', 'LEFT', 'RIGHT'];
export const OUT_BITS = [BTN.A, BTN.B, BTN.LEFT, BTN.RIGHT];

/** What the AI sees: the 13x13 grid, then (with extras) Mario's speed. The
 *  human recordings on screen 1 use this same function, so people's games and
 *  the AI's attempts are described in exactly the same terms. */
export function readInputs(m, out, extras) {
  readView(m, out);
  if (extras) {
    const s8 = (v) => (v > 127 ? v - 256 : v);
    out[VIEW_CELLS] = Math.max(-1, Math.min(1, s8(m[0x57]) / 40)); // Player_X_Speed
    out[VIEW_CELLS + 1] = Math.max(-1, Math.min(1, s8(m[0x9f]) / 5)); // Player_Y_Speed
  }
  return out;
}

/** Controller mask -> the AI's 4 outputs as bits (A=1, B=2, LEFT=4, RIGHT=8). */
export function outputBits(mask) {
  let b = 0;
  OUT_BITS.forEach((bit, o) => { if (mask & (1 << bit)) b |= 1 << o; });
  return b;
}
export const THINK_EVERY = 5; // frames between network evaluations (MarI/O's value)
export const TIME_WEIGHT = 0.5; // fitness points lost per frame (MarI/O's value)
const TIMEOUT = 20;

export class Trial {
  /** startState: a JSON string from makeStartState(). It is parsed fresh for
   *  every trial because jsnes keeps a few restored arrays by reference and
   *  keeps writing to them, which would slowly corrupt a shared object. */
  constructor(nes, startState, genome, { thinkEvery = THINK_EVERY, extras = false, timeWeight = TIME_WEIGHT } = {}) {
    this.timeWeight = timeWeight;
    this.nes = nes;
    this.genome = genome;
    this.thinkEvery = thinkEvery;
    this.extras = extras;
    this.nIn = aiInputCount(extras);
    nes.fromJSON(JSON.parse(startState));
    this.mem = nes.cpu.mem; // fromJSON() replaced the CPU; read RAM from the new one
    this.net = buildNetwork(genome, this.nIn, AI_OUTPUTS.length);
    this.watcher = new DeathWatcher();
    this.view = new Float32Array(this.nIn - 1);
    this.outputs = new Float32Array(AI_OUTPUTS.length);
    this.mask = 0;
    this.frames = 0;
    this.rightmost = playerLevelX(this.mem);
    this.timeout = TIMEOUT;
    this.done = false;
    this.died = false;
    this.cleared = false;
    this.death = null;
    this.endReason = '';
    this.watcher.update(this.mem); // arm on the start state
  }

  /** Advance one frame. Returns true once the attempt is over. */
  step() {
    if (this.done) return true;
    const m = this.mem;
    if (this.frames % this.thinkEvery === 0) {
      readInputs(m, this.view, this.extras);
      this.outputs = activate(this.net, this.view);
      let mask = 0;
      for (let o = 0; o < OUT_BITS.length; o++) if (this.outputs[o] > 0) mask |= 1 << OUT_BITS[o];
      if ((mask & (1 << BTN.LEFT)) && (mask & (1 << BTN.RIGHT))) mask &= ~((1 << BTN.LEFT) | (1 << BTN.RIGHT));
      this.mask = mask;
    }
    setButtons(this.nes, 1, this.mask);
    this.nes.frame();
    this.frames++;

    for (const ev of this.watcher.update(m)) {
      if (ev.type === 'death') { this.died = true; this.death = ev; this.#finish('died'); return true; }
      if (ev.type === 'clear') { this.cleared = true; this.#finish('cleared'); return true; }
    }
    const x = playerLevelX(m);
    if (x > this.rightmost) { this.rightmost = x; this.timeout = TIMEOUT; }
    this.timeout--;
    if (this.timeout + this.frames / 4 <= 0) { this.#finish('stuck'); return true; }
    if (this.frames > 60 * 60 * 3) { this.#finish('stuck'); return true; }
    return false;
  }

  #finish(reason) {
    this.done = true;
    this.endReason = reason;
  }

  get fitness() {
    let f = this.rightmost - this.frames * this.timeWeight;
    if (this.cleared) f += 1000;
    return f === 0 ? -1 : f;
  }

  /** 0..1 share of 1-1 covered (start x is 40). */
  get progress() {
    return Math.max(0, Math.min(1, (this.rightmost - 40) / (LEVEL_1_1_END - 40)));
  }

  result() {
    return {
      genomeId: this.genome.id,
      fitness: this.fitness,
      rightmost: this.rightmost,
      progress: this.progress,
      frames: this.frames,
      reason: this.endReason,
      death: this.death,
    };
  }

  /** Run to the end without rendering (headless evaluation). */
  runToEnd() {
    while (!this.step());
    return this.result();
  }
}

/** Boot the cart; return the savestate (JSON string) at the first frame of 1-1 Mario can move. */
export function makeStartState(nes, romBytes) {
  bootToTitle(nes, romBytes);
  startFromTitle(nes);
  return JSON.stringify(nes.toJSON());
}

export function isPlaying(m) {
  return m[RAM.OperMode] === 1;
}
