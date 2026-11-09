// Screen 1: people play World 1-1; every death is logged and lands on the
// heatmap next to the game, and on the full-level strip below it.

import { createNES, bootToTitle, setButtons, DeathWatcher, RAM, cameraX, playerCentre, playerLevelX, areaKey, AREA_1_1, LevelMap, LEVEL_1_1_END } from './shared/smb.js';
import { Input } from './shared/input.js';
import { NesAudio } from './shared/audio.js';
import { HeatGrid, heatCanvas, drawHeatView, greyCopy, RAMP_PEOPLE, RAMP_AI } from './shared/heat.js';
import { summarise, designerNotes, compareGame, compareSentence, progressOf } from './shared/insights.js';
import { fitStage, toast, fatal, fetchRom, loadImage, fmt } from './shared/stage.js';
import { DemoRecorder } from './shared/demos.js';

const $ = (id) => document.getElementById(id);
fitStage($('stage'));

const FRAME_MS = 1000 / 60.0988;
const IDLE_FLAG_S = 20; // deaths after this long without input are not counted
const IDLE_RESET_S = 60; // then the game goes back to the title screen
const VIEW_Y0 = 8, VIEW_H = 224; // TV-safe rows (a real TV hid the top and bottom 8)
const STRIP_Y0 = 64, STRIP_H = 176; // rows of the level shown in the bottom strips
const STRIP_W = 1762, STRIP_PX_H = 92;
const PANEL_SCALE = 3;
const pct = (v) => `${Math.round(v * 100)}%`;

let nes, mem, audio, input, titleState;
let frameBuf = null;
const watcher = new DeathWatcher();
const recorder = new DemoRecorder(); // the player's moves, sent to the AI as lessons
let session = null;

let events = [];
const known = new Set();
let lastId = 0;

let mapImg = null;
let mapGrey = null; // pre-dimmed copy for the heat panel
let mapWidth = 3360;
const MAX_AI_EVENTS = 30000; // the AI adds ~25 a generation all day; keep the newest
const liveMaps = new Map(); // area -> { map: LevelMap, canvas, dirtyAt }
let people = null, ai = null; // summaries
let peopleHeat = null, aiHeat = null; // canvases at grid resolution
const areaHeat = new Map();
const CELL = 4;
let notes = [], noteIdx = 0;
let moment = null; // the death the player just had, for the callout + ring
let bannerTimer = 0, gameoverTimer = 0;

const gameCtx = $('game').getContext('2d');
const gameImg = gameCtx.createImageData(256, 240);
const gameU32 = new Uint32Array(gameImg.data.buffer);
const viewCtx = $('heatView').getContext('2d');

// ---------------------------------------------------------------------------
async function main() {
  const status = await fetch('/api/status').then((r) => r.json()).catch(() => null);
  if (!status) return fatal('Cannot reach the server. Start it with <code>node server.mjs</code>.');
  if (!status.rom) return fatal('No ROM found.<br>Put the <b>Super Mario Bros. + Duck Hunt</b> <code>.nes</code> file in the <code>rom/</code> folder and reload.');
  const rom = await fetchRom();
  audio = new NesAudio();
  await audio.ready.catch(() => {});
  input = new Input();
  input.onKey = hotkey;
  nes = createNES({ onFrame: (b) => (frameBuf = b), onAudioSample: audio.sample, sampleRate: audio.sampleRate });
  try {
    bootToTitle(nes, rom);
  } catch (e) {
    return fatal(`${e.message}`);
  }
  titleState = JSON.stringify(nes.toJSON());
  mem = nes.cpu.mem;

  mapImg = await loadImage('/maps/1-1.png');
  if (mapImg) { mapWidth = mapImg.width; mapGrey = greyCopy(mapImg); }
  else liveMaps.set(AREA_1_1, newLiveMap(AREA_1_1));

  await loadEvents();
  rebuild();
  setInterval(pollEvents, 10000);
  setInterval(nextNote, 12000);
  requestAnimationFrame(loop);
}

function newLiveMap(area) {
  const map = new LevelMap(area);
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = 240;
  return { map, canvas, dirtyAt: 0 };
}

function resetToTitle() {
  nes.fromJSON(JSON.parse(titleState));
  mem = nes.cpu.mem;
  watcher.reset();
}

// ---- data ------------------------------------------------------------------
async function loadEvents() {
  const [p, a] = await Promise.all([
    fetch('/api/events?source=people').then((r) => r.json()),
    fetch('/api/events?source=ai&limit=20000').then((r) => r.json()),
  ]);
  events = [];
  known.clear();
  for (const e of [...p.events, ...a.events]) { events.push(e); known.add(e.id); }
  lastId = Math.max(p.lastId, a.lastId);
}

