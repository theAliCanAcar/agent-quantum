/**
 * agent-quantum: keep every crazy answer alive at once and only commit to one
 * when reality forces you to. Superpositions, weighted observation, thought
 * amplification, and entangled pairs — Schrödinger's demo, minus the cat.
 *
 *   const ideas = superpose(["email agent", "invoice bot", "cat translator"]);
 *   const bold = ideas.amplify((s) => s.includes("cat"), 9000);
 *   const pick = bold.observe({ seed: 7 }); // collapses exactly once
 */

export type WeightedState<S> = { state: S; weight: number };

export type ProbableState<S> = { state: S; weight: number; probability: number };

export type ObserveOptions<S> = {
  /** Seed for reproducible collapse. Default 1337. */
  seed?: number;
  /**
   * Measurement basis: score every state and collapse to the highest score
   * (deterministic — no dice). Without a scorer, collapse is weighted-random.
   */
  scorer?: (state: S, index: number) => number;
};

export type Superposition<S> = {
  readonly states: ReadonlyArray<WeightedState<S>>;
  /** Set once the wavefunction has collapsed; undefined while coherent. */
  readonly collapsed: { index: number; state: S } | undefined;
  /** Probability amplitudes without collapsing anything. */
  peek(): ProbableState<S>[];
  /** Collapse to a single state (idempotent: later calls return the same state). */
  observe(options?: ObserveOptions<S>): S;
  /** Boost (or damp) the amplitude of matching states — bias the odds. */
  amplify(predicate: (state: S, index: number) => boolean, factor?: number): Superposition<S>;
  /** Transform every candidate while keeping its amplitude. */
  map<T>(fn: (state: S, index: number) => T): Superposition<T>;
};

export type Entangled<A, B> = {
  left: Superposition<A>;
  right: Superposition<B>;
  /** Measure the pair: both sides collapse consistently in one step. */
  observe(options?: { seed?: number }): { left: A; right: B };
};

type PartnerLink = {
  target: SupInternal<unknown>;
  toTarget: (index: number) => number;
};

type SupInternal<S> = Superposition<S> & {
  _partners: PartnerLink[];
  _forceCollapse(index: number): void;
};

/**
 * Put states into coherent superposition. Plain values get equal amplitude;
 * pass `{ state, weight }` to skew the odds.
 */
export function superpose<S>(states: Array<S | WeightedState<S>>): Superposition<S> {
  const weighted: WeightedState<S>[] = states.map((entry) =>
    isWeighted(entry) ? { state: entry.state, weight: entry.weight } : { state: entry as S, weight: 1 }
  );
  if (weighted.length === 0) {
    throw new Error("superpose() needs at least one state.");
  }

  let collapsed: { index: number; state: S } | undefined;
  const partners: PartnerLink[] = [];

  function collapseAt(index: number): void {
    if (collapsed) return;
    const clamped = Math.min(Math.max(index, 0), weighted.length - 1);
    collapsed = { index: clamped, state: weighted[clamped].state };
    for (const partner of partners) {
      partner.target._forceCollapse(partner.toTarget(clamped));
    }
  }

  const sup: SupInternal<S> = {
    states: weighted,
    get collapsed() {
      return collapsed;
    },
    _partners: partners,
    _forceCollapse: collapseAt,
    peek(): ProbableState<S>[] {
      const total = totalWeight(weighted);
      return weighted.map((w) => ({
        state: w.state,
        weight: w.weight,
        probability: total > 0 ? w.weight / total : 1 / weighted.length,
      }));
    },
    observe(options: ObserveOptions<S> = {}): S {
      if (collapsed) return collapsed.state;
      let index: number;
      if (options.scorer) {
        index = argmaxScore(weighted, options.scorer);
      } else {
        index = weightedPick(weighted, seededRandom(options.seed ?? 1337));
      }
      collapseAt(index);
      return weighted[index].state;
    },
    amplify(predicate: (state: S, index: number) => boolean, factor = 2): Superposition<S> {
      return superpose(
        weighted.map((w, i) => ({ state: w.state, weight: predicate(w.state, i) ? w.weight * factor : w.weight }))
      );
    },
    map<T>(fn: (state: S, index: number) => T): Superposition<T> {
      return superpose(weighted.map((w, i) => ({ state: fn(w.state, i), weight: w.weight })));
    },
  };
  return sup;
}

/**
 * Entangle two superpositions: measuring one instantly collapses the other.
 * `correlate` maps a left-hand index to the matching right-hand index
 * (identity by default). Keep it bijective if you want symmetric behavior.
 */
export function entangle<A, B>(
  left: Superposition<A>,
  right: Superposition<B>,
  correlate: (leftIndex: number) => number = (i) => i
): Entangled<A, B> {
  const l = left as unknown as SupInternal<A>;
  const r = right as unknown as SupInternal<B>;
  const uncorrelate = reverseMap(correlate, l.states.length);

  l._partners.push({ target: r as unknown as SupInternal<unknown>, toTarget: correlate });
  r._partners.push({ target: l as unknown as SupInternal<unknown>, toTarget: uncorrelate });

  return {
    left,
    right,
    observe(options: { seed?: number } = {}) {
      const leftState = l.observe(options);
      return { left: leftState, right: r.collapsed!.state };
    },
  };
}

/** True once a superposition has been measured. */
export function isCollapsed<S>(sup: Superposition<S>): boolean {
  return sup.collapsed !== undefined;
}

/** Most probable candidate without collapsing (ties: heavier amplitude wins). */
export function mostLikely<S>(sup: Superposition<S>): S {
  const ranked = sup.peek().sort((a, b) => b.probability - a.probability);
  return ranked[0].state;
}

function isWeighted<S>(value: S | WeightedState<S>): value is WeightedState<S> {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in (value as Record<string, unknown>) &&
    "weight" in (value as Record<string, unknown>)
  );
}

function totalWeight<S>(states: WeightedState<S>[]): number {
  return states.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
}

function weightedPick<S>(states: WeightedState<S>[], rand: () => number): number {
  const total = totalWeight(states);
  if (total <= 0) return 0;
  let ticket = rand() * total;
  for (let i = 0; i < states.length; i++) {
    ticket -= Math.max(0, states[i].weight);
    if (ticket < 0) return i;
  }
  return states.length - 1;
}

function argmaxScore<S>(states: WeightedState<S>[], scorer: (state: S, index: number) => number): number {
  let best = 0;
  for (let i = 1; i < states.length; i++) {
    const score = scorer(states[i].state, i);
    const bestScore = scorer(states[best].state, best);
    if (score > bestScore || (score === bestScore && states[i].weight > states[best].weight)) {
      best = i;
    }
  }
  return best;
}

function reverseMap(correlate: (index: number) => number, leftLength: number): (index: number) => number {
  const table = new Map<number, number>();
  for (let i = 0; i < leftLength; i++) {
    const j = correlate(i);
    if (!table.has(j)) table.set(j, i);
  }
  return (j) => table.get(j) ?? Math.min(Math.max(j, 0), Math.max(leftLength - 1, 0));
}

/** Mulberry32 (same tiny PRNG as agent-chaos) so collapses are reproducible. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}