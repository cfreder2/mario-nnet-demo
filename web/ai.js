// Screen 2: a NEAT population learning 1-1. Five trials play on screen; hidden
// workers evaluate the rest of each generation at full speed. The sixth cell
// draws the brain playing in Trial 1, live.
//
// URL options: ?speed=2 (on-screen speed, 1|2|4|8) ?workers=N (hidden helpers)
//              ?pop=300 ?restart=10 (generations after the first clear before
//              starting over with a fresh brain; 0 = never) ?stagnation=20
//              ?extras=0 (no speed inputs: plain MarI/O inputs) ?think=5
//              ?time=0.5 (fitness lost per frame) ?giveup=40
// Keys (with Ctrl+Alt, so a visitor can't hit them): 1-4 speed, H helpers
// on/off, N twice = new brain, F fullscreen.

import { Pool, buildNetwork, activate } from './shared/neat.js';
import { aiInputCount, AI_OUTPUTS, EXTRA_INPUTS } from './shared/trial.js';
import { VIEW_SIZE } from './shared/smb.js';
import { fitStage, toast, fatal, fetchRom, fmt } from './shared/stage.js';

const $ = (id) => document.getElementById(id);
fitStage($('stage'));

const params = new URLSearchParams(location.search);
const SPEEDS = [1, 2, 4, 8];
let speed = SPEEDS.includes(Number(params.get('speed'))) ? Number(params.get('speed')) : 2;
const FF = 24; // frames per tick when a tile is the last thing holding up a generation
const POP = Number(params.get('pop') || 300);
const HIDDEN = params.has('workers') ? Number(params.get('workers')) : Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 4));
const RESTART_AFTER = params.has('restart') ? Number(params.get('restart')) : 10;
// NEAT's stagnation rule: after this many generations with no new record, only
// the two best species breed. 0 = off (plain MarI/O behaviour).
const STAGNATION = params.has('stagnation') ? Number(params.get('stagnation')) : 20;
// A brain with no new record for this many generations is replaced by a fresh
// one (most fresh runs clear 1-1 within ~20 generations). 0 = never give up.
const GIVE_UP = params.has('giveup') ? Number(params.get('giveup')) : 40;
// frames between network decisions; a brain must be judged at the rate it was bred at
let THINK = Number(params.get('think') || 5); // a saved brain keeps the rate it was bred at
// Mario's speed as two extra inputs (see trial.js). A saved brain keeps its own layout.
let EXTRAS = params.has('extras') ? params.get('extras') !== '0' : true;
let NIN = aiInputCount(EXTRAS);
// fitness points lost per frame; a saved brain keeps the value it was bred with
let TIME_W = Number(params.get('time') || 0.5);
const TILES = 5;
const AI_DEATH_SAMPLE = 25;
const pct = (v) => `${Math.round(v * 100)}%`;

let rom;
let pool;
let run = null; // { number, elapsed, attempts, bestProgress, clearedAtGen, clearedElapsed, clearedAttempts }
let runs = [];
let genStartId = 0; // genomes with a smaller id survived from the last generation
let queue = [];
let genSize = 0;
let genResults = [];
let genT0 = performance.now();
let hiddenOn = HIDDEN > 0;
let genToken = 0; // bumps every generation; results from an older one are ignored
// Species champions of the last generation, best first. Their runs are
// deterministic (same savestate, same network), so with helpers on the tiles
// replay these at a watchable speed while the helpers test the new children.
let showcase = [];
let showIdx = 0;
const tiles = [];
const helpers = [];

// ---- learning from people ---------------------------------------------------
// Lives people played on screen 1 (what the AI would have seen + what they
// pressed). Now and then a network is fitted to copy them and joins the
// population with 9 mutated variants. NEAT keeps that lineage only if it plays
// well; its descendants are marked "Taught by people".
// Lessons are spaced out: each one pulls the population toward copying people,
// which in testing gave a big head start but did not reach the flag sooner.
const TEACH_EVERY = 5; // generations between lessons, at most
const TEACH_MIN_NEW = 3; // new lives needed for another lesson (the first lesson needs 1)
const TEACH_COPIES = 10;
let demoLives = [];
let demoLastId = 0;
let demoTotal = 0;
let taughtFromLives = 0; // how many lives the last lesson was fitted on
let lastTeachGen = -99;
let pendingLesson = null;
let teaching = false;
let featured = null; // a just-taught brain: the next free tile plays its first attempt
const imitator = new Worker('imitate-worker.js', { type: 'module' });
imitator.onmessage = (e) => {
  teaching = false;
  if (e.data.links) pendingLesson = e.data;
};

