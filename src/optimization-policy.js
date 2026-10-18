function cloneOptimizationPolicy(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function positive(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function createOptimizationPolicy({ config = {}, clock = Date } = {}) {
  const cfg = {
    stabilityMode: config.stabilityMode === 'latency-first' ? 'latency-first' : 'stable-first',
    stableSwitchRounds: Number.isInteger(config.stableSwitchRounds) && config.stableSwitchRounds > 0 ? config.stableSwitchRounds : 3,
    stabilitySwitchMargin: positive(config.stabilitySwitchMargin, 8),
    latencySwitchMargin: positive(config.latencySwitchMargin, 0.35),
    optimizeDwellMs: positive(config.optimizeDwellMs, 300000),
    optimizeCooldownMs: positive(config.optimizeCooldownMs, 600000),
  };
  let streak = null;
  let dwellUntil = 0;
  const cooldowns = new Map();

  function nowValue(value) {
    return Number.isFinite(value) ? value : clock.now();
  }

  function resetStreak() {
    streak = null;
  }

  function evaluate({ current, candidates = [], generation, topologyFingerprint, now, mode = cfg.stabilityMode, reason = 'optimize', failureProtectionUntil = 0 } = {}) {
    const at = nowValue(now);
    if (reason === 'failure' || reason === 'fault') return { kind: 'none', reason: 'fault-priority', candidate: null };
    if (Number.isFinite(failureProtectionUntil) && at < failureProtectionUntil) {
      resetStreak();
      return { kind: 'none', reason: 'failure-protection', candidate: null };
    }
    if (at < dwellUntil) return { kind: 'none', reason: 'optimize-dwell', candidate: null };

    const candidate = [...candidates]
      .filter((item) => item && item.eligibility === 'eligible' && Number.isFinite(item.score) && Number.isFinite(item.delay))
      .filter((item) => (cooldowns.get(item.stableKey || item.tag) || 0) <= at)
      .sort((left, right) => left.delay - right.delay || right.score - left.score)[0];
    if (!candidate) {
      resetStreak();
      return { kind: 'none', reason: 'insufficient-stability-samples', candidate: null };
    }
    const currentScore = Number.isFinite(current?.score) ? current.score : null;
    const currentDelay = Number.isFinite(current?.delay) ? current.delay : null;
    if (currentScore === null || currentDelay === null) {
      resetStreak();
      return { kind: 'none', reason: 'insufficient-current-samples', candidate: null };
    }

    const scoreImproved = candidate.score - currentScore >= cfg.stabilitySwitchMargin;
    const latencyImproved = currentDelay > 0 && candidate.delay <= currentDelay * (1 - cfg.latencySwitchMargin);
    const eligible = mode === 'latency-first'
      ? latencyImproved || scoreImproved
      : scoreImproved || (candidate.score >= currentScore && latencyImproved);
    const key = `${candidate.stableKey || candidate.tag}|${generation}|${topologyFingerprint}`;
    if (!eligible) {
      resetStreak();
      return { kind: 'none', reason: 'stability-margin-not-met', candidate: null };
    }
    if (!streak || streak.key !== key) streak = { key, stableKey: candidate.stableKey || candidate.tag, generation, topologyFingerprint, rounds: 0 };
    streak.rounds += 1;
    if (streak.rounds < cfg.stableSwitchRounds) {
      return { kind: 'none', reason: 'stable-rounds-pending', candidate: null };
    }
    return { kind: 'optimize', reason: 'stable-threshold-met', candidate: cloneOptimizationPolicy(candidate) };
  }

  function recordResult({ kind, candidate, ok, at } = {}) {
    const now = nowValue(at);
    if (kind !== 'optimize' || !candidate) return;
    const key = candidate.stableKey || candidate.tag;
    if (ok) {
      dwellUntil = now + cfg.optimizeDwellMs;
      resetStreak();
    } else {
      cooldowns.set(key, now + cfg.optimizeCooldownMs);
      resetStreak();
    }
  }

  return {
    evaluate,
    recordResult,
    snapshot: () => cloneOptimizationPolicy({ streak, dwellUntil, cooldowns: [...cooldowns.entries()] }),
    restore: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.cooldowns)) {
        streak = null;
        dwellUntil = 0;
        cooldowns.clear();
        return false;
      }
      streak = snapshot.streak ? cloneOptimizationPolicy(snapshot.streak) : null;
      dwellUntil = Number.isFinite(snapshot.dwellUntil) ? snapshot.dwellUntil : 0;
      cooldowns.clear();
      for (const [key, until] of snapshot.cooldowns) if (typeof key === 'string' && Number.isFinite(until)) cooldowns.set(key, until);
      return true;
    },
  };
}
