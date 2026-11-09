#!/usr/bin/env node
// Local server for the two kiosk screens. No dependencies.
//
//   node server.mjs [--port 8737] [--lan] [--data data]
//
//   /                 setup page with links to both screens
//   /deaths.html      screen 1: play 1-1, every death lands on the heatmap
//   /ai.html          screen 2: a NEAT network learning 1-1
//
// Data lives in data/ (git-ignored): events.jsonl (one death or game per
// line), maps/<level>.png, brain/current.json. Nothing leaves this machine.
// --lan listens on all interfaces so a second computer can show a screen.
// --data points at another data folder (for tests and demo recordings, so the
// event's own data stays untouched).

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, renameSync, statSync, createReadStream } from 'node:fs';
import { dirname, resolve, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validLife } from './web/shared/demos.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const WEB = join(ROOT, 'web');
const DATA = resolve(ROOT, arg('--data', 'data'));
const ROM_DIR = join(ROOT, 'rom');
const EVENTS = join(DATA, 'events.jsonl');
const DEMOS = join(DATA, 'demos.jsonl'); // people's recorded lives: the AI's lessons
const BRAIN = join(DATA, 'brain', 'current.json');
const MAPS = join(DATA, 'maps');
const PORT = Number(arg('--port', process.env.PORT || 8737));
const HOST = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';

for (const d of [DATA, MAPS, join(DATA, 'brain'), join(DATA, 'archive')]) mkdirSync(d, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};

// ---- ROM -------------------------------------------------------------------
function findRom() {
  if (!existsSync(ROM_DIR)) return null;
  const roms = readdirSync(ROM_DIR).filter((f) => f.toLowerCase().endsWith('.nes'));
  if (!roms.length) return null;
  return join(ROM_DIR, roms.includes('smb-duckhunt.nes') ? 'smb-duckhunt.nes' : roms[0]);
}

// ---- events ----------------------------------------------------------------
// ---- recorded lives (people's moves, for the AI to learn from) ----------------
let demos = [];
let nextDemoId = 1;
if (existsSync(DEMOS)) {
  for (const line of readFileSync(DEMOS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); demos.push(d); nextDemoId = Math.max(nextDemoId, d.id + 1); } catch {}
  }
}

function addDemo(life) {
  if (!validLife(life)) return null;
  const d = {
    id: nextDemoId++,
    t: new Date().toISOString(),
    session: typeof life.session === 'string' ? life.session.slice(0, 64) : undefined,
    outcome: ['died', 'cleared', 'over'].includes(life.outcome) ? life.outcome : 'died',
    maxX: typeof life.maxX === 'number' ? Math.max(0, Math.min(8192, life.maxX)) : 0,
    progress: typeof life.progress === 'number' ? Math.max(0, Math.min(1, life.progress)) : 0,
    samples: life.samples,
  };
  demos.push(d);
  appendFileSync(DEMOS, JSON.stringify(d) + '\n');
  return d;
}

const SOURCES = new Set(['people', 'ai']);
const KINDS = new Set(['death', 'clear', 'game']);
let events = [];
let nextId = 1;
if (existsSync(EVENTS)) {
  for (const line of readFileSync(EVENTS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); events.push(e); nextId = Math.max(nextId, (e.id || 0) + 1); } catch {}
  }
}

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
const str = (v, n = 40) => (typeof v === 'string' ? v.slice(0, n) : undefined);