async function fetchDemos() {
  try {
    const r = await fetch(`/api/demos?since=${demoLastId}&limit=400`).then((x) => x.json());
    if (r.total < demoTotal) { demoLives = []; taughtFromLives = 0; } // archived on screen 1
    demoLives.push(...r.lives);
    if (demoLives.length > 400) demoLives = demoLives.slice(-400);
    demoLastId = r.lastId;
    demoTotal = r.total;
    renderSubtitle();
  } catch {}
}

function maybeTeach() {
  if (teaching || pendingLesson || !demoLives.length) return;
  const fresh = demoLives.length - taughtFromLives;
  if (fresh < (taughtFromLives ? TEACH_MIN_NEW : 1)) return; // not enough new since the last lesson
  if (pool.generation - lastTeachGen < TEACH_EVERY) return;
  teaching = true;
  lastTeachGen = pool.generation;
  taughtFromLives = demoLives.length;
  imitator.postMessage({ lives: demoLives, nIn: NIN });
}

/** At a generation boundary: put a finished lesson into the new generation. */
function applyLesson() {
  if (!pendingLesson) return;
  const lesson = pendingLesson;
  pendingLesson = null;
  const seed = pool.genomeFromLinks(lesson.links, { taught: true });
  const brood = [seed];
  for (let i = 1; i < TEACH_COPIES; i++) brood.push(pool.variantOf(seed));
  pool.inject(brood);
  featured = seed;
  run.lessons = (run.lessons || 0) + 1;
  const agree = lesson.agreement.reduce((a, b) => a + b, 0) / lesson.agreement.length;
  toast(`${fmt(lesson.lives)} lives people played became a brain that presses the same buttons they did ${pct(agree)} of the time. Now it has to prove itself.`, 9000);
}

function renderSubtitle() {
  $('subtitle').textContent = demoTotal
    ? `Learning from its own attempts and from ${fmt(demoTotal)} lives people played next door. Orange = taught by people.`
    : 'Learning from its own attempts, and from every game people play on the other screen.';
}

// ---- brain persistence ------------------------------------------------------
function freshRun(number) {
  return { number, elapsed: 0, attempts: 0, bestProgress: 0, clearedAtGen: null, clearedElapsed: null, clearedAttempts: null };
}

async function loadBrain() {
  try {
    const r = await fetch('/api/brain');
    if (r.status === 200) {
      const b = await r.json();
      if ([aiInputCount(false), aiInputCount(true)].includes(b.pool?.nIn) && b.pool?.nOut === AI_OUTPUTS.length) {
        EXTRAS = b.pool.nIn === aiInputCount(true);
        NIN = b.pool.nIn;
        pool = Pool.fromJSON(b.pool);
        pool.cfg.stagnationGens = STAGNATION;
        if (b.think) THINK = b.think;
        if (b.timeWeight) TIME_W = b.timeWeight;
        run = b.run || freshRun(1);
        runs = b.runs || [];
        genStartId = b.genStartId || 0;
        return;
      }
    }
  } catch {}
  pool = new Pool({ inputs: NIN, outputs: AI_OUTPUTS.length, config: { population: POP, stagnationGens: STAGNATION } });
  run = freshRun(1);
}

async function saveBrain() {
  const body = JSON.stringify({ version: 1, pool: pool.toJSON(), run, runs, genStartId, think: THINK, extras: EXTRAS, timeWeight: TIME_W });
  try { await fetch('/api/brain', { method: 'PUT', body }); } catch {}
}

