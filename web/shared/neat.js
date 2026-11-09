// NEAT: NeuroEvolution of Augmenting Topologies (Stanley & Miikkulainen, 2002).
//
// Networks start with almost no connections and grow: mutations add links,
// split links into new hidden neurons, and nudge weights. Genomes are grouped
// into species by structural similarity so new structure gets a few
// generations to prove itself before competing with everything else.
//
// The generation loop and constants follow SethBling's MarI/O, which is the
// version most people have seen learn Super Mario Bros. Two differences:
// networks are kept acyclic (so they can be drawn left to right and evaluated
// in one exact pass), and outputs never feed back into hidden neurons.
//
// No dependencies; runs in the browser, in workers and in Node.

export const NEAT_DEFAULTS = {
  population: 300,
  deltaDisjoint: 2.0,
  deltaWeights: 0.4,
  deltaThreshold: 1.0,
  staleSpecies: 15,
  mutateConnectionsChance: 0.25,
  perturbChance: 0.9,
  crossoverChance: 0.75,
  linkMutationChance: 2.0,
  nodeMutationChance: 0.5,
  biasMutationChance: 0.4,
  stepSize: 0.1,
  disableMutationChance: 0.4,
  enableMutationChance: 0.2,
  // Original NEAT's population-stagnation rule (MarI/O leaves it out): when the
  // best score has not improved for this many generations, only the two best
  // species are kept, so the search focuses where it is closest to a
  // breakthrough. 0 turns it off.
  stagnationGens: 0,
};

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

export function sigmoid(x) {
  return 2 / (1 + Math.exp(-4.9 * x)) - 1;
}

/**
 * Build an evaluable network from a genome: enabled genes only, nodes in
 * topological order. Inputs are ids 0..nIn-1 (the last input is the bias,
 * always 1), outputs nIn..nIn+nOut-1, hidden neurons above that.
 */
export function buildNetwork(genome, nIn, nOut) {
  const incoming = new Map(); // node -> [[from, weight], ...]
  const nodes = new Set();
  for (const g of genome.genes) {
    if (!g.enabled) continue;
    nodes.add(g.into);
    nodes.add(g.out);
    if (!incoming.has(g.out)) incoming.set(g.out, []);
    incoming.get(g.out).push([g.into, g.weight]);
  }
  for (let o = 0; o < nOut; o++) nodes.add(nIn + o);
  // Kahn's algorithm over non-input nodes
  const indeg = new Map();
  const outgoing = new Map();
  for (const n of nodes) if (n >= nIn) indeg.set(n, 0);
  for (const [to, list] of incoming) {
    for (const [from] of list) {
      if (from >= nIn) {
        indeg.set(to, indeg.get(to) + 1);
        if (!outgoing.has(from)) outgoing.set(from, []);
        outgoing.get(from).push(to);
      }
    }
  }
  const queue = [];
  for (const [n, d] of indeg) if (d === 0) queue.push(n);
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const to of outgoing.get(n) || []) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  return { nIn, nOut, order, incoming, values: new Map() };
}

/** Run the network; returns Float32Array of output activations. */
export function activate(net, inputs) {
  const v = net.values;
  v.clear();
  for (let i = 0; i < net.nIn - 1; i++) v.set(i, inputs[i]);
  v.set(net.nIn - 1, 1); // bias
  for (const n of net.order) {
    const list = net.incoming.get(n);
    let sum = 0;
    if (list) for (const [from, w] of list) sum += (v.get(from) || 0) * w;
    v.set(n, list ? sigmoid(sum) : 0);
  }
  const out = new Float32Array(net.nOut);
  for (let o = 0; o < net.nOut; o++) out[o] = v.get(net.nIn + o) || 0;
  return out;
}

export class Pool {
  constructor({ inputs, outputs, config = {}, seed = (Math.random() * 2 ** 32) >>> 0 }) {
    this.nIn = inputs; // includes the bias input
    this.nOut = outputs;
    this.cfg = { ...NEAT_DEFAULTS, ...config };
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.innovation = 0;
    this.nextGenomeId = 1;
    this.generation = 0;
    this.maxFitness = 0;
    this.bestEver = -Infinity;
    this.stagnant = 0;
    this.species = [];
    this.history = []; // per generation summaries
    for (let i = 0; i < this.cfg.population; i++) {
      const g = this._basicGenome();
      this._addToSpecies(g);
    }
  }