async function pollEvents() {
  try {
    const r = await fetch(`/api/events?since=${lastId}&limit=5000`).then((x) => x.json());
    let added = 0;
    for (const e of r.events) if (!known.has(e.id)) { events.push(e); known.add(e.id); added++; }
    lastId = Math.max(lastId, r.lastId);
    const aiCount = events.reduce((n, e) => n + (e.source === 'ai'), 0);
    if (aiCount > MAX_AI_EVENTS) {
      let drop = aiCount - MAX_AI_EVENTS;
      events = events.filter((e) => !(e.source === 'ai' && drop-- > 0));
    }
    if (added) rebuild();
  } catch {}
}

async function record(e) {
  events.push(e); // count it now; the server assigns the id
  try {
    const r = await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) }).then((x) => x.json());
    if (r.ids?.[0]) { e.id = r.ids[0]; known.add(e.id); }
  } catch {
    toast('Could not save that death — is the server running?');
  }
}

function rebuild() {
  people = summarise(events, 'people');
  ai = summarise(events, 'ai');
  const pg = new HeatGrid(mapWidth, 240, CELL);
  for (const d of people.deaths) pg.add(d.x, d.y);
  peopleHeat = people.deaths.length ? heatCanvas(pg, RAMP_PEOPLE) : null;
  const ag = new HeatGrid(mapWidth, 240, CELL);
  for (const d of ai.deaths) ag.add(d.x, d.y);
  aiHeat = ai.deaths.length ? heatCanvas(ag, RAMP_AI) : null;
  areaHeat.clear();
  renderStats();
  renderSide();
  renderStrips();
  notes = designerNotes(people, ai);
  if (noteIdx >= notes.length) noteIdx = 0;
  showNote(false);
}

function heatForArea(area) {
  if (areaHeat.has(area)) return areaHeat.get(area);
  const ds = events.filter((e) => e.kind === 'death' && e.source === 'people' && e.area === area && !e.idle);
  const g = new HeatGrid(4096, 240, CELL);
  for (const d of ds) g.add(d.x, d.y);
  const v = { canvas: ds.length ? heatCanvas(g, RAMP_PEOPLE) : null, deaths: ds };
  areaHeat.set(area, v);
  return v;
}

// ---- side column, header, strips ---------------------------------------------
function renderStats() {
  const allPeopleDeaths = events.filter((e) => e.kind === 'death' && e.source === 'people' && !e.idle).length;
  $('statDeaths').textContent = fmt(allPeopleDeaths);
  $('statGames').textContent = fmt(people.games.length);
  $('statFlag').textContent = people.lives ? pct(people.flagRate) : '–';
}

function renderSide() {
  const src = people.deaths.length ? people : null;
  const killers = $('killers');
  killers.innerHTML = '';
  if (!src) {
    killers.innerHTML = '<div class="empty-text">No one has died here yet. Press START and be the first.</div>';
  } else {
    const top = src.causes.slice(0, 5);
    const other = src.causes.slice(5).reduce((a, c) => a + c.n, 0);
    if (other) top.push({ cause: 'Other', n: other, share: other / src.deaths.length });
    const max = Math.max(...top.map((c) => c.share));
    for (const c of top) {
      const row = document.createElement('div');
      row.className = 'bar';
      row.innerHTML = `<span class="name"></span><span class="val">${pct(c.share)}</span><div class="track"><div class="fill" style="width:${(c.share / max) * 100}%"></div></div>`;
      row.querySelector('.name').textContent = c.cause;
      killers.appendChild(row);
    }
  }
  const list = $('hotspots');
  list.innerHTML = '';
  if (!src) {
    list.innerHTML = '<li class="empty-text">Hot spots appear after a few deaths.</li>';
  } else {
    src.hotspots.forEach((h, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rank">${i + 1}</span><span class="zone"><span class="zn"></span><small></small></span><span class="share">${pct(h.share)}</span>`;
      li.querySelector('.zn').textContent = h.zone[0].toUpperCase() + h.zone.slice(1);
      li.querySelector('small').textContent = h.cause === 'Pit' ? 'falls' : h.cause ? `mostly ${h.cause}` : '';
      list.appendChild(li);
    });
  }
}