// ---- workers ------------------------------------------------------------------
function makeTile(i) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `
    <canvas class="game pixel" width="256" height="200"></canvas>
    <div class="chip tl">Trial ${i + 1}</div>
    <div class="chip tr"></div>
    <div class="chip badge hidden"></div>
    <div class="chip ff hidden">fast-forward</div>
    <div class="end"></div>
    <div class="progress"><div class="bar"></div><div class="best"></div><div class="flag">flag ▸</div></div>`;
  $('grid').insertBefore(el, $('grid').querySelector('.brain'));
  const canvas = el.querySelector('canvas').transferControlToOffscreen();
  const worker = new Worker('ai-worker.js', { type: 'module' });
  const t = { i, el, worker, genome: null, waiting: false, ending: false, acc: 0, view: null, outputs: null, player: null, job: 0, token: 0 };
  worker.onmessage = (e) => onTileMessage(t, e.data);
  worker.postMessage({ cmd: 'init', rom, canvas, think: THINK, extras: EXTRAS, timeWeight: TIME_W }, [canvas]);
  return new Promise((ok) => (t.ready = ok)).then(() => t);
}

function makeHelper() {
  const worker = new Worker('ai-worker.js', { type: 'module' });
  const h = { worker, genome: null, token: 0 };
  return new Promise((ok) => {
    worker.onmessage = (e) => {
      if (e.data.type === 'ready') return ok(h);
      if (e.data.type === 'result') {
        const g = h.genome;
        h.genome = null;
        if (h.token === genToken) onResult(g, e.data.result);
        dispatch();
      }
    };
    worker.postMessage({ cmd: 'init', rom, think: THINK, extras: EXTRAS, timeWeight: TIME_W });
  });
}

function onTileMessage(t, msg) {
  if (msg.type === 'ready') return t.ready();
  if (msg.type !== 'tick') return;
  t.waiting = false;
  if (msg.idle || msg.job !== t.job) return; // a reply about an attempt this tile already dropped
  t.view = msg.view || t.view;
  t.outputs = msg.outputs;
  t.el.querySelector('.bar').style.width = `${msg.progress * 100}%`;
  if (msg.done) {
    const r = msg.result;
    const g = t.genome;
    t.genome = null;
    t.ending = true;
    const fresh = t.token === genToken && !t.replay;
    const end = t.el.querySelector('.end');
    end.innerHTML = r.reason === 'cleared' ? 'Reached the flag!'
      : r.reason === 'died' ? `Died: ${r.death?.cause || 'enemy'}<small>${pct(r.progress)} of the way</small>`
      : `Gave up<small>stuck at ${pct(r.progress)}</small>`;
    end.classList.add('show');
    if (fresh) onResult(g, r);
    setTimeout(() => {
      end.classList.remove('show');
      t.ending = false;
      dispatch();
    }, t.replay || queue.length ? 1100 : 350);
  }
}

function startTile(t, g, replay = false) {
  t.genome = g;
  t.replay = replay;
  t.acc = 0;
  t.job++;
  t.token = genToken;
  t.worker.postMessage({ cmd: 'run', genome: g, job: t.job });
  const species = pool.speciesOf(g.id) + 1;
  const where = species > 0 ? `species ${species}` : 'retired species';
  t.el.querySelector('.tr').textContent = replay ? `best of ${where} · gen ${pool.generation}` : `new · gen ${pool.generation} · ${where}`;
  const badge = t.el.querySelector('.badge');
  badge.textContent = g.taught ? 'Taught by people' : 'Self-taught';
  badge.classList.remove('hidden');
  badge.classList.toggle('people', !!g.taught);
  t.el.querySelector('.bar').style.width = '0%';
  if (t.i === 0) setBrainGenome(g);
}

function nextShowcase() {
  const showing = new Set(tiles.map((t) => t.genome?.id));
  // keep people's influence on screen: if a taught lineage survives and no
  // tile is showing one, show its best
  if (!tiles.some((t) => t.genome?.taught)) {
    const taught = showcase.find((g) => g.taught && !showing.has(g.id));
    if (taught) return taught;
  }
  for (let k = 0; k < showcase.length; k++) {
    const g = showcase[(showIdx + k) % showcase.length];
    if (!showing.has(g.id)) {
      showIdx = (showIdx + k + 1) % showcase.length;
      return g;
    }
  }
  return null;
}

