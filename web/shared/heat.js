// Death density: counts on a coarse grid, Gaussian-blurred, coloured through
// a sequential ramp whose lightness rises with density, drawn over a dimmed,
// grey copy of the level so the colour is the only colour on screen.

export class HeatGrid {
  /** width/height in level pixels; cell = grid resolution in pixels. */
  constructor(width, height = 240, cell = 4, sigmaPx = 9) {
    this.cell = cell;
    this.gw = Math.ceil(width / cell);
    this.gh = Math.ceil(height / cell);
    this.counts = new Float32Array(this.gw * this.gh);
    this.sigma = sigmaPx / cell;
    this.blurred = null;
    this.peak = 0;
    this.n = 0;
  }

  clear() {
    this.counts.fill(0);
    this.blurred = null;
    this.n = 0;
  }

  add(x, y, w = 1) {
    const gx = Math.floor(x / this.cell), gy = Math.floor(y / this.cell);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return;
    this.counts[gy * this.gw + gx] += w;
    this.blurred = null;
    this.n += w;
  }

  /** Blurred density; cached until the next add(). */
  density() {
    if (this.blurred) return this.blurred;
    const { gw, gh } = this;
    const r = Math.ceil(this.sigma * 3);
    const k = new Float32Array(r * 2 + 1);
    let ks = 0;
    for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * this.sigma * this.sigma));
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    const tmp = new Float32Array(gw * gh);
    const out = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < gw) s += this.counts[y * gw + xx] * k[i + r]; }
      tmp[y * gw + x] = s;
    }
    let peak = 0;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) { const yy = y + i; if (yy >= 0 && yy < gh) s += tmp[yy * gw + x] * k[i + r]; }
      out[y * gw + x] = s;
      if (s > peak) peak = s;
    }
    this.blurred = out;
    this.peak = peak;
    return out;
  }
}

/** 256-entry RGBA ramp from [[t, '#rrggbb', alpha], ...] stops. */
export function makeRamp(stops) {
  const lut = new Uint8ClampedArray(256 * 4);
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = stops[0], b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
    const u = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
    const ca = rgb(a[1]), cb = rgb(b[1]);
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = ca[c] + (cb[c] - ca[c]) * u;
    lut[i * 4 + 3] = 255 * (a[2] + (b[2] - a[2]) * u);
  }
  return lut;
}

// People: one warm ramp, dark red → orange → pale yellow; lightness only rises.
export const RAMP_PEOPLE = makeRamp([
  [0, '#5c0f0f', 0],
  [0.08, '#8f1d1d', 0.55],
  [0.3, '#d23a26', 0.8],
  [0.6, '#f2872f', 0.9],
  [0.85, '#ffd27a', 0.95],
  [1, '#fff4d6', 1],
]);

// AI: one cool ramp (the palette's sequential blue), dark → light.
export const RAMP_AI = makeRamp([
  [0, '#0d366b', 0],
  [0.08, '#184f95', 0.55],
  [0.3, '#2a78d6', 0.8],
  [0.6, '#6da7ec', 0.9],
  [0.85, '#b7d3f6', 0.95],
  [1, '#f2f8ff', 1],
]);

/**
 * Colourise a HeatGrid into an offscreen canvas at grid resolution. Values are
 * normalised by `norm` (default: the grid's own peak) and passed through a
 * square root so a single death still shows while the hottest spot saturates.
 */
export function heatCanvas(grid, ramp, norm = 0) {
  const d = grid.density();
  const peak = norm || grid.peak || 1;
  const c = new OffscreenCanvas(grid.gw, grid.gh);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(grid.gw, grid.gh);
  for (let i = 0; i < d.length; i++) {
    const v = Math.min(1, Math.sqrt(d[i] / peak));
    if (v < 0.02) continue;
    const j = Math.round(v * 255) * 4;
    img.data[i * 4] = ramp[j];
    img.data[i * 4 + 1] = ramp[j + 1];
    img.data[i * 4 + 2] = ramp[j + 2];
    img.data[i * 4 + 3] = ramp[j + 3];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** A grey, dimmed copy of a level image, so the heat is the only colour. */
export function greyCopy(img, dim = 0.42) {
  const c = new OffscreenCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.filter = `grayscale(1) brightness(${dim})`;
  ctx.drawImage(img, 0, 0);
  return c;
}

/** Draw part of the level (level px sx..sx+sw, sy..sy+sh) with heat on top.
 *  Pass a greyCopy() as `map` with grey: true to skip the per-frame filter. */
export function drawHeatView(ctx, { map, heat, cell, sx, sy = 0, sw, sh = 240, dx = 0, dy = 0, dw, dh, dim = 0.42, grey = false }) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (map) {
    if (!grey) ctx.filter = `grayscale(1) brightness(${dim})`;
    ctx.drawImage(map, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.filter = 'none';
  }
  if (heat) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(heat, sx / cell, sy / cell, sw / cell, sh / cell, dx, dy, dw, dh);
  }
  ctx.restore();
}
