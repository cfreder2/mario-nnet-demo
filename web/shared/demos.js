// People's games as training data for the AI.
//
// While someone plays 1-1 on screen 1, every 5 frames (the AI's decision
// rate) we note what the AI would see at that moment, and which of the AI's
// four buttons the player pressed at any point in the next 5 frames: the AI
// holds each decision for 5 frames, so a jump the player started 3 frames
// later is the right answer for that moment. (Labelling only the exact frame
// missed 4 in 5 take-offs, and the copy never learned to jump.)
// One life = one list of samples.
// The second before a death is dropped: those are the moves that killed them,
// and we don't want the AI to copy them.
//
// Encoding (one sample): [grid, xSpeed, ySpeed, buttons]
//   grid    169 chars, '0' empty, '1' solid, '2' enemy (the AI's 13x13 view)
//   xSpeed  Mario's horizontal speed byte, signed (-40..40)
//   ySpeed  vertical speed byte, signed (about -5..5)
//   buttons A=1, B=2, LEFT=4, RIGHT=8

import { RAM, VIEW_CELLS, areaKey, AREA_1_1, playerLevelX } from './smb.js';
import { readInputs, outputBits, aiInputCount, THINK_EVERY } from './trial.js';
import { progressOf } from './insights.js';

export const DROP_BEFORE_DEATH = 12; // samples = 60 frames = 1 second

const s8 = (v) => (v > 127 ? v - 256 : v);

export class DemoRecorder {
  constructor() {
    this.view = new Float32Array(aiInputCount(true) - 1);
    this.reset();
  }

  reset() {
    this.samples = [];
    this.frame = 0;
    this.maxX = 0;
    this.pending = null; // the latest sample, still collecting its 5 frames of buttons
  }

  /** Call once per emulated frame with the RAM and the player's controller mask. */
  tick(m, mask) {
    if (m[RAM.OperMode] !== 1 || areaKey(m) !== AREA_1_1) return;
    if (m[RAM.Engine] !== 8 || m[RAM.PlayerYHigh] !== 1) return; // only while Mario is in control
    this.maxX = Math.max(this.maxX, playerLevelX(m) + 8);
    if (this.pending) this.pending[3] |= outputBits(mask);
    if (this.frame++ % THINK_EVERY !== 0) return;
    readInputs(m, this.view, false);
    let grid = '';
    for (let i = 0; i < VIEW_CELLS; i++) grid += this.view[i] > 0 ? '1' : this.view[i] < 0 ? '2' : '0';
    this.pending = [grid, s8(m[0x57]), s8(m[0x9f]), 0];
    this.samples.push(this.pending);
  }

  /** End the current life. Returns { outcome, progress, samples } or null. */
  finish(outcome) {
    let samples = this.samples;
    if (outcome === 'died') samples = samples.slice(0, Math.max(0, samples.length - DROP_BEFORE_DEATH));
    const life = samples.length >= 10 ? { outcome, maxX: this.maxX, progress: progressOf(this.maxX), samples } : null;
    this.reset();
    return life;
  }
}

/**
 * Turn recorded lives into training arrays for an AI with `nIn` inputs
 * (169 grid cells, +2 speeds when nIn says so, + bias). Lives that got
 * farther count more: the AI should copy the people who did well.
 * Keeps at most `maxSamples`, newest first.
 */
export function decodeLives(lives, nIn, maxSamples = 30000) {
  const D = nIn - 1;
  const extras = D > VIEW_CELLS;
  const rows = [];
  for (let l = lives.length - 1; l >= 0 && rows.length < maxSamples; l--) {
    const life = lives[l];
    const w = 0.25 + (life.progress || 0) * 1.5;
    for (const s of life.samples) {
      rows.push([s, w]);
      if (rows.length >= maxSamples) break;
    }
  }
  const n = rows.length;
  const X = new Float32Array(n * D);
  const Y = new Uint8Array(n);
  const W = new Float32Array(n);
  const C = new Uint8Array(n); // 0 = on the ground, 1 = in the air (from vertical speed)
  rows.forEach(([[grid, sx, sy, b], w], r) => {
    const o = r * D;
    for (let i = 0; i < VIEW_CELLS; i++) {
      const c = grid.charCodeAt(i);
      X[o + i] = c === 49 ? 1 : c === 50 ? -1 : 0;
    }
    if (extras) {
      X[o + VIEW_CELLS] = Math.max(-1, Math.min(1, sx / 40));
      X[o + VIEW_CELLS + 1] = Math.max(-1, Math.min(1, sy / 5));
    }
    Y[r] = b;
    W[r] = w;
    C[r] = sy === 0 ? 0 : 1;
  });
  return { X, Y, W, C, n, D };
}

/** Light validation for the server: is this a plausible recorded life? */
export function validLife(life) {
  if (!life || !Array.isArray(life.samples) || life.samples.length < 1 || life.samples.length > 20000) return false;
  for (const s of life.samples) {
    if (!Array.isArray(s) || s.length !== 4) return false;
    if (typeof s[0] !== 'string' || s[0].length !== VIEW_CELLS || /[^012]/.test(s[0])) return false;
    if (!Number.isInteger(s[1]) || !Number.isInteger(s[2]) || !Number.isInteger(s[3]) || s[3] < 0 || s[3] > 15) return false;
  }
  return true;
}
