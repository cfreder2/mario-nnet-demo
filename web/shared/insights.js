// Turning a list of deaths into the sentences on the kiosk. Everything here is
// computed from the data; the only hand-written facts are the names of the
// stretches of World 1-1 below, read off the captured level map.

import { LEVEL_1_1_END, AREA_1_1 } from './smb.js';

// [fromX, toX, name] in level pixels (Mario's centre). Pits are listed first
// so they win where ranges touch.
export const ZONES_1_1 = [
  [1096, 1152, 'the first pit'],
  [1368, 1440, 'the second pit'],
  [2440, 2496, 'the gap in the stairs'],
  [0, 232, 'the start'],
  [232, 440, 'the first Goomba'],
  [440, 1096, 'the pipes'],
  [1152, 1368, 'the high bricks'],
  [1440, 2136, 'the long brick run'],
  [2136, 2440, 'the stairs'],
  [2496, 2880, 'the last pipes'],
  [2880, 3100, 'the final staircase'],
  [3100, 99999, 'the flagpole'],
];

export function zoneName(x) {
  for (const [a, b, n] of ZONES_1_1) if (x >= a && x < b) return n;
  return 'somewhere odd';
}

export const progressOf = (x) => Math.max(0, Math.min(1, (x - 40) / (LEVEL_1_1_END - 40)));

/** Deaths that count: on 1-1's main area, not left idle. */
export function deathsOn11(events, source) {
  return events.filter((e) => e.kind === 'death' && e.source === source && e.area === AREA_1_1 && !e.idle);
}

export function summarise(events, source) {
  const deaths = deathsOn11(events, source);
  const clears = events.filter((e) => e.kind === 'clear' && e.source === source && e.area === AREA_1_1 && !e.idle);
  const games = events.filter((e) => e.kind === 'game' && e.source === source && !e.idle);
  const lives = deaths.length + clears.length;

  // causes
  const causeCount = new Map();
  for (const d of deaths) causeCount.set(d.cause, (causeCount.get(d.cause) || 0) + 1);
  const causes = [...causeCount].sort((a, b) => b[1] - a[1]).map(([cause, n]) => ({ cause, n, share: n / (deaths.length || 1) }));

  // hotspots along x: 32px bins, smoothed, greedy peaks at least 160px apart
  const BIN = 32;
  const nb = Math.ceil((LEVEL_1_1_END + 200) / BIN);
  const hist = new Float32Array(nb);
  for (const d of deaths) hist[Math.min(nb - 1, Math.floor(d.x / BIN))]++;
  const smooth = hist.map((_, i) => (hist[i - 1] || 0) * 0.5 + hist[i] + (hist[i + 1] || 0) * 0.5);
  const order = [...smooth.keys()].sort((a, b) => smooth[b] - smooth[a]);
  const hotspots = [];
  for (const i of order) {
    if (smooth[i] <= 0 || hotspots.length >= 3) break;
    const cx = (i + 0.5) * BIN;
    if (hotspots.some((h) => Math.abs(h.x - cx) < 160)) continue;
    const near = deaths.filter((d) => Math.abs(d.x - cx) <= 64);
    const nearCauses = new Map();
    for (const d of near) nearCauses.set(d.cause, (nearCauses.get(d.cause) || 0) + 1);
    const top = [...nearCauses].sort((a, b) => b[1] - a[1])[0];
    hotspots.push({ x: cx, n: near.length, share: near.length / (deaths.length || 1), zone: zoneName(cx), cause: top ? top[0] : '' });
  }

  // how far lives get: share of lives that made it past x
  const reached = (x) => (lives ? (deaths.filter((d) => d.x >= x).length + clears.length) / lives : 0);
  const avgLifeSec = deaths.length ? deaths.reduce((a, d) => a + (d.lifeFrames || 0), 0) / deaths.length / 60 : 0;
  const firstTenSec = deaths.filter((d) => (d.lifeFrames || 0) < 600).length;

  return {
    deaths, clears, games, lives, causes, hotspots, hist, BIN,
    flagRate: lives ? clears.length / lives : 0,
    reached, avgLifeSec,
    quickShare: deaths.length ? firstTenSec / deaths.length : 0,
  };
}

