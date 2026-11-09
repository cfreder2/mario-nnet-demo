// Super Mario Bros. knowledge shared by the kiosk, the AI workers and the
// headless tools: how to boot the combo cart, where things live in RAM, how
// to tell that Mario died (and of what), how to draw the level without
// sprites, and what the neural network sees.
//
// Every address here was checked against the "Super Mario Bros. + Duck Hunt
// (USA)" cart running in jsnes (see tools/probe.mjs). Names follow the
// community SMB disassembly.

import { NES } from '../vendor/jsnes/index.js';

export const BTN = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };

export const RAM = {
  OperMode: 0x0770, // 0 title/demo, 1 playing, 2 victory, 3 game over
  OperModeTask: 0x0772,
  Engine: 0x000e, // GameEngineSubroutine: 8 in control, 0x0b dying, 6 lose life, 4 flagpole, 7 entrance
  PlayerPage: 0x006d,
  PlayerX: 0x0086,
  PlayerY: 0x00ce,
  PlayerYHigh: 0x00b5, // 1 on screen, >=2 fell below the screen
  PlayerSize: 0x0754, // 0 big, 1 small
  PlayerStatus: 0x0756, // 0 small, 1 super, 2 fire
  ScreenPage: 0x071a,
  ScreenX: 0x071c,
  Lives: 0x075a,
  World: 0x075f,
  Level: 0x075c,
  AreaPointer: 0x0750,
  AreaType: 0x074e, // 0 water, 1 overground, 2 underground, 3 castle
  EventMusic: 0x00fc, // 1 = death jingle queued this frame
  Timer: 0x07f8, // three BCD digits 0x07f8..0x07fa
  EnemyFlag: 0x000f, // +slot (0..4), non-zero when active
  EnemyID: 0x0016,
  EnemyPage: 0x006e,
  EnemyX: 0x0087,
  EnemyY: 0x00cf,
  Tiles: 0x0500, // two 16x13 metatile screens
};

const ENEMY_NAMES = {
  0x00: 'Koopa Troopa', 0x01: 'Koopa Troopa', 0x03: 'Koopa Troopa',
  0x02: 'Buzzy Beetle', 0x05: 'Hammer Bro', 0x06: 'Goomba', 0x07: 'Blooper',
  0x08: 'Bullet Bill', 0x33: 'Bullet Bill', 0x0a: 'Cheep Cheep', 0x0b: 'Cheep Cheep',
  0x14: 'Cheep Cheep', 0x0c: 'Podoboo', 0x0d: 'Piranha Plant', 0x0e: 'Koopa Paratroopa',
  0x0f: 'Koopa Paratroopa', 0x10: 'Koopa Paratroopa', 0x11: 'Lakitu', 0x12: 'Spiny',
  0x15: "Bowser's fire", 0x1b: 'Fire Bar', 0x1c: 'Fire Bar', 0x1d: 'Fire Bar',
  0x1e: 'Fire Bar', 0x1f: 'Fire Bar', 0x2d: 'Bowser',
};

/** Level-space x of the right end of 1-1, where the flagpole is. */
export const LEVEL_1_1_END = 3186;

export function createNES({ onFrame = () => {}, onAudioSample = null, sampleRate = 48000 } = {}) {
  return new NES({
    onFrame,
    onAudioSample,
    sampleRate,
    emulateSound: !!onAudioSample,
  });
}

/** Hold exactly the buttons in `mask` (bit n = BTN n) on `pad` (1 or 2). */
export function setButtons(nes, pad, mask) {
  const c = nes.controllers[pad];
  for (let b = 0; b < 8; b++) c.state[b] = mask & (1 << b) ? 0x41 : 0x40;
}

function stepFrames(nes, n, mask = 0) {
  setButtons(nes, 1, mask);
  for (let i = 0; i < n; i++) nes.frame();
  setButtons(nes, 1, 0);
}

function waitFor(nes, pred, maxFrames) {
  for (let i = 0; i < maxFrames; i++) {
    if (pred(nes.cpu.mem)) return true;
    nes.frame();
  }
  return pred(nes.cpu.mem);
}

/**
 * Power on the combo cart and pick Super Mario Bros. from its menu (Duck Hunt
 * needs a light gun, which cannot work on an LCD). Leaves the NES on the SMB
 * title screen. Throws if the cart did not behave as expected.
 */
export function bootToTitle(nes, romBytes) {
  nes.loadROM(romBytes);
  stepFrames(nes, 150);
  stepFrames(nes, 2, 1 << BTN.START);
  const ok = waitFor(nes, (m) => m[RAM.OperMode] === 0 && m[RAM.OperModeTask] === 3 && m[RAM.Lives] === 2, 600);
  if (!ok) throw new Error('Did not reach the Super Mario Bros. title screen. Is this the SMB + Duck Hunt cart?');
}

