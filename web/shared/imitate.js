// Learning from people: fit a network that copies what players pressed in
// each situation, then hand it to NEAT as one more brain in the population.
//
// The fit is one logistic regression per button (A, B, left, right) over the
// AI's inputs. That is exactly a NEAT network with direct input->output links:
// NEAT presses a button when the weighted sum is above 0, and a logistic model
// predicts "pressed" when its sum is above 0. We keep only the strongest
// connections (so the brain stays small enough to draw), fine-tune those, and
// convert them into genes.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OUTS = 4;
const sig = (z) => 1 / (1 + Math.exp(-z));

/**
 * Per-button weights that make presses and non-presses count equally, done
 * separately on the ground and in the air. People hold A through most of a
 * jump but press it on the ground in only ~6% of moments, and those few
 * take-offs are what save Mario. Without this the model learns "hold A in
 * the air" and never jumps.  Returns cw[o][context][pressed].
 */
function classWeights(data) {
  const pos = Array.from({ length: OUTS }, () => [0, 0]);
  const tot = [0, 0];
  for (let r = 0; r < data.n; r++) {
    const c = data.C ? data.C[r] : 0;
    tot[c]++;
    for (let o = 0; o < OUTS; o++) pos[o][c] += (data.Y[r] >> o) & 1;
  }
  return pos.map((pc) => [0, 1].map((c) => {
    if (!tot[c]) return [1, 1];
    const rate = Math.min(0.97, Math.max(0.03, pc[c] / tot[c]));
    const share = tot[c] / (data.n || 1); // keep each context's overall say
    return [(0.5 / (1 - rate)) * share, (0.5 / rate) * share];
  }));
}

function fit(data, w, mask, { epochs, lr, l2, batch, seed }) {
  const { X, Y, W, n, D } = data;
  const S = D + 1;
  const cw = classWeights(data);
  const m1 = new Float32Array(w.length), m2 = new Float32Array(w.length), g = new Float32Array(w.length);
  const idx = Uint32Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed);
  let t = 0;
  for (let e = 0; e < epochs; e++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (let b0 = 0; b0 < n; b0 += batch) {
      g.fill(0);
      let wsum = 0;
      for (let k = b0; k < Math.min(n, b0 + batch); k++) {
        const r = idx[k], o0 = r * D, wr = W[r];
        wsum += wr;
        for (let o = 0; o < OUTS; o++) {
          const base = o * S;
          let z = w[base + D];
          for (let i = 0; i < D; i++) { const x = X[o0 + i]; if (x !== 0) z += w[base + i] * x; }
          const y = (Y[r] >> o) & 1;
          const err = (sig(z) - y) * wr * cw[o][data.C ? data.C[r] : 0][y];
          for (let i = 0; i < D; i++) { const x = X[o0 + i]; if (x !== 0) g[base + i] += err * x; }
          g[base + D] += err;
        }
      }
      t++;
      for (let p = 0; p < w.length; p++) {
        if (mask && !mask[p]) continue;
        const grad = g[p] / (wsum || 1) + l2 * w[p];
        m1[p] = 0.9 * m1[p] + 0.1 * grad;
        m2[p] = 0.999 * m2[p] + 0.001 * grad * grad;
        w[p] -= (lr * (m1[p] / (1 - 0.9 ** t))) / (Math.sqrt(m2[p] / (1 - 0.999 ** t)) + 1e-8);
      }
    }
  }
}

/** Balanced agreement per button: the average of "pressed when they pressed"
 *  and "held off when they held off", so never pressing scores 50%, not 90%. */
export function agreement(data, w) {
  const { X, Y, n, D } = data;
  const S = D + 1;
  const tp = new Float64Array(OUTS), pos = new Float64Array(OUTS), tn = new Float64Array(OUTS), neg = new Float64Array(OUTS);
  for (let r = 0; r < n; r++) {
    for (let o = 0; o < OUTS; o++) {
      let z = w[o * S + D];
      for (let i = 0; i < D; i++) { const x = X[r * D + i]; if (x !== 0) z += w[o * S + i] * x; }
      const y = (Y[r] >> o) & 1, p = z > 0 ? 1 : 0;
      if (y) { pos[o]++; tp[o] += p; } else { neg[o]++; tn[o] += 1 - p; }
    }
  }
  return Array.from({ length: OUTS }, (_, o) => {
    const parts = [];
    if (pos[o]) parts.push(tp[o] / pos[o]);
    if (neg[o]) parts.push(tn[o] / neg[o]);
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 1;
  });
}

/**
 * Fit the copy-people policy. Returns { weights, agreement } where weights is
 * Float32Array(4 * (D+1)), bias last in each row, and at most `keep` non-bias
 * weights are non-zero.
 */
export function learnFromPeople(data, { keep = 40, seed = 1 } = {}) {
  const S = data.D + 1;
  const w = new Float32Array(OUTS * S);
  fit(data, w, null, { epochs: 10, lr: 0.05, l2: 1e-4, batch: 256, seed });
  // keep the strongest connections (biases always stay)
  const order = [];
  for (let o = 0; o < OUTS; o++) for (let i = 0; i < data.D; i++) order.push(o * S + i);
  order.sort((a, b) => Math.abs(w[b]) - Math.abs(w[a]));
  const mask = new Uint8Array(w.length);
  for (let o = 0; o < OUTS; o++) mask[o * S + data.D] = 1;
  for (const p of order.slice(0, keep)) if (Math.abs(w[p]) > 1e-3) mask[p] = 1;
  for (let p = 0; p < w.length; p++) if (!mask[p]) w[p] = 0;
  fit(data, w, mask, { epochs: 6, lr: 0.03, l2: 1e-4, batch: 256, seed: seed + 1 });
  return { weights: w, agreement: agreement(data, w) };
}

/**
 * Weights -> NEAT links for a network with nIn inputs (bias = nIn-1) and 4
 * outputs. Each button's weights are scaled so the largest is `maxWeight`:
 * a button fires on the sign of its sum, so this changes no decision, but it
 * puts the weights in the range NEAT's small mutations can actually move.
 */
export function weightsToLinks(weights, nIn, { maxWeight = 1.5 } = {}) {
  const D = nIn - 1, S = D + 1;
  const links = [];
  for (let o = 0; o < OUTS; o++) {
    let big = 0;
    for (let i = 0; i <= D; i++) big = Math.max(big, Math.abs(weights[o * S + i]));
    const k = big > 0 ? maxWeight / big : 1;
    for (let i = 0; i < D; i++) if (weights[o * S + i] !== 0) links.push({ into: i, out: nIn + o, weight: weights[o * S + i] * k });
    links.push({ into: nIn - 1, out: nIn + o, weight: weights[o * S + D] * k });
  }
  return links;
}
