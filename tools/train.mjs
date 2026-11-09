#!/usr/bin/env node
// Headless NEAT training on 1-1, one emulator per worker thread. Uses the
// exact code the AI screen uses (web/shared/neat.js + trial.js), so it doubles
// as the check that the AI can learn the level at all.
//
//   node tools/train.mjs [--workers 7] [--gens 200] [--pop 300] [--seed 1]
//                        [--stagnation 15] [--think 5] [--no-extras]
//                        [--save data/brain/pretrained.json] [--quiet]
//
// Stops at the first generation whose best run reaches the flag (or --gens).

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '..');

if (!isMainThread) {
  const { createNES } = await import('../web/shared/smb.js');
  const { Trial, makeStartState } = await import('../web/shared/trial.js');
  const nes = createNES();
  const start = makeStartState(nes, new Uint8Array(readFileSync(workerData.rom)));
  parentPort.on('message', (genome) => {
    parentPort.postMessage(new Trial(nes, start, genome, { thinkEvery: workerData.think, extras: workerData.extras, timeWeight: workerData.timeWeight }).runToEnd());
  });
  parentPort.postMessage('ready');
} else {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
  const nWorkers = Number(arg('--workers', Math.max(1, availableParallelism() - 1)));
  const maxGens = Number(arg('--gens', 200));
  const pop = Number(arg('--pop', 300));
  const seed = Number(arg('--seed', Date.now() % 1e9));
  const save = arg('--save', null);
  const stagnation = Number(arg('--stagnation', 0));
  const think = Number(arg('--think', 5));
  const extras = !process.argv.includes('--no-extras'); // speed inputs, as on the AI screen
  const timeWeight = Number(arg('--time', 0.5)); // fitness lost per frame
  const demosPath = arg('--demos', null); // recorded lives (JSONL): teach generation 0 from them, like the AI screen
  const quiet = process.argv.includes('--quiet');
  const rom = resolve(ROOT, arg('--rom', 'rom/smb-duckhunt.nes'));

  const { Pool } = await import('../web/shared/neat.js');
  const { aiInputCount, AI_OUTPUTS } = await import('../web/shared/trial.js');

  const workers = await Promise.all(Array.from({ length: nWorkers }, () => new Promise((res) => {
    const w = new Worker(HERE, { workerData: { rom, think, extras, timeWeight } });
    w.once('message', () => res(w));
  })));

  const pool = new Pool({ inputs: aiInputCount(extras), outputs: AI_OUTPUTS.length, config: { population: pop, stagnationGens: stagnation }, seed });
  console.log(`seed ${seed}, population ${pop}, ${nWorkers} workers, stagnation rule ${stagnation || 'off'}, thinks every ${think} frames${extras ? ', speed inputs' : ''}, time weight ${timeWeight}${demosPath ? ', taught from ' + demosPath : ''}`);
  if (demosPath) {
    const { decodeLives } = await import('../web/shared/demos.js');
    const { learnFromPeople, weightsToLinks } = await import('../web/shared/imitate.js');
    const lives = readFileSync(resolve(ROOT, demosPath), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const data = decodeLives(lives, aiInputCount(extras));
    const { weights, agreement } = learnFromPeople(data);
    const seedGenome = pool.genomeFromLinks(weightsToLinks(weights, aiInputCount(extras)), { taught: true });
    const brood = [seedGenome];
    for (let i = 1; i < 10; i++) brood.push(pool.variantOf(seedGenome));
    pool.inject(brood);
    console.log(`taught from ${lives.length} lives, ${data.n} moves; agreement ${agreement.map((a) => Math.round(a * 100) + '%').join(' ')}`);
  }
  const checkpoint = () => {
    if (!save) return;
    const out = resolve(ROOT, save);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(pool.toJSON()));
  };
  const t0 = performance.now();
  let frames = 0, attempts = 0;

  for (let gen = 0; gen < maxGens; gen++) {
    const queue = pool.genomes();
    const results = [];
    await Promise.all(workers.map((w) => new Promise((done) => {
      const next = () => {
        const g = queue.shift();
        if (!g) return done();
        w.once('message', (r) => { results.push(r); next(); });
        w.postMessage(g);
      };
      next();
    })));
    let best = results[0];
    for (const r of results) {
      pool.setFitness(r.genomeId, r.fitness);
      frames += r.frames;
      attempts++;
      if (r.fitness > best.fitness) best = r;
    }
    const deaths = results.filter((r) => r.reason === 'died').length;
    const taughtNow = pool.genomes().filter((g) => g.taught).length;
    const cleared = results.filter((r) => r.reason === 'cleared').length;
    const secs = (performance.now() - t0) / 1000;
    if (!quiet || cleared || gen % 10 === 0) {
      console.log(`gen ${String(pool.generation).padStart(3)}  species ${String(pool.species.length).padStart(3)}  best ${best.fitness.toFixed(0).padStart(5)} (${(best.progress * 100).toFixed(0)}%, ${best.reason}${best.death ? ' ' + best.death.cause + ' x=' + best.death.x : ''})  deaths ${deaths}  clears ${cleared}${demosPath ? `  taught ${taughtNow}/${pool.genomes().length}${best && pool.genomes().find((g) => g.id === best.genomeId)?.taught ? ' (best is taught)' : ''}` : ''}  ${secs.toFixed(0)}s  ${(frames / secs).toFixed(0)} fps  ${((frames / 60) / 3600).toFixed(1)} h of play`);
    }
    for (const r of results) { const g = pool.genomes().find((x) => x.id === r.genomeId); if (g) g.progress = r.progress; }
    pool.nextGeneration({ attempts, seconds: secs, cleared, bestProgress: best.progress });
    if (pool.history.at(-1).refocused) console.log(`gen ${pool.generation - 1}: no progress for ${stagnation} generations, keeping only the 2 best species`);
    if (pool.generation % 10 === 0) checkpoint();
    if (cleared) {
      console.log(`CLEARED 1-1 in generation ${pool.generation - 1}: ${attempts} attempts, ${(frames / 60 / 60).toFixed(0)} min of game time, ${secs.toFixed(0)} s wall`);
      break;
    }
  }
  if (save) { checkpoint(); console.log('saved', resolve(ROOT, save)); }
  for (const w of workers) w.terminate();
}