function cleanEvent(e) {
  if (!e || typeof e !== 'object' || !SOURCES.has(e.source) || !KINDS.has(e.kind)) return null;
  const out = {
    id: nextId++,
    t: new Date().toISOString(),
    source: e.source,
    kind: e.kind,
    session: str(e.session, 64),
    level: str(e.level, 8),
    area: num(e.area, 0, 1023),
    x: num(e.x, 0, 8192),
    y: num(e.y, 0, 240),
    cause: str(e.cause),
    power: num(e.power, 0, 2),
    timeLeft: num(e.timeLeft, 0, 999),
    lifeFrames: num(e.lifeFrames, 0, 1e7),
    gen: num(e.gen, 0, 1e7),
    run: num(e.run, 0, 1e5),
    maxX: num(e.maxX, 0, 8192),
    deaths: num(e.deaths, 0, 1e4),
    seconds: num(e.seconds, 0, 1e6),
    cleared: typeof e.cleared === 'boolean' ? e.cleared : undefined,
    idle: e.idle === true ? true : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function addEvents(list) {
  const added = [];
  for (const raw of list.slice(0, 500)) {
    const e = cleanEvent(raw);
    if (!e) continue;
    events.push(e);
    added.push(e);
  }
  if (added.length) appendFileSync(EVENTS, added.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return added;
}

function archive(source) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const gone = events.filter((e) => !source || e.source === source);
  const keep = events.filter((e) => source && e.source !== source);
  writeFileSync(join(DATA, 'archive', `events-${source || 'all'}-${stamp}.jsonl`), gone.map((e) => JSON.stringify(e)).join('\n') + (gone.length ? '\n' : ''));
  writeFileSync(EVENTS, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
  events = keep;
  if (!source || source === 'people') {
    // recorded lives are people's data too
    writeFileSync(join(DATA, 'archive', `demos-${stamp}.jsonl`), demos.map((d) => JSON.stringify(d)).join('\n') + (demos.length ? '\n' : ''));
    writeFileSync(DEMOS, '');
    demos = [];
  }
  return gone.length;
}

function toCSV(list) {
  const cols = ['id', 't', 'source', 'kind', 'session', 'level', 'area', 'x', 'y', 'cause', 'power', 'timeLeft', 'lifeFrames', 'gen', 'run', 'maxX', 'deaths', 'seconds', 'cleared', 'idle'];
  const esc = (v) => (v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...list.map((e) => cols.map((c) => esc(e[c])).join(','))].join('\n') + '\n';
}

// ---- level map ---------------------------------------------------------------
async function ensureMap() {
  if (existsSync(join(MAPS, '1-1.png'))) return;
  const rom = findRom();
  if (!rom) return;
  console.log('Building the 1-1 level map (one time, ~10 s)…');
  const { captureLevel11 } = await import('./tools/capture-map.mjs');
  const { encodePNG } = await import('./tools/png.mjs');
  const { map, area, flagX, level } = captureLevel11(new Uint8Array(readFileSync(rom)));
  const width = Math.ceil(map.extent / 16) * 16;
  const crop = new Uint8ClampedArray(width * 240 * 4);
  for (let y = 0; y < 240; y++) crop.set(map.rgba.subarray(y * map.width * 4, y * map.width * 4 + width * 4), y * width * 4);
  writeFileSync(join(MAPS, `${level}.png`), encodePNG(width, 240, crop));
  writeFileSync(join(MAPS, `${level}.json`), JSON.stringify({ level, area, width, flagX }, null, 2));
  console.log(`Map ready: ${level} (${width} px wide).`);
}

// ---- http ----------------------------------------------------------------------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { fail(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/rom') {
      const rom = findRom();
      if (!rom) return send(res, 404, { error: 'No .nes file in rom/' });
      return send(res, 200, readFileSync(rom), 'application/octet-stream');
    }

    if (p === '/api/status') {
      const rom = findRom();
      return send(res, 200, {
        rom: rom ? rom.slice(ROOT.length + 1) : null,
        romBytes: rom ? statSync(rom).size : 0,
        maps: readdirSync(MAPS).filter((f) => f.endsWith('.png')),
        events: { people: events.filter((e) => e.source === 'people' && e.kind === 'death').length, ai: events.filter((e) => e.source === 'ai' && e.kind === 'death').length },
        demos: { lives: demos.length, moves: demos.reduce((n, d) => n + d.samples.length, 0) },
        brain: existsSync(BRAIN),
      });
    }

    if (p === '/api/events' && req.method === 'GET') {
      const source = url.searchParams.get('source');
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Number(url.searchParams.get('limit') || 0);
      let list = events.filter((e) => (!source || e.source === source) && e.id > since);
      if (limit > 0 && list.length > limit) list = list.slice(-limit);
      return send(res, 200, { lastId: nextId - 1, events: list });
    }

    if (p === '/api/events' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const added = addEvents(Array.isArray(body) ? body : [body]);
      return send(res, 200, { added: added.length, ids: added.map((e) => e.id) });
    }

    if (p === '/api/export.csv') {
      const source = url.searchParams.get('source');
      return send(res, 200, toCSV(events.filter((e) => !source || e.source === source)), MIME['.csv']);
    }

    if (p === '/api/demos' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8'));
      const d = addDemo(body);
      if (!d) return send(res, 400, { error: 'not a recorded life' });
      return send(res, 200, { id: d.id, lives: demos.length });
    }

    if (p === '/api/demos' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Number(url.searchParams.get('limit') || 400);
      let list = demos.filter((d) => d.id > since);
      if (list.length > limit) list = list.slice(-limit);
      return send(res, 200, { lastId: nextDemoId - 1, total: demos.length, lives: list });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      const source = url.searchParams.get('source');
      if (source && !SOURCES.has(source)) return send(res, 400, { error: 'bad source' });
      const n = archive(source);
      return send(res, 200, { archived: n });
    }

    if (p === '/api/brain' && req.method === 'GET') {
      if (!existsSync(BRAIN)) return send(res, 204, '');
      return send(res, 200, readFileSync(BRAIN));
    }

    if (p === '/api/brain' && req.method === 'PUT') {
      const body = await readBody(req, 64 * 1024 * 1024);
      JSON.parse(body.toString('utf8')); // validate
      writeFileSync(BRAIN + '.tmp', body);
      renameSync(BRAIN + '.tmp', BRAIN);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/brain' && req.method === 'DELETE') {
      if (existsSync(BRAIN)) renameSync(BRAIN, join(DATA, 'archive', `brain-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
      return send(res, 200, { ok: true });
    }

    const mapMatch = p.match(/^\/maps\/(\d-\d)\.(png|json)$/);
    if (mapMatch) {
      const f = join(MAPS, `${mapMatch[1]}.${mapMatch[2]}`);
      if (!existsSync(f)) return send(res, 404, { error: 'no map' });
      return send(res, 200, readFileSync(f), MIME['.' + mapMatch[2]]);
    }

    // static files from web/
    let rel = normalize(decodeURIComponent(p)).replace(/^([/\\])+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = resolve(WEB, rel);
    if (!file.startsWith(WEB) || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found', MIME['.txt']);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  } catch (err) {
    send(res, 400, { error: String(err.message || err) });
  }
});

await ensureMap().catch((e) => console.error('Map build failed:', e.message));
server.listen(PORT, HOST, () => {
  const rom = findRom();
  console.log(`Mario death map server on http://localhost:${PORT}/${HOST === '0.0.0.0' ? ' (LAN)' : ''}`);
  console.log(`  deaths screen  http://localhost:${PORT}/deaths.html`);
  console.log(`  AI screen      http://localhost:${PORT}/ai.html`);
  console.log(rom ? `  ROM            ${rom.slice(ROOT.length + 1)}` : '  ROM            MISSING: put the SMB + Duck Hunt .nes file in rom/');
  console.log(`  events         ${events.length} loaded from data/events.jsonl`);
});