function dispatch() {
  for (const t of tiles) {
    if (t.genome || t.ending) continue;
    if (featured) { // reserved in startGeneration; a real, counted attempt
      startTile(t, featured, false);
      featured = null;
      continue;
    }
    const g = hiddenOn ? nextShowcase() : null;
    if (g) startTile(t, g, true);
    else if (queue.length) startTile(t, queue.shift(), false);
  }
  if (hiddenOn) for (const h of helpers) {
    if (!h.genome && queue.length) {
      h.genome = queue.pop();
      h.token = genToken;
      h.worker.postMessage({ cmd: 'eval', genome: h.genome });
    }
  }
}

// ---- generations ------------------------------------------------------------------
function startGeneration() {
  genToken++;
  const all = pool.genomes();
  genSize = all.length;
  genResults = [];
  queue = [];
  for (const g of all) {
    if (g.id < genStartId && typeof g.progress === 'number') {
      // A champion carried over unchanged plays exactly the same run again,
      // so its score stands without spending another attempt on it.
      pool.setFitness(g.id, g.fitness);
      genResults.push({ genomeId: g.id, fitness: g.fitness, progress: g.progress, reason: 'carried' });
    } else queue.push(g);
  }
  if (featured) {
    // keep the just-taught brain for a tile, so people see it play
    const i = queue.indexOf(featured);
    if (i >= 0) queue.splice(i, 1); else featured = null;
  }
  const champs = all.filter((g) => typeof g.progress === 'number').sort((a, b) => b.fitness - a.fitness);
  if (champs.length) {
    showcase = champs.slice(0, 12);
    const bestTaught = champs.find((g) => g.taught);
    if (bestTaught && !showcase.includes(bestTaught)) showcase.push(bestTaught);
    showIdx = 0;
  }
  genT0 = performance.now();
  dispatch();
  renderHeader();
}

function onResult(genome, r) {
  if (!genome) return;
  genome.progress = r.progress;
  genome.reason = r.reason;
  pool.setFitness(genome.id, r.fitness);
  genResults.push(r);
  run.attempts++;
  run.bestProgress = Math.max(run.bestProgress, r.progress);
  if (genResults.length === genSize) finishGeneration();
  renderHeader();
}

function finishGeneration() {
  const now = performance.now();
  run.elapsed += (now - genT0) / 1000;
  genT0 = now;
  const gen = pool.generation;
  const cleared = genResults.filter((r) => r.reason === 'cleared').length;
  const bestProgress = Math.max(...genResults.map((r) => r.progress));
  postDeaths(gen);
  genStartId = pool.nextGenomeId;
  pool.nextGeneration({ bestProgress, attempts: run.attempts, seconds: Math.round(run.elapsed), cleared });
  fetchDemos().then(maybeTeach);
  if (pool.history.at(-1).refocused) {
    toast(`No new record for ${STAGNATION} generations: only the two best species get to breed now`, 8000);
  }

  if (cleared && run.clearedAtGen === null) {
    run.clearedAtGen = gen;
    run.clearedElapsed = run.elapsed;
    run.clearedAttempts = run.attempts;
    celebrate('It beat World 1-1!', `Generation ${gen} · ${fmt(run.attempts)} attempts · ${clock(run.elapsed)} of learning`);
  }
  if (run.clearedAtGen !== null && RESTART_AFTER > 0 && pool.generation - run.clearedAtGen > RESTART_AFTER) {
    newRun('Starting over with a brand-new brain, to learn it again from nothing.');
  } else if (run.clearedAtGen === null && GIVE_UP > 0 && gensSinceRecord() >= GIVE_UP) {
    const best = pct(run.bestProgress);
    newRun(`The last brain got stuck at ${best}. Starting over with a fresh one; most get further.`, 0);
  }
  applyLesson();
  saveBrain();
  renderRuns();
  drawCharts();
  startGeneration();
}