function renderStrips() {
  const s = STRIP_W / mapWidth;
  for (const [canvasId, spotsId, heat, sum] of [['stripPeople', 'spotsPeople', peopleHeat, people], ['stripAI', 'spotsAI', aiHeat, ai]]) {
    const ctx = $(canvasId).getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, STRIP_W, STRIP_PX_H);
    const map = mapImg || liveMaps.get(AREA_1_1)?.canvas;
    drawHeatView(ctx, { map, heat, cell: CELL, sx: 0, sy: STRIP_Y0, sw: mapWidth, sh: STRIP_H, dx: 0, dy: 0, dw: STRIP_W, dh: STRIP_PX_H, dim: 0.38 });
    const spots = $(spotsId);
    spots.innerHTML = '';
    if (sum.deaths.length >= 3) {
      for (const h of sum.hotspots.filter((x) => x.share >= 0.05)) {
        const el = document.createElement('div');
        el.className = 'spot';
        el.style.left = `${Math.max(90, Math.min(STRIP_W - 110, h.x * s))}px`;
        el.innerHTML = `${pct(h.share)} <span></span>`;
        el.querySelector('span').textContent = h.zone;
        spots.appendChild(el);
      }
    }
  }
  $('emptyAI').classList.toggle('hidden', ai.deaths.length > 0);
}

function showNote(fade = true) {
  const n = notes[noteIdx % notes.length];
  if (!n) return;
  const el = $('note');
  const apply = () => {
    $('noteTitle').textContent = n.title;
    $('noteBody').textContent = n.body;
    el.classList.remove('fade');
  };
  if (!fade) return apply();
  el.classList.add('fade');
  setTimeout(apply, 400);
}

function nextNote() {
  if (!notes.length) return;
  noteIdx = (noteIdx + 1) % notes.length;
  showNote(true);
}

// ---- game events --------------------------------------------------------------
function handle(ev) {
  if (ev.type === 'start') {
    session = { id: crypto.randomUUID(), t0: performance.now(), deaths: [], maxX: 0, cleared: false, moves: 0 };
    recorder.reset();
    hide('gameover');
    return;
  }
  if (!session) return;
  if (ev.type === 'death') {
    const idle = input.idleSeconds() > IDLE_FLAG_S;
    const nearby = people.deaths.filter((d) => Math.hypot(d.x - ev.x, d.y - ev.y) < 24).length;
    const e = { source: 'people', kind: 'death', session: session.id, level: ev.level, area: ev.area, x: ev.x, y: ev.y, cause: ev.cause, power: ev.power, timeLeft: ev.timeLeft, lifeFrames: ev.lifeFrames };
    if (idle) e.idle = true;
    session.deaths.push(ev);
    record(e).then(() => {});
    sendLife(recorder.finish('died'), idle);
    if (!idle) {
      rebuild();
      if (ev.area === AREA_1_1 || liveMaps.has(ev.area)) {
        moment = { x: ev.x, y: ev.y, area: ev.area, t: performance.now(), nearby, cause: ev.cause };
      }
    }
  } else if (ev.type === 'clear') {
    if (ev.area === AREA_1_1) {
      session.cleared = true;
      session.maxX = LEVEL_1_1_END;
      sendLife(recorder.finish('cleared'), input.idleSeconds() > IDLE_FLAG_S);
      const rate = people.lives ? people.flagRate : null;
      banner(`You reached the flag!`, rate !== null ? `Only ${pct(rate)} of lives here make it this far.` : 'You are the first one here to make it.');
    }
    record({ source: 'people', kind: 'clear', session: session.id, level: ev.level, area: ev.area, x: ev.x, lifeFrames: ev.lifeFrames });
    rebuild();
  } else if (ev.type === 'gameover') {
    endSession(false);
  }
}

/** Send one life's moves to the server for the AI to learn from. */
function sendLife(life, idle) {
  if (!life || idle || !session) return;
  session.moves += life.samples.length;
  fetch('/api/demos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...life, session: session.id }) }).catch(() => {});
}

function endSession(idle) {
  if (!session) return;
  recorder.reset();
  const s = session;
  session = null;
  const seconds = Math.round((performance.now() - s.t0) / 1000);
  const versus = compareGame(events, s.cleared ? LEVEL_1_1_END : s.maxX);
  record({ source: 'people', kind: 'game', session: s.id, maxX: s.maxX, deaths: s.deaths.length, cleared: s.cleared, seconds, ...(idle ? { idle: true } : {}) });
  rebuild();
  if (idle) return;
  const prog = s.cleared ? 1 : progressOf(s.maxX);
  const causes = s.deaths.map((d) => d.cause).join(', ');
  const el = $('gameover');
  el.innerHTML = `
    <h2>Your game</h2>
    <div class="big">${s.cleared ? 'You cleared World 1-1' : `You got ${pct(prog)} of the way`}</div>
    <div class="meter"><div style="width:${prog * 100}%"></div></div>
    <div class="ends"><span>start</span><span>flag</span></div>
    <div class="sub">${compareSentence(versus)}${causes ? `<br>Lost lives to: ${causes}.` : ''}</div>
    ${s.moves ? `<div class="taught">Your ${fmt(s.moves)} moves are now lessons for the AI on the other screen.</div>` : ''}`;
  show('gameover');
  clearTimeout(gameoverTimer);
  gameoverTimer = setTimeout(() => hide('gameover'), 9000);
}

function banner(title, sub) {
  $('banner').innerHTML = `${title}<small>${sub}</small>`;
  show('banner');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => hide('banner'), 5000);
}