  // ---- serialisation ------------------------------------------------------
  toJSON() {
    return {
      nIn: this.nIn, nOut: this.nOut, cfg: this.cfg, seed: this.seed,
      innovation: this.innovation, nextGenomeId: this.nextGenomeId,
      generation: this.generation, maxFitness: this.maxFitness,
      species: this.species, history: this.history,
    };
  }

  static fromJSON(o) {
    const p = Object.create(Pool.prototype);
    Object.assign(p, o);
    p.rand = mulberry32((o.seed + o.generation * 7919) >>> 0);
    return p;
  }

  // ---- access ---------------------------------------------------------------
  /** All genomes of the current generation, species champions first. */
  genomes() {
    const firsts = [], rest = [];
    for (const s of this.species) {
      s.genomes.forEach((g, i) => (i === 0 ? firsts : rest).push(g));
    }
    return [...firsts, ...rest];
  }

  speciesOf(genomeId) {
    return this.species.findIndex((s) => s.genomes.some((g) => g.id === genomeId));
  }

  best() {
    let b = null;
    for (const s of this.species) for (const g of s.genomes) if (!b || g.fitness > b.fitness) b = g;
    return b;
  }

  // ---- genomes --------------------------------------------------------------
  _newGenome() {
    return {
      id: this.nextGenomeId++,
      genes: [],
      maxNeuron: this.nIn + this.nOut - 1,
      fitness: 0,
      globalRank: 0,
      evaluated: false,
      rates: {
        connections: this.cfg.mutateConnectionsChance,
        link: this.cfg.linkMutationChance,
        bias: this.cfg.biasMutationChance,
        node: this.cfg.nodeMutationChance,
        enable: this.cfg.enableMutationChance,
        disable: this.cfg.disableMutationChance,
        step: this.cfg.stepSize,
      },
    };
  }

  _basicGenome() {
    const g = this._newGenome();
    this._mutate(g);
    return g;
  }

  _copy(g) {
    const c = this._newGenome();
    c.genes = g.genes.map((x) => ({ ...x }));
    c.maxNeuron = g.maxNeuron;
    c.rates = { ...g.rates };
    if (g.taught) c.taught = true; // descends from a brain learned from people
    return c;
  }

  _crossover(a, b) {
    if (b.fitness > a.fitness) [a, b] = [b, a];
    const child = this._newGenome();
    const byInnov = new Map();
    for (const g of b.genes) byInnov.set(g.innovation, g);
    for (const g of a.genes) {
      const other = byInnov.get(g.innovation);
      const pick = other && other.enabled && this.rand() < 0.5 ? other : g;
      child.genes.push({ ...pick });
    }
    child.maxNeuron = Math.max(a.maxNeuron, b.maxNeuron);
    child.rates = { ...a.rates };
    if (a.taught || b.taught) child.taught = true;
    return child;
  }

  _isInput(n) { return n < this.nIn; }
  _isOutput(n) { return n >= this.nIn && n < this.nIn + this.nOut; }

  _randomNeuron(genes, asTarget) {
    const pool = new Set();
    if (!asTarget) for (let i = 0; i < this.nIn; i++) pool.add(i);
    else for (let o = 0; o < this.nOut; o++) pool.add(this.nIn + o);
    for (const g of genes) {
      for (const n of [g.into, g.out]) {
        if (this._isInput(n) || this._isOutput(n)) continue;
        pool.add(n); // hidden neurons can be sources or targets
      }
    }
    const arr = [...pool];
    return arr[Math.floor(this.rand() * arr.length)];
  }

  _reaches(genes, from, to) {
    // is there a path from -> to using any gene (enabled or not)?
    const adj = new Map();
    for (const g of genes) {
      if (!adj.has(g.into)) adj.set(g.into, []);
      adj.get(g.into).push(g.out);
    }
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const n = stack.pop();
      if (n === to) return true;
      for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
    return false;
  }

  _linkMutate(g, forceBias) {
    let from = forceBias ? this.nIn - 1 : this._randomNeuron(g.genes, false);
    let to = this._randomNeuron(g.genes, true);
    if (from === to) return;
    if (g.genes.some((x) => x.into === from && x.out === to)) return;
    if (this._reaches(g.genes, to, from)) return; // would make a cycle
    g.genes.push({ into: from, out: to, weight: this.rand() * 4 - 2, enabled: true, innovation: ++this.innovation });
  }

