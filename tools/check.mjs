#!/usr/bin/env node
// End-to-end check of both screens in headless Chrome against a running server.
//
//   node server.mjs &            (or start-kiosk.command)
//   node tools/check.mjs [--url http://localhost:8737] [--out /tmp/shots] [--ai-seconds 25]
//
// Screen 1: starts a game with the keyboard, walks Mario into the first
// Goomba until game over, and checks that 3 deaths and 1 game reached the
// server. Screen 2: lets the AI run and checks that attempts are counted.
// Saves screenshots along the way. Puppeteer comes from the copy bundled with
// @mermaid-js/mermaid-cli, or set PUPPETEER=/path/to/puppeteer.js.
// NOTE: it records real events; archive them afterwards with
//   curl -X POST 'localhost:8737/api/reset?source=people'

import { mkdirSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:8737');
const OUT = arg('--out', '/tmp/mario-check');
const AI_SECONDS = Number(arg('--ai-seconds', 25));
const PUP = process.env.PUPPETEER || `${process.env.HOME}/.nvm/versions/node/v24.10.0/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js`;
const { default: puppeteer } = await import(PUP);
mkdirSync(OUT, { recursive: true });

const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
};

// ---- screen 1 ----
const before = await fetch(`${URL_}/api/status`).then((r) => r.json());
const page = await browser.newPage();
watch(page, 'deaths');
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(`${URL_}/deaths.html`);
await page.waitForFunction('window.__deaths && window.__deaths.ready', { timeout: 20000 });
await sleep(1500);
await page.screenshot({ path: `${OUT}/1-attract.png` });

await page.keyboard.down('Enter'); await sleep(120); await page.keyboard.up('Enter');
await page.waitForFunction('window.__deaths.mem[0x770] === 1 && window.__deaths.mem[0x0e] === 8', { timeout: 10000 });
check(true, 'game starts from the keyboard');
await page.keyboard.down('ArrowRight');
await page.waitForFunction('window.__deaths.session && window.__deaths.session.deaths.length >= 1', { timeout: 20000 });
await sleep(700);
await page.screenshot({ path: `${OUT}/2-first-death.png` });
const first = await page.evaluate('window.__deaths.session.deaths[0]');
check(first.cause === 'Goomba', `first death is the Goomba (got ${first.cause} at x=${first.x})`);
// keep walking right through every life
await page.waitForFunction('window.__deaths.mem[0x770] === 3 || !window.__deaths.session', { timeout: 60000 });
await page.keyboard.up('ArrowRight');
await sleep(1200);
await page.screenshot({ path: `${OUT}/3-game-over.png` });
await sleep(1500);
const after = await fetch(`${URL_}/api/status`).then((r) => r.json());
check(after.events.people - before.events.people === 3, `3 player deaths saved (got ${after.events.people - before.events.people})`);
const games = (await fetch(`${URL_}/api/events?source=people`).then((r) => r.json())).events.filter((e) => e.kind === 'game');
check(games.length >= 1 && games[games.length - 1].deaths === 3, 'game summary saved with 3 deaths');
check(after.demos.lives - before.demos.lives === 3, `3 lives of moves recorded for the AI (got ${after.demos.lives - before.demos.lives}, ${after.demos.moves - before.demos.moves} moves)`);
await page.waitForFunction('window.__deaths.mem[0x770] === 0', { timeout: 20000 });
await sleep(4000);
await page.screenshot({ path: `${OUT}/4-attract-after.png` });

// ---- screen 2 ----
const ai = await browser.newPage();
watch(ai, 'ai');
await ai.setViewport({ width: 1920, height: 1080 });
await ai.goto(`${URL_}/ai.html`);
await ai.waitForFunction('window.__ai && window.__ai.tiles.length === 5', { timeout: 30000 });
let sawTaught = false;
for (let waited = 0; waited < AI_SECONDS * 1000; waited += 500) {
  await sleep(500);
  if (!sawTaught && (await ai.evaluate('window.__ai.tiles.some((t) => t.genome && t.genome.taught)'))) {
    sawTaught = true;
    await sleep(1500);
    await ai.screenshot({ path: `${OUT}/5-ai-taught.png` });
  }
}
await ai.screenshot({ path: `${OUT}/5-ai.png` });
const st = await ai.evaluate('({ gen: window.__ai.pool.generation, attempts: window.__ai.run.attempts, best: window.__ai.run.bestProgress, helpers: window.__ai.helpers.length, demos: window.__ai.demos, taught: window.__ai.pool.genomes().filter((g) => g.taught).length })');
console.log('     AI after', AI_SECONDS, 's:', JSON.stringify(st));
check(st.attempts > 50, `AI is making attempts (${st.attempts})`);
check(st.demos.lessons >= 1, `AI took a lesson from people's games (lessons ${st.demos.lessons}; taught genomes still in the population: ${st.taught})`);
check(sawTaught, 'a tile played a brain taught by people');

check(errors.length === 0, `no page errors${errors.length ? ':\n  ' + errors.join('\n  ') : ''}`);
await browser.close();
console.log(`screenshots in ${OUT}`);
process.exit(fails.length ? 1 : 0);