const show = (id) => $(id).classList.add('show');
const hide = (id) => $(id).classList.remove('show');

// ---- hotkeys (Ctrl+Alt so players can't hit them by accident) -----------------
let resetArmed = 0;
function hotkey(e) {
  if (!(e.ctrlKey && e.altKey)) return false;
  e.preventDefault();
  if (e.code === 'KeyM') {
    audio.setMuted(!audio.muted);
    toast(audio.muted ? 'Sound off' : 'Sound on');
  } else if (e.code === 'KeyF') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen();
  } else if (e.code === 'KeyE') {
    const a = document.createElement('a');
    a.href = '/api/export.csv';
    a.download = `mario-deaths-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast('Exporting every event as CSV');
  } else if (e.code === 'KeyR') {
    if (performance.now() - resetArmed < 3000) {
      fetch('/api/reset?source=people', { method: 'POST' }).then(() => loadEvents()).then(() => { rebuild(); toast('People data archived to data/archive/. Fresh map.'); });
      resetArmed = 0;
    } else {
      resetArmed = performance.now();
      toast('Press Ctrl+Alt+R again to archive all player deaths and start a fresh map');
    }
  } else if (e.code === 'KeyT') {
    resetToTitle();
    toast('Back to the title screen');
  } else return false;
  return true;
}

// ---- main loop -------------------------------------------------------------------
let last = performance.now(), acc = 0;

function emulateFrame() {
  const { p1, p2 } = input.poll();
  setButtons(nes, 1, p1);
  // 2-player mode alternates turns: with one controller, it plays Luigi too
  setButtons(nes, 2, input.padCount >= 2 ? p2 : p1);
  nes.frame();
  audio.flush();
  const m = nes.cpu.mem;
  if (session) recorder.tick(m, m[0x0753] === 1 && input.padCount >= 2 ? p2 : p1); // $0753: whose turn
  for (const ev of watcher.update(m)) handle(ev);
  if (m[RAM.OperMode] === 1) {
    const area = areaKey(m);
    if (session && area === AREA_1_1 && m[RAM.PlayerYHigh] === 1) session.maxX = Math.max(session.maxX, playerLevelX(m) + 8);
    if (area !== AREA_1_1 || !mapImg) {
      if (!liveMaps.has(area)) liveMaps.set(area, newLiveMap(area));
      liveMaps.get(area).map.capture(nes);
    }
    if (session && input.idleSeconds() > IDLE_RESET_S) {
      endSession(true);
      resetToTitle();
    }
  }
}

function loop(now) {
  const frameMs = FRAME_MS * (1 + Math.max(-0.03, Math.min(0.03, audio.drift() / audio.sampleRate)));
  acc += now - last;
  last = now;
  let n = 0;
  while (acc >= frameMs && n < 4) { emulateFrame(); acc -= frameMs; n++; }
  if (acc > 250) acc = 0;
  draw(now);
  requestAnimationFrame(loop);
}

function draw(now) {
  // the game
  if (frameBuf) {
    for (let i = 0; i < 256 * 240; i++) gameU32[i] = 0xff000000 | frameBuf[i];
    gameCtx.putImageData(gameImg, 0, -VIEW_Y0, 0, VIEW_Y0, 256, VIEW_H);
  }
  const m = nes.cpu.mem;
  const playing = m[RAM.OperMode] === 1;
  $('attract').classList.toggle('hidden', playing || $('gameover').classList.contains('show'));
  $('pads').textContent = input.padCount ? `${input.padCount} controller${input.padCount > 1 ? 's' : ''} connected` : '';

  // which area and where to look
  let area = AREA_1_1, sx;
  if (playing) {
    area = areaKey(m);
    sx = cameraX(m);
  } else {
    const span = Math.max(0, mapWidth - 256);
    const t = (now / 1000) * 45; // px per second
    const p = t % (span * 2);
    sx = p < span ? p : span * 2 - p;
  }
  const live = liveMaps.get(area);
  if (live && live.map.dirty && now - live.dirtyAt > 500) {
    const ctx = live.canvas.getContext('2d');
    ctx.putImageData(new ImageData(live.map.rgba, live.map.width, 240), 0, 0);
    live.map.dirty = false;
    live.dirtyAt = now;
  }
  const useGrey = area === AREA_1_1 && !!mapGrey;
  const map = useGrey ? mapGrey : live?.canvas;
  let heat, deathsHere, usingAI = false;
  if (area === AREA_1_1) {
    if (people.deaths.length < 3 && aiHeat) { heat = aiHeat; deathsHere = ai.deaths; usingAI = true; }
    else { heat = peopleHeat; deathsHere = people.deaths; }
  } else {
    const h = heatForArea(area);
    heat = h.canvas;
    deathsHere = h.deaths;
  }
  $('heatLabel').innerHTML = usingAI
    ? '<span class="swatch" style="background:var(--ai)"></span>No people yet: this is where the AI died'
    : `<span class="swatch" style="background:var(--people)"></span>${area === AREA_1_1 ? "Everyone's deaths, right here" : 'Deaths in this room'}`;
  document.querySelector('.legend .ramp').className = `ramp ${usingAI ? 'ai' : 'people'}`;

  viewCtx.fillStyle = '#000';
  viewCtx.fillRect(0, 0, 768, 672);
  drawHeatView(viewCtx, { map, heat, cell: CELL, sx, sy: VIEW_Y0, sw: 256, sh: VIEW_H, dx: 0, dy: 0, dw: 768, dh: 672, grey: useGrey });

  // individual deaths as small marks while there are few enough to read
  const inView = deathsHere.filter((d) => d.x >= sx - 8 && d.x <= sx + 264);
  if (inView.length && inView.length < 160) {
    viewCtx.strokeStyle = 'rgba(240,239,236,0.45)';
    viewCtx.lineWidth = 2;
    for (const d of inView) {
      const x = (d.x - sx) * PANEL_SCALE, y = (d.y - VIEW_Y0) * PANEL_SCALE;
      viewCtx.beginPath();
      viewCtx.moveTo(x - 5, y - 5); viewCtx.lineTo(x + 5, y + 5);
      viewCtx.moveTo(x + 5, y - 5); viewCtx.lineTo(x - 5, y + 5);
      viewCtx.stroke();
    }
  }

  // where Mario is right now
  if (playing && m[RAM.PlayerYHigh] === 1) {
    const p = playerCentre(m);
    const x = (p.x - sx) * PANEL_SCALE, y = (p.y - VIEW_Y0) * PANEL_SCALE;
    viewCtx.strokeStyle = '#f0efec';
    viewCtx.lineWidth = 3;
    viewCtx.beginPath();
    viewCtx.arc(x, y, 26, 0, Math.PI * 2);
    viewCtx.stroke();
  }

  // the death that just happened
  const callout = $('callout');
  if (moment && now - moment.t < 4200 && moment.area === area) {
    const x = (moment.x - sx) * PANEL_SCALE, y = (moment.y - VIEW_Y0) * PANEL_SCALE;
    const k = ((now - moment.t) % 900) / 900;
    viewCtx.strokeStyle = `rgba(255,244,214,${1 - k})`;
    viewCtx.lineWidth = 4;
    viewCtx.beginPath();
    viewCtx.arc(x, y, 20 + k * 50, 0, Math.PI * 2);
    viewCtx.stroke();
    callout.textContent = moment.nearby ? `You + ${fmt(moment.nearby)} other${moment.nearby === 1 ? '' : 's'} died right here` : 'First death on this spot!';
    callout.style.left = `${Math.max(170, Math.min(598, x))}px`;
    callout.style.top = `${Math.max(70, y - 40)}px`;
    callout.classList.add('show');
  } else {
    callout.classList.remove('show');
  }

  // the camera window on the strips
  const w = $('windowPeople');
  if (playing && area === AREA_1_1) {
    const s = STRIP_W / mapWidth;
    w.style.left = `${sx * s}px`;
    w.style.width = `${256 * s}px`;
    w.classList.add('show');
  } else w.classList.remove('show');
}

// for tools/check.mjs
window.__deaths = {
  get mem() { return nes?.cpu.mem; },
  get events() { return events; },
  get session() { return session; },
  get ready() { return !!titleState; },
  get audio() { return audio && { state: audio.ctx.state, fill: audio.fill, rate: audio.sampleRate }; },
};

main();