/** From the title screen, start a 1-player game and run until Mario can move. */
export function startFromTitle(nes) {
  stepFrames(nes, 2, 1 << BTN.START);
  const ok = waitFor(nes, (m) => m[RAM.OperMode] === 1 && m[RAM.Engine] === 8, 600);
  if (!ok) throw new Error('Game did not start from the title screen.');
}

/** Identifies the area Mario is in (a level's main area, a bonus room, ...). 1-1 main = 450. */
export function areaKey(m) {
  return m[RAM.AreaType] * 256 + m[RAM.AreaPointer];
}
export const AREA_1_1 = 1 * 256 + 0xc2;

export function levelName(m) {
  return `${m[RAM.World] + 1}-${m[RAM.Level] + 1}`;
}

export function playerLevelX(m) {
  return m[RAM.PlayerPage] * 256 + m[RAM.PlayerX];
}

export function cameraX(m) {
  return m[RAM.ScreenPage] * 256 + m[RAM.ScreenX];
}

/** Mario's centre in level space (x) and screen space (y, 0..240). */
export function playerCentre(m) {
  const x = playerLevelX(m) + 8;
  const yHigh = m[RAM.PlayerYHigh];
  let y = m[RAM.PlayerY] + (m[RAM.PlayerSize] === 1 ? 24 : 16);
  if (yHigh >= 2) y = 236; // fell off the bottom: pin to the pit floor
  else if (yHigh === 0) y = 8;
  return { x, y: Math.max(0, Math.min(239, y)) };
}

function timerIsZero(m) {
  return m[RAM.Timer] === 0 && m[RAM.Timer + 1] === 0 && m[RAM.Timer + 2] === 0;
}

function timerValue(m) {
  return m[RAM.Timer] * 100 + m[RAM.Timer + 1] * 10 + m[RAM.Timer + 2];
}

/** Nearest dangerous enemy to Mario, or null. */
export function nearestEnemy(m, maxDist = 48) {
  const p = playerCentre(m);
  let best = null;
  for (let s = 0; s < 5; s++) {
    if (!m[RAM.EnemyFlag + s]) continue;
    const name = ENEMY_NAMES[m[RAM.EnemyID + s]];
    if (!name) continue;
    const ex = m[RAM.EnemyPage + s] * 256 + m[RAM.EnemyX + s] + 8;
    const ey = m[RAM.EnemyY + s] + 16;
    const d = Math.hypot(ex - p.x, ey - p.y);
    if (d <= maxDist && (!best || d < best.d)) best = { name, d };
  }
  return best;
}

/**
 * Watches RAM once per frame and reports game events:
 *   { type: 'start' }                         a new game began
 *   { type: 'death', x, y, cause, level, ... } Mario died
 *   { type: 'clear', level, ... }             Mario reached the flagpole
 *   { type: 'gameover' }
 * Deaths are reported on the frame they happen (the hit, or the fall below
 * the screen), not when the life counter changes ~4 s later.
 */
export class DeathWatcher {
  constructor() {
    this.reset();
  }

  reset() {
    this.prevMode = -1;
    this.armed = false;
    this.lifeFrames = 0;
    this.clearedArea = -1;
  }

  update(m) {
    const events = [];
    const mode = m[RAM.OperMode];
    const engine = m[RAM.Engine];
    const yHigh = m[RAM.PlayerYHigh];

    if (mode === 1 && this.prevMode !== 1 && this.prevMode !== 2) events.push({ type: 'start' });
    if (mode === 3 && this.prevMode !== 3) events.push({ type: 'gameover' });

    if (mode === 1) {
      if (!this.armed && engine === 8 && yHigh === 1) {
        this.armed = true;
        this.lifeFrames = 0;
        this.clearedArea = -1;
      }
      if (this.armed) {
        this.lifeFrames++;
        const enemyHit = engine === 0x0b;
        const fell = yHigh >= 2 && (m[RAM.EventMusic] === 1 || engine === 6);
        if (enemyHit || fell) {
          this.armed = false;
          const p = playerCentre(m);
          let cause;
          if (fell) cause = 'Pit';
          else if (timerIsZero(m)) cause = 'Time';
          else cause = nearestEnemy(m)?.name ?? 'Enemy';
          events.push({
            type: 'death',
            x: p.x,
            y: p.y,
            cause,
            level: levelName(m),
            area: areaKey(m),
            power: m[RAM.PlayerStatus],
            timeLeft: timerValue(m),
            lifeFrames: this.lifeFrames,
          });
        } else if (engine === 4 && this.clearedArea !== areaKey(m)) {
          this.clearedArea = areaKey(m);
          events.push({ type: 'clear', level: levelName(m), area: areaKey(m), x: playerLevelX(m), lifeFrames: this.lifeFrames });
        }
      }
    } else {
      this.armed = false;
    }
    this.prevMode = mode;
    return events;
  }
}