function postDeaths(gen) {
  const deaths = genResults.filter((r) => r.death);
  const sample = [];
  const pool2 = deaths.slice();
  while (sample.length < AI_DEATH_SAMPLE && pool2.length) sample.push(pool2.splice(Math.floor(Math.random() * pool2.length), 1)[0]);
  const events = sample.map(({ death: d }) => ({
    source: 'ai', kind: 'death', level: d.level, area: d.area, x: d.x, y: d.y, cause: d.cause, lifeFrames: d.lifeFrames, power: d.power, gen, run: run.number,
  }));
  if (events.length) fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(events) }).catch(() => {});
}

function newRun(message, delay = 7500) {
  runs.push({ number: run.number, clearedAtGen: run.clearedAtGen, attempts: run.clearedAttempts ?? run.attempts, minutes: Math.round((run.clearedElapsed ?? run.elapsed) / 60), generations: pool.generation, bestProgress: run.bestProgress });
  pool = new Pool({ inputs: NIN, outputs: AI_OUTPUTS.length, config: { population: POP, stagnationGens: STAGNATION } });
  run = freshRun(run.number + 1);
  lastTeachGen = -99; // a new brain gets people's lessons at its first chance
  taughtFromLives = 0;
  pendingLesson = null;
  genStartId = 0;
  queue = [];
  showcase = [];
  // drop what the tiles are playing: those attempts belong to the old brain
  for (const t of tiles) {
    t.genome = null;
    t.job++;
    t.ending = false;
    t.el.querySelector('.end').classList.remove('show');
  }
  if (message) setTimeout(() => celebrate(`Run ${run.number}`, message), delay);
}

// ---- header, runs, celebration ---------------------------------------------------------
function clock(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function renderHeader() {
  $('sGen').textContent = fmt(pool.generation);
  $('sAttempts').textContent = fmt(run.attempts);
  $('sBest').textContent = run.clearedAtGen !== null ? 'Flag!' : pct(run.bestProgress);
  const bestX = tiles.length ? run.bestProgress : 0;
  for (const t of tiles) t.el.querySelector('.best').style.left = `calc(${bestX * 100}% - 1px)`;
}

/** Generations since the best run last got farther. */
function gensSinceRecord() {
  let since = 0, best = -1;
  for (const h of pool.history) {
    const p = typeof h.bestProgress === 'number' ? h.bestProgress : 0;
    if (p > best + 0.005) { best = p; since = 0; } else since++;
  }
  return since;
}

function renderRuns() {
  const since = gensSinceRecord();
  const stuck = run.clearedAtGen === null && since >= 5 ? ` · no new record for ${since} generations` : '';
  const past = runs.slice(-4).map((r) => (r.clearedAtGen !== null ? `#${r.number} beat it at gen ${r.clearedAtGen} (${r.minutes} min)` : `#${r.number} stuck at ${pct(r.bestProgress || 0)}`));
  $('runs').textContent = `Run ${run.number}${stuck}${past.length ? ' · earlier: ' + past.join(', ') : ''}`;
}

let celebrateTimer = 0;
function celebrate(big, sub) {
  $('celebrate').innerHTML = `<div class="big">${big}</div><div class="sub">${sub}</div>`;
  $('celebrate').classList.add('show');
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => $('celebrate').classList.remove('show'), 7000);
}

// ---- the brain diagram ---------------------------------------------------------------------
const net = { genome: null, network: null, pos: new Map(), hidden: [] };
const NW = 1162, NH = 530;
const CELL = 34;
const GX = 16, GY = Math.round((NH - CELL * VIEW_SIZE) / 2);
const OUT_X = NW - 190;
const OUT_LABELS = ['A  jump', 'B  run', '◀  left', '▶  right'];

