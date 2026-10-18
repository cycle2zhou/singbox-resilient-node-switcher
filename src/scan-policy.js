const DEFAULT_SCORE = 80;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function stateFor(states, tag, config) {
  if (!states.has(tag)) {
    states.set(tag, {
      tag,
      score: config.scanScoreInitial,
      consecutiveFailures: 0,
      lastProbeAt: null,
      lastSuccessAt: null,
      nextProbeAt: 0,
      round: 0,
    });
  }
  return states.get(tag);
}

function intervalFor(score, config) {
  if (score >= config.scanScoreHighThreshold) return 1;
  if (score >= config.scanScoreMediumThreshold) return 2;
  if (score >= config.scanScoreLowThreshold) return 3;
  return config.scanBackoffRounds;
}

function failurePenalty(reason, config) {
  const text = String(reason || '').toLowerCase();
  if (text.includes('503')) return config.scanHttp503Step;
  if (text.includes('504')) return config.scanHttp504Step;
  if (text.includes('timeout')) return config.scanTimeoutStep;
  return config.scanFailureStep;
}

export function createScanPolicy({ config, clock = Date } = {}) {
  if (!config) throw new TypeError('config is required');
  const time = clock && typeof clock.now === 'function' ? clock : Date;
  const states = new Map();
  let round = 0;
  let cursor = 0;

  function recordProbe({ tag, ok, delay, real = false, slow = false, reason, now = time.now() }) {
    const state = stateFor(states, tag, config);
    state.lastProbeAt = now;
    state.round = round;
    if (ok) {
      state.consecutiveFailures = 0;
      state.lastSuccessAt = now;
      state.score = Math.min(config.scanScoreMax, state.score + (slow ? config.scanSlowStep : config.scanSuccessStep));
    } else {
      state.consecutiveFailures += 1;
      const penalty = real ? config.scanRealFailureStep : failurePenalty(reason, config);
      state.score = Math.max(0, state.score - penalty);
    }
    state.nextProbeAt = now + intervalFor(state.score, config) * config.scanIntervalMs;
    return { ...state };
  }

  function getState(tag) {
    const state = states.get(tag);
    return state ? { ...state } : null;
  }

  function snapshot() {
    return { round, cursor, states: [...states].map(([tag, state]) => [tag, { ...state }]) };
  }

  function restore(snapshotState) {
    if (!snapshotState || !Array.isArray(snapshotState.states)) return;
    round = snapshotState.round;
    cursor = snapshotState.cursor;
    states.clear();
    for (const [tag, state] of snapshotState.states) states.set(tag, { ...state });
  }

  function selectTargets({ tags = [], currentNow = null, candidateTags = [], now = time.now() } = {}) {
    round += 1;
    const uniqueTags = [...new Set(tags)];
    const forced = [];
    const addForced = (tag) => {
      if (tag && uniqueTags.includes(tag) && !forced.includes(tag)) forced.push(tag);
    };
    addForced(currentNow);
    for (const tag of candidateTags) addForced(tag);

    const eligible = uniqueTags
      .filter((tag) => !forced.includes(tag))
      .map((tag) => stateFor(states, tag, config))
      .filter((state) => state.nextProbeAt <= now && (state.lastProbeAt === null || (round - state.round) >= intervalFor(state.score, config)))
      .sort((left, right) => right.score - left.score || (left.lastProbeAt ?? -Infinity) - (right.lastProbeAt ?? -Infinity));

    const main = eligible.slice(0, config.scanMainPoolSize).map((state) => state.tag);
    const remaining = eligible.filter((state) => !main.includes(state.tag));
    const exploreSize = Math.min(config.scanExplorePoolSize, remaining.length);
    const explore = [];
    for (let index = 0; index < exploreSize; index += 1) {
      explore.push(remaining[(cursor + index) % remaining.length].tag);
    }
    if (remaining.length > 0) cursor = (cursor + exploreSize) % remaining.length;
    return [...forced, ...main, ...explore];
  }

  return { recordProbe, getState, snapshot, restore, selectTargets };
}