  _nodeMutate(g) {
    if (!g.genes.length) return;
    const gene = g.genes[Math.floor(this.rand() * g.genes.length)];
    if (!gene.enabled) return;
    gene.enabled = false;
    const n = ++g.maxNeuron;
    g.genes.push({ into: gene.into, out: n, weight: 1, enabled: true, innovation: ++this.innovation });
    g.genes.push({ into: n, out: gene.out, weight: gene.weight, enabled: true, innovation: ++this.innovation });
  }

  _pointMutate(g) {
    const step = g.rates.step;
    for (const gene of g.genes) {
      if (this.rand() < this.cfg.perturbChance) gene.weight += this.rand() * step * 2 - step;
      else gene.weight = this.rand() * 4 - 2;
    }
  }

  _enableDisable(g, enable) {
    const c = g.genes.filter((x) => x.enabled !== enable);
    if (!c.length) return;
    c[Math.floor(this.rand() * c.length)].enabled = enable;
  }

  _mutate(g) {
    for (const k of Object.keys(g.rates)) g.rates[k] *= this.rand() < 0.5 ? 0.95 : 1.05263;
    if (this.rand() < g.rates.connections) this._pointMutate(g);
    for (let p = g.rates.link; p > 0; p--) if (this.rand() < p) this._linkMutate(g, false);
    for (let p = g.rates.bias; p > 0; p--) if (this.rand() < p) this._linkMutate(g, true);
    for (let p = g.rates.node; p > 0; p--) if (this.rand() < p) this._nodeMutate(g);
    for (let p = g.rates.enable; p > 0; p--) if (this.rand() < p) this._enableDisable(g, true);
    for (let p = g.rates.disable; p > 0; p--) if (this.rand() < p) this._enableDisable(g, false);
  }

  // ---- speciation -------------------------------------------------------------
  _sameSpecies(a, b) {
    const ia = new Map(a.genes.map((x) => [x.innovation, x]));
    const ib = new Map(b.genes.map((x) => [x.innovation, x]));
    let disjoint = 0, coincident = 0, wsum = 0;
    for (const [k, x] of ia) {
      const y = ib.get(k);
      if (y) { coincident++; wsum += Math.abs(x.weight - y.weight); } else disjoint++;
    }
    for (const k of ib.keys()) if (!ia.has(k)) disjoint++;
    const n = Math.max(a.genes.length, b.genes.length) || 1;
    const dd = this.cfg.deltaDisjoint * (disjoint / n);
    const dw = this.cfg.deltaWeights * (coincident ? wsum / coincident : 0);
    return dd + dw < this.cfg.deltaThreshold;
  }

  _addToSpecies(child) {
    for (const s of this.species) {
      if (this._sameSpecies(child, s.genomes[0])) { s.genomes.push(child); return; }
    }
    this.species.push({ id: this.nextGenomeId++, topFitness: 0, staleness: 0, averageFitness: 0, genomes: [child] });
  }

  // ---- outside brains ---------------------------------------------------------------
  /** A genome built from explicit links, e.g. a network learned from people. */
  genomeFromLinks(links, { taught = false } = {}) {
    const g = this._newGenome();
    for (const l of links) g.genes.push({ into: l.into, out: l.out, weight: l.weight, enabled: true, innovation: ++this.innovation });
    if (taught) g.taught = true;
    return g;
  }

  /** A mutated copy of g (keeps its lineage mark). */
  variantOf(g) {
    const c = this._copy(g);
    this._mutate(c);
    return c;
  }

  /**
   * Add genomes to the current, not-yet-tested generation. Each one takes the
   * place of an untested child from the biggest species, so the population
   * size stays the same and no champion is ever displaced.
   */
  inject(genomes) {
    const batch = new Set(genomes);
    for (const g of genomes) {
      // evict the last (untested) child of the biggest species; never a
      // species' first genome (its champion) and never one of this batch
      let from = null;
      for (const s of this.species) {
        if (s.genomes.length < 2 || batch.has(s.genomes[s.genomes.length - 1])) continue;
        if (!from || s.genomes.length > from.genomes.length) from = s;
      }
      if (from) from.genomes.pop();
      else {
        // generation 0: every species is a single untested genome; drop one
        const k = this.species.findIndex((s) => s.genomes.length === 1 && !batch.has(s.genomes[0]) && typeof s.genomes[0].progress !== 'number');
        if (k >= 0) this.species.splice(k, 1);
      }
      this._addToSpecies(g);
    }
  }