function setBrainGenome(g) {
  net.genome = g;
  net.network = buildNetwork(g, NIN, AI_OUTPUTS.length);
  const pos = new Map();
  for (let i = 0; i < VIEW_SIZE * VIEW_SIZE; i++) {
    pos.set(i, { x: GX + (i % VIEW_SIZE) * CELL + CELL / 2, y: GY + Math.floor(i / VIEW_SIZE) * CELL + CELL / 2 });
  }
  pos.set(NIN - 1, { x: GX + CELL * VIEW_SIZE + 28, y: NH - 24 }); // bias
  if (EXTRAS) EXTRA_INPUTS.forEach((_, k) => pos.set(VIEW_SIZE * VIEW_SIZE + k, { x: GX + CELL * VIEW_SIZE + 28, y: NH - 24 - 40 * (EXTRA_INPUTS.length - k) }));
  AI_OUTPUTS.forEach((_, o) => pos.set(NIN + o, { x: OUT_X, y: NH / 2 + (o - 1.5) * 92 }));
  // hidden neurons: column by depth, row by the average height of their inputs
  const depth = new Map();
  const hidden = net.network.order.filter((n) => n >= NIN + AI_OUTPUTS.length);
  for (const n of net.network.order) {
    let d = 0;
    for (const [from] of net.network.incoming.get(n) || []) d = Math.max(d, (depth.get(from) || 0) + 1);
    depth.set(n, Math.max(1, d)); // a neuron whose inputs were all disabled still sits among the hidden ones
  }
  const maxD = Math.max(1, ...hidden.map((n) => depth.get(n)));
  const left = GX + CELL * VIEW_SIZE + 90, right = OUT_X - 90;
  for (const n of hidden) {
    const srcs = (net.network.incoming.get(n) || []).map(([f]) => pos.get(f)).filter(Boolean);
    const y = srcs.length ? srcs.reduce((a, p) => a + p.y, 0) / srcs.length : NH / 2;
    const x = maxD === 1 ? (left + right) / 2 : left + ((depth.get(n) - 1) / (maxD - 1)) * (right - left);
    pos.set(n, { x, y });
  }
  // spread nodes that landed on top of each other
  const cols = new Map();
  for (const n of hidden) { const k = Math.round(pos.get(n).x); if (!cols.has(k)) cols.set(k, []); cols.get(k).push(n); }
  for (const list of cols.values()) {
    list.sort((a, b) => pos.get(a).y - pos.get(b).y);
    for (let i = 1; i < list.length; i++) {
      const a = pos.get(list[i - 1]), b = pos.get(list[i]);
      if (b.y - a.y < 30) b.y = a.y + 30;
    }
    const over = pos.get(list[list.length - 1]).y - (NH - 20);
    if (over > 0) for (const n of list) pos.get(n).y -= over;
  }
  net.pos = pos;
  net.hidden = hidden;
  $('brainTitle').textContent = g.taught ? "Trial 1's brain · taught by people" : "Trial 1's brain · self-taught";
  const links = g.genes.filter((x) => x.enabled).length;
  $('brainStats').textContent = `${links} connection${links === 1 ? '' : 's'} · ${hidden.length} hidden`;
}

