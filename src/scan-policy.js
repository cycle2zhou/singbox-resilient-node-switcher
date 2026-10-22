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

// 探测退避轮数：连续失败 >= 3 次后指数退避。
// 死节点（CF-自建等）探测慢/挂起会拖垮整轮扫描，让正常轮次超时、候选快照过期。
// 前 2 次失败仍按 score 分段退避（快速确认「真死」），第 3 次起退避指数增长
// （6→12→24→48→64 轮），把死节点逐步挤出正常轮次的 eligible 集合，让正常轮次
// 优先探测健康节点、快速完成，候选池持续刷新。
function backoffRoundsFor(state, config) {
  if (state.consecutiveFailures >= 3) {
    const exponent = Math.min(state.consecutiveFailures - 2, 6);
    return Math.min(config.scanBackoffRounds * (2 ** exponent), config.scanBackoffMaxRounds);
  }
  return intervalFor(state.score, config);
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
    state.nextProbeAt = now + backoffRoundsFor(state, config) * config.scanIntervalMs;
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

  function selectTargets({ tags = [], currentNow = null, candidateTags = [], now = time.now(), fastScan = false } = {}) {
    round += 1;
    const uniqueTags = [...new Set(tags)];
    if (fastScan) {
      // 快扫反转顺序：机场订阅通常把专线/高级节点（如宝可梦/linux）放在成员列表末尾，
      // 免费死节点（CF-自建）靠前。反转后快扫先探测专线，快速建立候选池，避免死节点
      // 堵在前面导致快扫在 deadline 内探测不到专线、候选池长期为空。
      return uniqueTags.reverse();
    }
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
