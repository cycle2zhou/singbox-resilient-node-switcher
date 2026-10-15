function finite(value) {
  return Number.isFinite(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function percentile(values, rank) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeConfig(config = {}) {
  return {
    stabilityWindowMs: Number.isFinite(config.stabilityWindowMs) && config.stabilityWindowMs > 0 ? config.stabilityWindowMs : 600000,
    stabilityMaxSamples: Number.isInteger(config.stabilityMaxSamples) && config.stabilityMaxSamples > 0 ? config.stabilityMaxSamples : 20,
    headMinSamples: Number.isInteger(config.headMinSamples) && config.headMinSamples > 0 ? config.headMinSamples : 5,
    realMinSamples: Number.isInteger(config.realMinSamples) && config.realMinSamples > 0 ? config.realMinSamples : 3,
    realLatencyMinSamples: Number.isInteger(config.realLatencyMinSamples) && config.realLatencyMinSamples > 0 ? config.realLatencyMinSamples : 5,
  };
}

export function createStabilityScore({ config = {}, clock = Date } = {}) {
  const cfg = normalizeConfig(config);
  const nodes = new Map();

  function ensure(stableKey) {
    if (typeof stableKey !== 'string' || !stableKey) throw new TypeError('stableKey is required');
    if (!nodes.has(stableKey)) nodes.set(stableKey, { stableKey, head: [], real: [], consecutiveFailures: 0 });
    return nodes.get(stableKey);
  }

  function prune(node, at) {
    const cutoff = at - cfg.stabilityWindowMs;
    node.head = node.head.filter((sample) => sample.at >= cutoff).slice(-cfg.stabilityMaxSamples);
    node.real = node.real.filter((sample) => sample.at >= cutoff).slice(-cfg.stabilityMaxSamples);
  }

  function record(kind, sample = {}) {
    const { stableKey, tag, delay, ok, at = clock.now(), error = null } = sample;
    if (typeof tag !== 'string' || typeof stableKey !== 'string' || !finite(at)) throw new TypeError('tag, stableKey and at are required');
    const node = ensure(stableKey);
    const entry = { tag, stableKey, delay: finite(delay) && delay >= 0 ? delay : null, ok: ok === true, at, error: error ?? null };
    node[kind].push(entry);
    node[kind] = node[kind].slice(-cfg.stabilityMaxSamples);
    if (entry.ok) node.consecutiveFailures = 0;
    else node.consecutiveFailures += 1;
    prune(node, at);
    return getSummary(stableKey, at);
  }

  function getSummary(stableKey, now = clock.now()) {
    const node = nodes.get(stableKey);
    if (!node) return null;
    prune(node, now);
    const headSuccesses = node.head.filter((sample) => sample.ok).length;
    const realSuccesses = node.real.filter((sample) => sample.ok).length;
    const successfulLatencies = node.real.filter((sample) => sample.ok && finite(sample.delay)).map((sample) => sample.delay);
    const p50 = median(successfulLatencies);
    const p95 = percentile(successfulLatencies, 0.95);
    const eligible = node.head.length >= cfg.headMinSamples
      && node.real.length >= cfg.realMinSamples
      && successfulLatencies.length >= cfg.realLatencyMinSamples;
    const headRate = node.head.length ? headSuccesses / node.head.length : 0;
    const realRate = node.real.length ? realSuccesses / node.real.length : 0;
    const volatility = p50 && p95 !== null ? Math.max(0, Math.min(1, 1 - (p95 / p50 - 1))) : 0;
    const failurePenalty = Math.min(1, node.consecutiveFailures / 5);
    const score = Math.round(Math.max(0, Math.min(100, headRate * 40 + realRate * 30 + volatility * 20 + (1 - failurePenalty) * 10)));
    return {
      stableKey,
      score,
      headSamples: node.head.length,
      realSamples: node.real.length,
      realSuccesses,
      successfulLatencies: [...successfulLatencies],
      median: p50,
      p95,
      eligibility: eligible ? 'eligible' : 'insufficient-real-samples',
      consecutiveFailures: node.consecutiveFailures,
    };
  }

  function getAllSummaries(now = clock.now()) {
    return [...nodes.keys()].map((stableKey) => getSummary(stableKey, now));
  }

  return {
    recordHead: (sample) => record('head', sample),
    recordReal: (sample) => record('real', sample),
    getSummary,
    getAllSummaries,
    isEligible: (stableKey, now = clock.now()) => getSummary(stableKey, now)?.eligibility === 'eligible',
    compare: (left, right) => (left?.score ?? -1) - (right?.score ?? -1),
    snapshot: () => clone([...nodes.values()]),
    restore: (snapshot) => {
      if (!Array.isArray(snapshot) || snapshot.some((node) => !node || typeof node.stableKey !== 'string' || !Array.isArray(node.head) || !Array.isArray(node.real))) {
        nodes.clear();
        return false;
      }
      nodes.clear();
      for (const node of snapshot) nodes.set(node.stableKey, clone(node));
      return true;
    },
  };
}