// ---------------------------------------------------------------------------
// What the neural network sees: a 13x13 grid of 16px cells centred on Mario.
// 1 = solid tile, -1 = enemy, 0 = empty. The same scheme SethBling's MarI/O
// used, so the network diagram reads the way people expect.

export const VIEW_RADIUS = 6;
export const VIEW_SIZE = VIEW_RADIUS * 2 + 1; // 13
export const VIEW_CELLS = VIEW_SIZE * VIEW_SIZE; // 169

export function readView(m, out = new Float32Array(VIEW_CELLS)) {
  const mx = playerLevelX(m);
  const my = m[0x03b8] + 16; // Player_Rel_YPos: Mario's on-screen y
  const ex = [], ey = [];
  for (let s = 0; s < 5; s++) {
    if (!m[RAM.EnemyFlag + s]) continue;
    ex.push(m[RAM.EnemyPage + s] * 256 + m[RAM.EnemyX + s]);
    ey.push(m[RAM.EnemyY + s] + 24);
  }
  let i = 0;
  for (let dy = -VIEW_RADIUS * 16; dy <= VIEW_RADIUS * 16; dy += 16) {
    for (let dx = -VIEW_RADIUS * 16; dx <= VIEW_RADIUS * 16; dx += 16) {
      let v = 0;
      const x = mx + dx + 8;
      const y = my + dy - 16;
      const suby = Math.floor((y - 32) / 16);
      if (suby >= 0 && suby < 13 && x >= 0) {
        const page = Math.floor(x / 256) % 2;
        const subx = Math.floor((x % 256) / 16);
        if (m[RAM.Tiles + page * 208 + suby * 16 + subx] !== 0) v = 1;
      }
      for (let k = 0; k < ex.length; k++) {
        if (Math.abs(ex[k] - (mx + dx)) <= 8 && Math.abs(ey[k] - (my + dy)) <= 8) v = -1;
      }
      out[i++] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Level map: SMB scrolls, so no single frame shows the whole level. Each
// frame we draw the on-screen columns of the background straight from the
// PPU's nametables (no sprites, no HUD) into a level-wide image. After one
// pass through a level the whole thing is there.

export const MAP_HEIGHT = 240;
export const MAP_MAX_WIDTH = 16 * 256;

export class LevelMap {
  /** area: the areaKey() this map belongs to; frames from any other
   *  area (a bonus room, the next level's intro) are ignored. null = lock onto
   *  the first area seen. */
  constructor(area = null, width = MAP_MAX_WIDTH) {
    this.area = area;
    this.width = width;
    this.rgba = new Uint8ClampedArray(width * MAP_HEIGHT * 4);
    this.known = new Uint8Array(width / 8); // per 8px column
    this.extent = 0; // rightmost known pixel + 1
    this.dirty = false;
  }

  /** Copy the columns currently on screen. Call after nes.frame(). */
  capture(nes) {
    const m = nes.cpu.mem;
    if (m[RAM.OperMode] !== 1) return;
    if (this.area === null) this.area = areaKey(m);
    if (areaKey(m) !== this.area) return;
    const ppu = nes.ppu;
    if (!ppu.f_bgVisibility) return;
    const cam = cameraX(m);
    const pal = ppu.imgPalette;
    const bank = ppu.f_bgPatternTable ? 256 : 0;
    const sky = pal[0];
    const first = cam >> 3;
    const last = Math.min((cam + 255) >> 3, this.known.length - 1);
    for (let col = first; col <= last; col++) {
      // First capture wins: the map shows the level as a player first sees it
      // (unbumped ? blocks, unbroken bricks), and settled columns cost nothing.
      if (this.known[col]) continue;
      const nt = ppu.nameTable[ppu.ntable1[(col >> 5) & 1]];
      const tx = col & 31;
      const px0 = col * 8;
      for (let ty = 0; ty < 30; ty++) {
        if (ty < 4) {
          for (let py = 0; py < 8; py++) for (let px = 0; px < 8; px++) this.#put(px0 + px, ty * 8 + py, sky);
          continue;
        }
        const tile = ppu.ptTile[nt.getTileIndex(tx, ty) + bank];
        const att = nt.getAttrib(tx, ty);
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const c = tile.pix[py * 8 + px];
            this.#put(px0 + px, ty * 8 + py, c ? pal[c + att] : sky);
          }
        }
      }
      this.known[col] = 1;
      this.dirty = true;
      this.extent = Math.max(this.extent, px0 + 8);
    }
  }

  #put(x, y, v) {
    const i = (y * this.width + x) * 4;
    this.rgba[i] = v & 0xff;
    this.rgba[i + 1] = (v >> 8) & 0xff;
    this.rgba[i + 2] = (v >> 16) & 0xff;
    this.rgba[i + 3] = 255;
  }

  knownFraction(upTo = this.extent) {
    let n = 0;
    const cols = Math.ceil(upTo / 8);
    for (let i = 0; i < cols; i++) n += this.known[i];
    return cols ? n / cols : 0;
  }
}
