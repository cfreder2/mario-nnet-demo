#!/usr/bin/env node
// A stand-in for people, for testing the learn-from-people path before anyone
// has played: a rule-following bot plays 1-1 like a so-so human (holds right,
// jumps at enemies, walls and gaps, with sloppy timing so it dies often) and
// records its lives with the same DemoRecorder screen 1 uses.
//
//   node tools/bot-demos.mjs [--lives 40] [--seed 1] [--out data/bot-demos.jsonl] [--post http://localhost:8737]
//
// --post sends each life to a running server as if someone had played it.
// Lives from this bot are NOT people; don't post them on event day.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNES, setButtons, BTN, RAM, DeathWatcher, playerLevelX } from '../web/shared/smb.js';
import { makeStartState } from '../web/shared/trial.js';
import { DemoRecorder } from '../web/shared/demos.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const LIVES = Number(arg('--lives', 40));
let rng = Number(arg('--seed', 1)) >>> 0 || 1;
const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 2 ** 32);
const out = resolve(ROOT, arg('--out', 'data/bot-demos.jsonl'));
const post = arg('--post', null);

const nes = createNES();
const start = makeStartState(nes, new Uint8Array(readFileSync(resolve(ROOT, 'rom/smb-duckhunt.nes'))));
const solid = (m, x, y) => {
  if (y < 32 || y >= 240 || x < 0) return false;
  return m[0x500 + (Math.floor(x / 256) % 2) * 208 + ((y - 32) >> 4) * 16 + ((x % 256) >> 4)] !== 0;
};

const lives = [];
for (let l = 0; l < LIVES; l++) {
  nes.fromJSON(JSON.parse(start));
  const m = nes.cpu.mem;
  const watcher = new DeathWatcher();
  watcher.update(m);
  const rec = new DemoRecorder();
  const runs = rand() < 0.5; // half the "players" hold run
  const sloppy = 0.15 + rand() * 0.5; // chance to react late
  let jump = 0, cool = 0, best = 0, stuck = 0, life = null;
  for (let f = 0; f < 7000 && !life; f++) {
    const x = playerLevelX(m), y = m[RAM.PlayerY] + 16;
    if (x > best) { best = x; stuck = 0; } else stuck++;
    let mask = 1 << BTN.RIGHT;
    if (runs) mask |= 1 << BTN.B;
    let danger = false;
    for (let s = 0; s < 5; s++) {
      if (!m[0x0f + s]) continue;
      const ex = m[0x6e + s] * 256 + m[0x87 + s];
      if (ex - x > 4 && ex - x < (runs ? 56 : 40) && Math.abs(m[0xcf + s] - m[RAM.PlayerY]) < 24) danger = true;
    }
    const wall = solid(m, x + 20, y) || stuck > 3;
    const gap = !solid(m, x + 24, 208) && !solid(m, x + 40, 208) && m[RAM.PlayerY] >= 160;
    if (cool > 0) cool--;
    if (jump === 0 && cool === 0 && (danger || wall || gap) && rand() > sloppy * 0.25) jump = 14 + Math.floor(rand() * 20);
    if (jump > 0) { mask |= 1 << BTN.A; if (--jump === 0) cool = 6; }
    setButtons(nes, 1, mask);
    nes.frame();
    rec.tick(m, mask);
    for (const ev of watcher.update(m)) {
      if (ev.type === 'death') life = rec.finish('died');
      if (ev.type === 'clear') life = rec.finish('cleared');
    }
    if (stuck > 600) life = rec.finish('over');
  }
  if (life) {
    lives.push(life);
    if (post) await fetch(`${post}/api/demos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...life, session: `bot-${l}` }) });
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lives.map((d) => JSON.stringify(d)).join('\n') + '\n');
const prog = lives.map((d) => d.progress).sort((a, b) => a - b);
console.log(`${lives.length} lives, ${lives.reduce((n, d) => n + d.samples.length, 0)} moves; progress median ${(prog[prog.length >> 1] * 100).toFixed(0)}%, best ${(prog[prog.length - 1] * 100).toFixed(0)}%, cleared ${lives.filter((d) => d.outcome === 'cleared').length}; wrote ${out}${post ? ' and posted to ' + post : ''}`);