  // ---- generation step ----------------------------------------------------------
  setFitness(id, fitness) {
    for (const s of this.species) for (const g of s.genomes) {
      if (g.id === id) { g.fitness = fitness; g.evaluated = true; if (fitness > this.maxFitness) this.maxFitness = fitness; return g; }
    }
    return null;
  }

  _cull(cutToOne) {
    for (const s of this.species) {
      s.genomes.sort((a, b) => b.fitness - a.fitness);
      const keep = cutToOne ? 1 : Math.ceil(s.genomes.length / 2);
      s.genomes.length = Math.min(s.genomes.length, keep);
    }
  }

  _rankGlobally() {
    const all = [];
    for (const s of this.species) for (const g of s.genomes) all.push(g);
    all.sort((a, b) => a.fitness - b.fitness);
    all.forEach((g, i) => (g.globalRank = i + 1));
  }

  _breedChild(s) {
    let child;
    if (this.rand() < this.cfg.crossoverChance) {
      const a = s.genomes[Math.floor(this.rand() * s.genomes.length)];
      const b = s.genomes[Math.floor(this.rand() * s.genomes.length)];
      child = this._crossover(a, b);
    } else {
      child = this._copy(s.genomes[Math.floor(this.rand() * s.genomes.length)]);
    }
    this._mutate(child);
    return child;
  }

  /** Summarise the finished generation, then breed the next one. */
  nextGeneration(extra = {}) {
    const best = this.best();
    const all = this.genomes();
    const fits = all.map((g) => g.fitness);
    this.history.push({
      generation: this.generation,
      maxFitness: Math.max(...fits),
      meanFitness: fits.reduce((a, b) => a + b, 0) / fits.length,
      species: this.species.length,
      bestId: best.id,
      bestNodes: new Set(best.genes.flatMap((g) => [g.into, g.out]).filter((n) => n >= this.nIn + this.nOut)).size,
      bestLinks: best.genes.filter((g) => g.enabled).length,
      bestTaught: !!best.taught,
      best: { ...best, genes: best.genes.map((g) => ({ ...g })) },
      ...extra,
    });

    const top = Math.max(...fits);
    if (top > (this.bestEver ?? -Infinity)) { this.bestEver = top; this.stagnant = 0; } else this.stagnant = (this.stagnant || 0) + 1;

    this._cull(false);
    this._rankGlobally();
    // drop species that stopped improving (unless they hold the record)
    this.species = this.species.filter((s) => {
      const top = s.genomes[0].fitness;
      if (top > s.topFitness) { s.topFitness = top; s.staleness = 0; } else s.staleness++;
      return s.staleness < this.cfg.staleSpecies || s.topFitness >= this.maxFitness;
    });
    if (this.cfg.stagnationGens > 0 && this.stagnant >= this.cfg.stagnationGens && this.species.length > 2) {
      this.species.sort((a, b) => b.genomes[0].fitness - a.genomes[0].fitness);
      this.species.length = 2;
      this.stagnant = 0;
      this.history[this.history.length - 1].refocused = true;
    }
    this._rankGlobally();
    for (const s of this.species) s.averageFitness = s.genomes.reduce((a, g) => a + g.globalRank, 0) / s.genomes.length;
    let sum = this.species.reduce((a, s) => a + s.averageFitness, 0);
    this.species = this.species.filter((s) => Math.floor((s.averageFitness / sum) * this.cfg.population) >= 1);
    sum = this.species.reduce((a, s) => a + s.averageFitness, 0);

    const children = [];
    for (const s of this.species) {
      const breed = Math.floor((s.averageFitness / sum) * this.cfg.population) - 1;
      for (let i = 0; i < breed; i++) children.push(this._breedChild(s));
    }
    this._cull(true); // each species keeps only its champion, unchanged
    while (children.length + this.species.length < this.cfg.population) {
      children.push(this._breedChild(this.species[Math.floor(this.rand() * this.species.length)]));
    }
    for (const s of this.species) for (const g of s.genomes) g.evaluated = false;
    for (const c of children) this._addToSpecies(c);
    this.generation++;
    // keep the stored history small: full genome only for the last 3
    for (let i = 0; i < this.history.length - 3; i++) delete this.history[i].best;
  }
}