const netCtx = $('net').getContext('2d');
function drawBrain() {
  const ctx = netCtx;
  ctx.clearRect(0, 0, NW, NH);
  const t = tiles[0];
  const view = t?.view;
  const values = net.network && view ? (activate(net.network, view), net.network.values) : new Map();
  // what Mario sees
  for (let i = 0; i < VIEW_SIZE * VIEW_SIZE; i++) {
    const v = view ? view[i] : 0;
    ctx.fillStyle = v > 0 ? '#c3c2b7' : v < 0 ? '#e66767' : '#2c2c2a';
    ctx.fillRect(GX + (i % VIEW_SIZE) * CELL + 1, GY + Math.floor(i / VIEW_SIZE) * CELL + 1, CELL - 2, CELL - 2);
  }
  const c = (VIEW_SIZE - 1) / 2;
  ctx.strokeStyle = '#f0efec';
  ctx.lineWidth = 3;
  ctx.strokeRect(GX + c * CELL + 1, GY + c * CELL + 1, CELL - 2, CELL - 2);
  ctx.fillStyle = '#898781';
  ctx.font = '600 26px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('What Mario\'s brain sees', GX, GY - 12);
  if (!net.genome) return;
  // connections
  for (const g of net.genome.genes) {
    if (!g.enabled) continue;
    const a = net.pos.get(g.into), b = net.pos.get(g.out);
    if (!a || !b) continue;
    const src = values.get(g.into) || 0;
    const live = Math.abs(src) > 0.01;
    const mag = Math.min(1, Math.abs(g.weight) / 2);
    ctx.strokeStyle = g.weight >= 0 ? `rgba(57,135,229,${live ? 0.95 : 0.18 + mag * 0.3})` : `rgba(230,103,103,${live ? 0.95 : 0.18 + mag * 0.3})`;
    ctx.lineWidth = live ? 2 + mag * 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  // bias node
  const bp = net.pos.get(NIN - 1);
  ctx.fillStyle = '#f0efec';
  ctx.beginPath(); ctx.arc(bp.x, bp.y, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#898781'; ctx.font = '500 24px system-ui, sans-serif';
  ctx.fillText('always on', bp.x + 14, bp.y + 8);
  if (EXTRAS) EXTRA_INPUTS.forEach((label, k) => {
    const p = net.pos.get(VIEW_SIZE * VIEW_SIZE + k);
    const v = view ? view[VIEW_SIZE * VIEW_SIZE + k] : 0;
    ctx.fillStyle = v > 0.05 ? '#6da7ec' : v < -0.05 ? '#e66767' : '#383835';
    ctx.strokeStyle = '#c3c2b7';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#898781';
    ctx.fillText(label, p.x + 16, p.y + 8);
  });
  // hidden neurons
  for (const n of net.hidden) {
    const p = net.pos.get(n);
    const v = values.get(n) || 0;
    ctx.fillStyle = v > 0.05 ? `rgba(109,167,236,${0.4 + v * 0.6})` : v < -0.05 ? `rgba(230,103,103,${0.4 - v * 0.6})` : '#383835';
    ctx.strokeStyle = '#c3c2b7';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // outputs = buttons
  const outs = t?.outputs || [];
  AI_OUTPUTS.forEach((_, o) => {
    const p = net.pos.get(NIN + o);
    const on = (outs[o] || 0) > 0;
    ctx.fillStyle = on ? '#ffd27a' : '#232321';
    ctx.strokeStyle = on ? '#ffd27a' : '#898781';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = on ? '#f0efec' : '#898781';
    ctx.font = `${on ? 800 : 500} 32px system-ui, sans-serif`;
    ctx.fillText(OUT_LABELS[o], p.x + 30, p.y + 11);
  });
  // key
  ctx.font = '500 24px system-ui, sans-serif';
  ctx.textAlign = 'right';
  const ky = 26;
  let kx = NW - 8;
  for (const [label, color] of [['inhibits', '#e66767'], ['excites', '#3987e5'], ['enemy', '#e66767'], ['block', '#c3c2b7']]) {
    ctx.fillStyle = '#898781';
    ctx.fillText(label, kx, ky);
    const w = ctx.measureText(label).width;
    ctx.fillStyle = color;
    if (label === 'enemy' || label === 'block') ctx.fillRect(kx - w - 22, ky - 14, 14, 14);
    else ctx.fillRect(kx - w - 26, ky - 8, 18, 4);
    kx -= w + 44;
  }
  ctx.textAlign = 'left';
}

// ---- charts --------------------------------------------------------------------------------
function lineChart(canvas, values, { max, fmtY, ticks }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const L = 70, R = 70, T = 14, B = 34;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '500 24px system-ui, sans-serif';
  ctx.fillStyle = '#898781';
  ctx.strokeStyle = '#2c2c2a';
  ctx.lineWidth = 1;
  for (const v of ticks) {
    const y = T + (1 - v / max) * (H - T - B);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(fmtY(v), L - 10, y + 7);
  }
  ctx.strokeStyle = '#383835';
  ctx.beginPath(); ctx.moveTo(L, H - B); ctx.lineTo(W - R, H - B); ctx.stroke();
  const n = values.length;
  ctx.textAlign = 'left';
  ctx.fillText('gen 0', L, H - 8);
  if (n > 1) { ctx.textAlign = 'right'; ctx.fillText(`gen ${n - 1}`, W - R, H - 8); }
  if (!n) return;
  const x = (i) => L + (n === 1 ? 0.5 : i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - Math.min(max, v) / max) * (H - T - B);
  ctx.strokeStyle = '#3987e5';
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
  const lv = values[n - 1];
  ctx.fillStyle = '#3987e5';
  ctx.beginPath(); ctx.arc(x(n - 1), y(lv), 7, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#1a1a19'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = '#f0efec';
  ctx.textAlign = 'left';
  ctx.font = '700 26px system-ui, sans-serif';
  ctx.fillText(fmtY(lv), x(n - 1) + 12, y(lv) + 9);
}

function drawCharts() {
  const h = pool.history;
  const prog = h.map((e) => (typeof e.bestProgress === 'number' ? e.bestProgress : 0));
  lineChart($('chartBest'), prog, { max: 1, ticks: [0, 0.5, 1], fmtY: (v) => (v >= 1 ? 'flag' : pct(v)) });
  const size = h.map((e) => e.bestLinks || 0);
  const top = Math.max(10, ...size);
  const step = top <= 20 ? 10 : top <= 50 ? 25 : 50;
  const maxY = Math.ceil(top / step) * step;
  lineChart($('chartSize'), size, { max: maxY, ticks: [0, maxY / 2, maxY], fmtY: (v) => String(Math.round(v)) });
}

// ---- loop + keys -------------------------------------------------------------------------
let last = performance.now();
function loop(now) {
  const dt = Math.min(100, now - last);
  last = now;
  for (const t of tiles) {
    const ff = !queue.length && !!t.genome && !t.replay;
    t.el.querySelector('.ff').classList.toggle('hidden', !ff);
    if (!t.genome || t.waiting) continue;
    t.acc += (dt / 1000) * 60.0988 * (ff ? FF : speed);
    const frames = Math.floor(t.acc);
    if (frames < 1) continue;
    t.acc -= frames;
    t.waiting = true;
    t.worker.postMessage({ cmd: 'tick', frames, wantView: t.i === 0, job: t.job });
  }
  drawBrain();
  if (run) $('sTime').textContent = clock(run.elapsed + (now - genT0) / 1000);
  requestAnimationFrame(loop);
}

let newArmed = 0;
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.altKey)) return;
  e.preventDefault();
  const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
  if (i >= 0) { speed = SPEEDS[i]; toast(`On-screen speed ${speed}×`); return; }
  if (e.code === 'KeyH') {
    hiddenOn = !hiddenOn;
    toast(hiddenOn ? `${helpers.length} background helpers on: generations go faster` : 'Helpers off: every attempt plays on screen');
    dispatch();
  } else if (e.code === 'KeyN') {
    if (performance.now() - newArmed < 3000) {
      newRun();
      newArmed = 0;
      saveBrain();
      drawCharts();
      renderRuns();
      startGeneration();
      toast('New brain: learning from nothing');
    } else {
      newArmed = performance.now();
      toast('Press Ctrl+Alt+N again to throw this brain away and start from nothing');
    }
  } else if (e.code === 'KeyF') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
  }
});

