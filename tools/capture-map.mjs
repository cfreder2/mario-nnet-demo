#!/usr/bin/env node
// Builds the background image of World 1-1 (no sprites, no HUD) by playing
// through it headlessly: a bot holds right with star power on, and rewinds a
// couple of seconds whenever it falls into a pit or gets stuck. The image is
// stitched from the PPU nametables as the camera scrolls (see LevelMap).
//
//   node tools/capture-map.mjs [--rom rom/smb-duckhunt.nes] [--out data/maps]
//
// Output: data/maps/1-1.png and data/maps/1-1.json (width, flag x, area).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './png.mjs';
import { createNES, bootToTitle, startFromTitle, setButtons, BTN, RAM, LevelMap, playerLevelX, levelName, areaKey } from '../web/shared/smb.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const romPath = resolve(ROOT, arg('--rom', 'rom/smb-duckhunt.nes'));
const outDir = resolve(ROOT, arg('--out', 'data/maps'));

export function captureLevel11(romBytes, { log = () => {} } = {}) {
  const nes = createNES();
  bootToTitle(nes, romBytes);
  startFromTitle(nes);
  let m = nes.cpu.mem; // fromJSON() builds a new CPU, so re-read after every rewind
  const area = areaKey(m);
  const map = new LevelMap(area);
  const saves = [];
  let rng = 12345;
  const rand = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 2 ** 32);
  let best = 0, stuck = 0, jump = 0, cool = 0, rewinds = 0, jumpLen = 32;
  let record = 0, fails = 0;
  for (let f = 0; f < 40000; f++) {
    if (f % 20 === 0 && m[RAM.PlayerYHigh] === 1 && m[RAM.Engine] === 8) {
      saves.push(JSON.stringify(nes.toJSON()));
      if (saves.length > 30) saves.shift();
    }
    m[0x079f] = 0x20; // keep star power on: only pits and walls can stop us
    const x = playerLevelX(m);
    if (x > best) { best = x; stuck = 0; } else stuck++;
    if (x > record + 64) { record = x; fails = 0; }
    if (cool > 0) cool--;
    if (jump === 0 && cool === 0 && (stuck > 6 || rand() < 0.02)) jump = jumpLen;
    let mask = (1 << BTN.RIGHT) | (1 << BTN.B);
    if (jump > 0) { mask |= 1 << BTN.A; if (--jump === 0) cool = 4; }
    setButtons(nes, 1, mask);
    nes.frame();
    map.capture(nes);

    if (m[RAM.Engine] === 4 || m[RAM.Engine] === 5) {
      // flagpole: keep running a little so the castle scrolls into view
      for (let k = 0; k < 400; k++) { nes.frame(); map.capture(nes); }
      log(`reached the flag at x=${x} after ${f} frames, ${rewinds} rewinds`);
      return { map, area, flagX: x, level: levelName(m) };
    }
    const fell = m[RAM.PlayerYHigh] >= 2;
    if ((fell || stuck > 240) && saves.length > 1) {
      fails++;
      const back = Math.min(saves.length - 1, 1 + fails);
      saves.length -= back;
      nes.fromJSON(JSON.parse(saves[saves.length - 1]));
      m = nes.cpu.mem;
      rewinds++;
      jumpLen = 12 + Math.floor(rand() * 24);
      best = playerLevelX(m); stuck = 0; jump = 0; cool = 0;
    }
  }
  throw new Error(`gave up at x=${best}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rom = new Uint8Array(readFileSync(romPath));
  const t0 = performance.now();
  const { map, area, flagX, level } = captureLevel11(rom, { log: console.log });
  const width = Math.ceil(map.extent / 16) * 16;
  const crop = new Uint8ClampedArray(width * 240 * 4);
  for (let y = 0; y < 240; y++) crop.set(map.rgba.subarray(y * map.width * 4, y * map.width * 4 + width * 4), y * width * 4);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, `${level}.png`), encodePNG(width, 240, crop));
  writeFileSync(resolve(outDir, `${level}.json`), JSON.stringify({ level, area, width, flagX, known: map.knownFraction(width) }, null, 2));
  console.log(`wrote ${level}.png (${width}x240, ${(map.knownFraction(width) * 100).toFixed(1)}% of columns captured, area ${area}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