/** How a game's best distance compares with past games (ties = within 24px). */
export function compareGame(events, maxX) {
  const games = events.filter((e) => e.kind === 'game' && e.source === 'people' && !e.idle && typeof e.maxX === 'number');
  if (!games.length) return null;
  const below = games.filter((g) => g.maxX < maxX - 24).length / games.length;
  const above = games.filter((g) => g.maxX > maxX + 24).length / games.length;
  return { below, above, tie: 1 - below - above };
}

/** One sentence for the game-over card. */
export function compareSentence(c) {
  if (!c) return 'The first game on the board.';
  if (c.below >= 0.5) return `Farther than ${pct(c.below)} of the games played here.`;
  if (c.below + c.tie >= 0.5) return 'About as far as most people get.';
  return `${pct(c.above)} of games here got farther than this.`;
}

const pct = (v) => `${Math.round(v * 100)}%`;
const oneIn = (v) => (v > 0 ? `1 in ${Math.max(1, Math.round(1 / v))}` : 'none');

/**
 * Short, data-backed notes about what a designer would read in the map.
 * Each is { title, body } and only appears when there is data behind it.
 */
export function designerNotes(people, ai) {
  const notes = [];
  const n = people.deaths.length;
  if (n >= 5) {
    const h = people.hotspots[0];
    if (h) {
      const lesson = h.zone === 'the first Goomba';
      const share = h.share >= 0.95 ? 'Almost every death so far' : h.share >= 0.4 ? `${pct(h.share)} of deaths` : `${oneIn(h.share)} deaths`;
      notes.push({
        title: `${share}: ${h.zone}`,
        body: lesson
          ? 'The first enemy is placed where you cannot miss it. A spike here is the game teaching you to jump, which is cheap because you have only just started.'
          : `A spike this big ${h.cause === 'Pit' ? 'at a gap' : 'in one place'} is where people are most likely to give up. A designer would look here first: move an enemy, shorten a gap, or add a coin trail that hints at the jump.`,
      });
    }
    const pit = people.causes.find((c) => c.cause === 'Pit');
    if (pit && pit.share > 0.05) {
      notes.push({
        title: `Pits take ${pct(pit.share)} of lives`,
        body: 'Falling feels like your fault, enemies feel like the game\'s. Players forgive pits more, so designers use them to raise difficulty without raising frustration.',
      });
    }
    if (people.quickShare > 0.15) {
      notes.push({
        title: `${pct(people.quickShare)} of deaths come in the first 10 s of a life`,
        body: 'Early, fast deaths are cheap: you are straight back in. Late deaths cost minutes of progress. Good levels put the hard lessons early and the long climbs late.',
      });
    }
    notes.push({
      title: `${pct(people.flagRate)} of lives reach the flag`,
      body: 'Too many people at the flag and the level is dull; too few and they stop playing. Designers tune enemy placement until this number lands where they want it, then check the heatmap again.',
    });
  }
  if (ai && ai.deaths.length >= 20) {
    const ah = ai.hotspots[0];
    const ph = people.hotspots[0];
    notes.push({
      title: ah && ph && ah.zone !== ph.zone ? `The AI dies at ${ah.zone}; people die at ${ph.zone}` : 'An AI learning the same level',
      body: 'On the other screen a neural network is learning 1-1 by trial and error. Studios run bots like it to find bugs and dead ends, and people to find out what is fun. The two heatmaps never quite match.',
    });
  }
  if (!notes.length) {
    notes.push({
      title: 'Every death tells the designer something',
      body: 'Play a game and your deaths land on this map. Hot spots show where a level is hardest. Designers use maps like this to decide what to change.',
    });
  }
  return notes;
}