// ---- start ---------------------------------------------------------------------------------
async function main() {
  const status = await fetch('/api/status').then((r) => r.json()).catch(() => null);
  if (!status) return fatal('Cannot reach the server. Start it with <code>node server.mjs</code>.');
  if (!status.rom) return fatal('No ROM found.<br>Put the <b>Super Mario Bros. + Duck Hunt</b> <code>.nes</code> file in the <code>rom/</code> folder and reload.');
  rom = await fetchRom();
  await loadBrain();
  const made = await Promise.all([
    ...Array.from({ length: TILES }, (_, i) => makeTile(i)),
    ...Array.from({ length: HIDDEN }, () => makeHelper()),
  ]);
  tiles.push(...made.slice(0, TILES));
  helpers.push(...made.slice(TILES));
  renderRuns();
  drawCharts();
  await fetchDemos();
  maybeTeach();
  startGeneration();
  requestAnimationFrame(loop);
}

// for tools/check.mjs
window.__ai = {
  get pool() { return pool; },
  get run() { return run; },
  get tiles() { return tiles; },
  get helpers() { return helpers; },
  get demos() { return { lives: demoLives.length, total: demoTotal, taughtFromLives, teaching, pending: !!pendingLesson, lessons: run?.lessons || 0 }; },
};

main();
