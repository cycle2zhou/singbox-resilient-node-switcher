/**
 * GUI.for.SingBox 插件：弹性节点切换（可恢复冷却 + 谨慎故障切换）。
 * 本文件由 scripts/build-plugin.js 自动生成，勿手改；来源 src/*.js + scripts/plugin-adapter.js。
 * 自包含单文件：不通过相对路径或运行时 import 引用项目 src/。
 */

const __core = (() => {
// ---- src/config.js ----
const DEFAULT_CONFIG = Object.freeze({
  selectorName: '🚀 节点选择',
  probeUrls: Object.freeze([
    'https://www.gstatic.com/generate_204',
    'https://cp.cloudflare.com/generate_204',
    'https://www.google.com/generate_204',
  ]),
  watchIntervalMs: 10000,
  watchTimeoutMs: 4000,
  poolRefreshIntervalMs: 180000,
  poolTimeoutMs: 5000,
  poolConcurrency: 20,
  poolFailureRateThreshold: 0.9,
  failureThreshold: 3,
  recoveryThreshold: 2,
  initialCooldownMs: 120000,
  maxCooldownMs: 1800000,
  minDwellMs: 60000,
  degradationRatio: 3,
  degradationThreshold: 2,
  baselineWindow: 5,
});

const POSITIVE_KEYS = [
  'watchIntervalMs',
  'watchTimeoutMs',
  'poolRefreshIntervalMs',
  'poolTimeoutMs',
  'initialCooldownMs',
  'minDwellMs',
  'degradationRatio',
];

const POSITIVE_INTEGER_KEYS = [
  'poolConcurrency',
  'failureThreshold',
  'recoveryThreshold',
  'degradationThreshold',
  'baselineWindow',
];

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeProbeUrls(value) {
  if (!Array.isArray(value)) return DEFAULT_CONFIG.probeUrls;
  const filtered = value.filter((url) => typeof url === 'string' && url.trim());
  return filtered.length > 0 ? filtered : DEFAULT_CONFIG.probeUrls;
}

function normalizePoolFailureRateThreshold(value, fallback) {
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

function normalizeConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const config = { ...DEFAULT_CONFIG };

  for (const key of POSITIVE_KEYS) {
    config[key] = positiveNumber(source[key], DEFAULT_CONFIG[key]);
  }

  for (const key of POSITIVE_INTEGER_KEYS) {
    config[key] = positiveInteger(source[key], DEFAULT_CONFIG[key]);
  }

  config.maxCooldownMs = positiveNumber(source.maxCooldownMs, DEFAULT_CONFIG.maxCooldownMs);
  config.maxCooldownMs = Math.max(config.maxCooldownMs, config.initialCooldownMs);
  config.selectorName = typeof source.selectorName === 'string' && source.selectorName.trim()
    ? source.selectorName
    : DEFAULT_CONFIG.selectorName;

  config.probeUrls = normalizeProbeUrls(source.probeUrls);
  config.poolFailureRateThreshold = normalizePoolFailureRateThreshold(
    source.poolFailureRateThreshold,
    DEFAULT_CONFIG.poolFailureRateThreshold,
  );

  return config;
}


// ---- src/model.js ----
function createNodeState(tag) {
  if (typeof tag !== 'string' || !tag) {
    throw new TypeError('节点标签必须是非空字符串');
  }

  return {
    tag,
    status: 'healthy',
    failureCount: 0,
    recoverySuccessCount: 0,
    cooldownMs: 0,
    cooldownUntil: null,
    lastDelay: null,
    lastError: null,
    lastProbeAt: null,
  };
}

function serializeNodeState(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('节点状态必须是对象');
  }

  return { ...state };
}


// ---- src/response.js ----
function failure(reason, status) {
  return status === undefined ? { ok: false, reason } : { ok: false, status, reason };
}

function parseDelayResponse(status, body) {
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    return failure(`delay request failed with HTTP ${status}`, status);
  }

  let value = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return failure('delay response is not valid JSON');
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure('delay response must be a JSON object');
  }
  if (typeof value.delay !== 'number' || !Number.isFinite(value.delay) || value.delay <= 0) {
    return failure('delay response must contain a positive delay');
  }

  return { ok: true, delay: value.delay };
}


// ---- src/health-state.js ----
const STATUS = Object.freeze({
  HEALTHY: 'healthy',
  SUSPECT: 'suspect',
  COOLDOWN: 'cooldown',
  HALF_OPEN: 'half-open',
});

function nextCooldownMs(currentCooldownMs, initialCooldownMs, maxCooldownMs) {
  const base = Number.isFinite(currentCooldownMs) && currentCooldownMs > 0
    ? currentCooldownMs
    : initialCooldownMs;
  return Math.min(base * 2, maxCooldownMs);
}

function recordProbeFailure(state, now, reason, config) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('节点状态必须是对象');
  }
  if (!Number.isFinite(now)) {
    throw new TypeError('now 必须是有限数字');
  }

  const next = { ...state, lastError: reason, lastProbeAt: now };

  switch (state.status) {
    case STATUS.HEALTHY:
      next.status = STATUS.SUSPECT;
      next.failureCount = 1;
      break;

    case STATUS.SUSPECT: {
      const failures = state.failureCount + 1;
      next.failureCount = failures;
      if (failures >= config.failureThreshold) {
        next.status = STATUS.COOLDOWN;
        next.cooldownMs = config.initialCooldownMs;
        next.cooldownUntil = now + config.initialCooldownMs;
        next.recoverySuccessCount = 0;
      }
      break;
    }

    case STATUS.HALF_OPEN: {
      const cooldownMs = nextCooldownMs(state.cooldownMs, config.initialCooldownMs, config.maxCooldownMs);
      next.status = STATUS.COOLDOWN;
      next.cooldownMs = cooldownMs;
      next.cooldownUntil = now + cooldownMs;
      next.recoverySuccessCount = 0;
      break;
    }

    case STATUS.COOLDOWN:
      // 冷却期间不应探测；即使收到失败也不重复计时，保持原冷却。
      break;

    default:
      next.status = STATUS.SUSPECT;
      next.failureCount = 1;
  }

  return next;
}

function recordProbeSuccess(state, now, delay, config) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('节点状态必须是对象');
  }
  if (!Number.isFinite(now)) {
    throw new TypeError('now 必须是有限数字');
  }

  const next = { ...state, lastDelay: delay, lastError: null, lastProbeAt: now };

  switch (state.status) {
    case STATUS.SUSPECT:
      next.status = STATUS.HEALTHY;
      next.failureCount = 0;
      next.recoverySuccessCount = 0;
      break;

    case STATUS.HALF_OPEN: {
      const successes = state.recoverySuccessCount + 1;
      if (successes >= config.recoveryThreshold) {
        next.status = STATUS.HEALTHY;
        next.failureCount = 0;
        next.recoverySuccessCount = 0;
        next.cooldownMs = 0;
        next.cooldownUntil = null;
      } else {
        next.recoverySuccessCount = successes;
      }
      break;
    }

    case STATUS.HEALTHY:
    case STATUS.COOLDOWN:
    default:
      // healthy 保持；cooldown 期间的意外成功不改变状态。
      break;
  }

  return next;
}

function getProbePlan(state, now, config) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('节点状态必须是对象');
  }
  if (!Number.isFinite(now)) {
    throw new TypeError('now 必须是有限数字');
  }

  if (state.status === STATUS.COOLDOWN) {
    const until = state.cooldownUntil;
    if (Number.isFinite(until) && now >= until) {
      return { shouldProbe: true, state: { ...state, status: STATUS.HALF_OPEN } };
    }
    return { shouldProbe: false, state: { ...state }, reason: 'in cooldown until ' + String(until) };
  }

  return { shouldProbe: true, state: { ...state } };
}

function isEligibleCandidate(state, now) {
  if (!state || typeof state !== 'object') {
    return false;
  }
  return state.status === STATUS.HEALTHY || state.status === STATUS.SUSPECT;
}

function markCooldown(state, now, config) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('节点状态必须是对象');
  }
  if (!Number.isFinite(now)) {
    throw new TypeError('now 必须是有限数字');
  }

  return {
    ...state,
    status: STATUS.COOLDOWN,
    cooldownMs: config.initialCooldownMs,
    cooldownUntil: now + config.initialCooldownMs,
    recoverySuccessCount: 0,
  };
}


// ---- src/api.js ----

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function headers(secret, contentType = false) {
  const result = {};
  if (secret) result.Authorization = `Bearer ${secret}`;
  if (contentType) result['Content-Type'] = 'application/json';
  return result;
}

function combineSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const abort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

async function readBody(response) {
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.includes('json') && typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      throw new Error('response body is not valid JSON');
    }
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  }
  return undefined;
}

function errorResult(error) {
  const reason = error?.name === 'TimeoutError' || error?.code === 'UND_ERR_CONNECT_TIMEOUT'
    ? 'request timeout'
    : (error?.name === 'AbortError' || error?.name === 'CanceledError' ? 'request aborted' : (error?.message || String(error)));
  return { ok: false, status: error?.status, reason };
}

function createClashApi({ baseUrl, secret, timeoutMs = 5000, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const request = async (path, options = {}, signal, requestTimeoutMs = timeoutMs) => {
    const combined = combineSignal(signal, requestTimeoutMs);
    try {
      const response = await fetchImpl(joinUrl(baseUrl, path), { ...options, signal: combined.signal, headers: { ...headers(secret), ...options.headers } });
      let body;
      try {
        body = await readBody(response);
      } catch (error) {
        return { ok: false, status: response.status, reason: error.message };
      }
      if (!response.ok && (response.status < 200 || response.status >= 300)) {
        return { ok: false, status: response.status, reason: `request failed with HTTP ${response.status}`, body };
      }
      return { ok: true, status: response.status, body };
    } catch (error) {
      return errorResult(error);
    } finally {
      combined.cleanup();
    }
  };

  return {
    async getProxies(signal) {
      const result = await request('/proxies', {}, signal);
      if (!result.ok) throw Object.assign(new Error(result.reason), result);
      return result.body;
    },

    async probe(node, url, timeoutMs, signal) {
      const encodedNode = encodeURIComponent(node);
      const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
      const result = await request(`/proxies/${encodedNode}/delay?${query}`, {}, signal, timeoutMs);
      if (!result.ok) return result;
      return parseDelayResponse(result.status, result.body);
    },

    async select(group, node, signal) {
      const combined = combineSignal(signal);
      try {
        const result = await request(`/proxies/${encodeURIComponent(group)}`, {
          method: 'PUT',
          headers: headers(secret, true),
          body: JSON.stringify({ name: node }),
        }, combined.signal);
        if (!result.ok) throw Object.assign(new Error(result.reason), result);
        return { ok: true, status: result.status, body: result.body };
      } finally {
        combined.cleanup();
      }
    },
  };
}


// ---- src/monitor.js ----

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function createMonitor({ api, config, clock, logger }) {
  const cfg = normalizeConfig(config);
  const time = clock && typeof clock.now === 'function' ? clock : Date;
  const log = logger && typeof logger.info === 'function' ? logger : silentLogger();

  const nodeStates = new Map();
  let members = [];
  let memberTypes = {};
  let currentNow = null;
  let lastObservedNow = null;
  let currentStartAt = null;
  let lastError = null;
  let lastSwitch = null;
  let candidates = [];
  let running = false;
  let watchInProgress = false;
  let poolInProgress = false;
  let watchTimer = null;
  let poolTimer = null;
  let watchController = null;
  let poolController = null;

  // 通道 A 专用状态
  let watchBaseline = [];
  let watchFailureCount = 0;
  let watchDegradationCount = 0;
  let watchCycleCount = 0;
  let poolCycleCount = 0;

  function ensureNodeState(tag) {
    if (!nodeStates.has(tag)) {
      nodeStates.set(tag, createNodeState(tag));
    }
    return nodeStates.get(tag);
  }

  function probeUrl(cycleCount) {
    const urls = cfg.probeUrls;
    if (!Array.isArray(urls) || urls.length === 0) return null;
    return urls[cycleCount % urls.length];
  }

  async function runPoolProbe(tag, signal, url) {
    const now = time.now();
    const state = ensureNodeState(tag);
    const plan = getProbePlan(state, now, cfg);
    nodeStates.set(tag, plan.state);
    if (!plan.shouldProbe) {
      return { tag, probed: false };
    }
    let result;
    try {
      result = await api.probe(tag, url, cfg.poolTimeoutMs, signal);
    } catch (error) {
      result = { ok: false, reason: error?.message || String(error) };
    }
    if (result && result.ok) {
      nodeStates.set(tag, recordProbeSuccess(nodeStates.get(tag), now, result.delay, cfg));
      return { tag, probed: true, ok: true };
    }
    const reason = result?.reason || 'probe failed';
    nodeStates.set(tag, recordProbeFailure(nodeStates.get(tag), now, reason, cfg));
    return { tag, probed: true, ok: false };
  }

  async function poolCycle() {
    if (poolInProgress) {
      return { skipped: true, error: null };
    }
    poolInProgress = true;
    const cycleController = new AbortController();
    poolController = cycleController;
    const snapshotStates = new Map([...nodeStates].map(([k, v]) => [k, { ...v }]));
    const snapshotCandidates = [...candidates];

    try {
      let data;
      try {
        data = await api.getProxies(cycleController.signal);
      } catch (error) {
        lastError = error?.message || String(error);
        log.error('无法读取主 Selector 状态', lastError);
        return { skipped: false, error: lastError };
      }

      const proxies = data?.proxies;
      if (!proxies || typeof proxies !== 'object') {
        lastError = 'proxies 响应缺失';
        log.error(lastError);
        return { skipped: false, error: lastError };
      }

      const selector = proxies[cfg.selectorName];
      if (!selector) {
        lastError = `主 Selector「${cfg.selectorName}」不存在`;
        log.error(lastError);
        return { skipped: false, error: lastError };
      }
      if (selector.type !== 'Selector') {
        lastError = `主 Selector「${cfg.selectorName}」类型为 ${selector.type}，非 Selector`;
        log.error(lastError);
        return { skipped: false, error: lastError };
      }
      const all = Array.isArray(selector.all) ? selector.all : [];
      if (all.length === 0) {
        lastError = `主 Selector「${cfg.selectorName}」无成员`;
        log.error(lastError);
        return { skipped: false, error: lastError };
      }

      lastError = null;
      members = [...all];
      memberTypes = {};
      for (const tag of members) {
        memberTypes[tag] = proxies[tag]?.type ?? 'unknown';
        ensureNodeState(tag);
      }
      for (const tag of [...nodeStates.keys()]) {
        if (!members.includes(tag)) nodeStates.delete(tag);
      }

      currentNow = selector.now;

      // 探测目标：跳过当前 now 与 URLTest，本轮统一使用一个探测 URL
      const probeTargets = members.filter((tag) => tag !== currentNow && memberTypes[tag] !== 'URLTest');
      const url = probeUrl(poolCycleCount);

      const results = [];
      for (let i = 0; i < probeTargets.length; i += cfg.poolConcurrency) {
        const batch = probeTargets.slice(i, i + cfg.poolConcurrency);
        const batchResults = await Promise.all(batch.map((tag) => runPoolProbe(tag, cycleController.signal, url)));
        results.push(...batchResults);
      }

      // 全池失败熔断：实际探测节点失败率超过阈值则本轮作废
      const probed = results.filter((r) => r.probed);
      if (probed.length > 0) {
        const failures = probed.filter((r) => !r.ok).length;
        const failureRate = failures / probed.length;
        if (failureRate > cfg.poolFailureRateThreshold) {
          nodeStates.clear();
          for (const [k, v] of snapshotStates) nodeStates.set(k, v);
          candidates = snapshotCandidates;
          lastError = '全池探测失败率超过阈值，判定为探测目标/API 故障，本轮作废';
          log.warn(lastError);
          return { skipped: false, error: lastError };
        }
      }

      candidates = probeTargets.filter((tag) => {
        const st = nodeStates.get(tag);
        return st && st.status === 'healthy' && st.lastDelay != null && st.lastError == null;
      });

      return { skipped: false, error: null };
    } finally {
      poolInProgress = false;
      poolController = null;
      poolCycleCount += 1;
    }
  }

  async function watchCycle() {
    if (watchInProgress) {
      return { skipped: true, switchedTo: null, error: null };
    }
    watchInProgress = true;
    const cycleController = new AbortController();
    watchController = cycleController;

    try {
      let data;
      try {
        data = await api.getProxies(cycleController.signal);
      } catch (error) {
        lastError = error?.message || String(error);
        log.error('无法读取主 Selector 状态', lastError);
        return { skipped: false, switchedTo: null, error: lastError };
      }

      const proxies = data?.proxies;
      if (!proxies || typeof proxies !== 'object') {
        lastError = 'proxies 响应缺失';
        log.error(lastError);
        return { skipped: false, switchedTo: null, error: lastError };
      }

      const selector = proxies[cfg.selectorName];
      if (!selector) {
        lastError = `主 Selector「${cfg.selectorName}」不存在`;
        log.error(lastError);
        return { skipped: false, switchedTo: null, error: lastError };
      }
      if (selector.type !== 'Selector') {
        lastError = `主 Selector「${cfg.selectorName}」类型为 ${selector.type}，非 Selector`;
        log.error(lastError);
        return { skipped: false, switchedTo: null, error: lastError };
      }

      const now = time.now();
      const observedNow = selector.now;

      // 外部变化检测：接受新选择、重置快探窗口，不切回旧节点
      if (lastObservedNow !== null && lastObservedNow !== observedNow) {
        watchBaseline = [];
        watchFailureCount = 0;
        watchDegradationCount = 0;
        currentStartAt = now;
      }
      if (currentStartAt === null) {
        currentStartAt = now;
      }
      lastObservedNow = observedNow;
      currentNow = observedNow;

      lastError = null;

      // 只探测当前 now，探测 URL 按轮次轮换
      let result;
      try {
        result = await api.probe(observedNow, probeUrl(watchCycleCount), cfg.watchTimeoutMs, cycleController.signal);
      } catch (error) {
        result = { ok: false, reason: error?.message || String(error) };
      }

      if (result && result.ok) {
        watchBaseline.push(result.delay);
        if (watchBaseline.length > cfg.baselineWindow) {
          watchBaseline = watchBaseline.slice(-cfg.baselineWindow);
        }
        watchFailureCount = 0;
        if (watchBaseline.length >= cfg.baselineWindow && result.delay > median(watchBaseline) * cfg.degradationRatio) {
          watchDegradationCount += 1;
        } else {
          watchDegradationCount = 0;
        }
      } else {
        watchFailureCount += 1;
        watchDegradationCount = 0;
      }

      const shouldSwitch = (watchFailureCount >= cfg.failureThreshold) || (watchDegradationCount >= cfg.degradationThreshold);
      const dwellSatisfied = now >= (currentStartAt ?? now) + cfg.minDwellMs;

      if (shouldSwitch && dwellSatisfied) {
        if (candidates.length === 0) {
          lastError = '候选池为空，等待通道 B 刷新';
          log.info(lastError);
          return { skipped: false, switchedTo: null, error: lastError };
        }

        const target = candidates[0];
        try {
          await api.select(cfg.selectorName, target, cycleController.signal);
        } catch (error) {
          log.warn(`切换到 ${target} 失败`, error?.message || String(error));
          currentStartAt = now;
          return { skipped: false, switchedTo: null, error: `switch failed: ${error?.message}` };
        }

        let confirmNow = null;
        try {
          const refreshed = await api.getProxies(cycleController.signal);
          confirmNow = refreshed?.proxies?.[cfg.selectorName]?.now ?? null;
        } catch (error) {
          confirmNow = null;
        }

        if (confirmNow === target) {
          const oldState = ensureNodeState(observedNow);
          nodeStates.set(observedNow, markCooldown(oldState, now, cfg));
          lastSwitch = { from: observedNow, to: target, at: now };
          currentNow = target;
          lastObservedNow = target;
          currentStartAt = now;
          candidates = candidates.filter((t) => t !== target);
          watchBaseline = [];
          watchFailureCount = 0;
          watchDegradationCount = 0;
          log.info(`已切换到 ${target}`);
          return { skipped: false, switchedTo: target, error: null };
        }

        log.warn(`切换确认失败：期望 now=${target} 实际 now=${confirmNow}`);
        currentStartAt = now;
        return { skipped: false, switchedTo: null, error: 'switch confirm failed' };
      }

      return { skipped: false, switchedTo: null, error: lastError };
    } finally {
      watchInProgress = false;
      watchController = null;
      watchCycleCount += 1;
    }
  }

  function start() {
    if (running) return;
    running = true;
    poolCycle().catch((error) => log.error('候选池预热异常', error?.message || String(error)));
    watchTimer = setInterval(() => {
      watchCycle().catch((error) => log.error('快探轮次异常', error?.message || String(error)));
    }, cfg.watchIntervalMs);
    poolTimer = setInterval(() => {
      poolCycle().catch((error) => log.error('候选池轮次异常', error?.message || String(error)));
    }, cfg.poolRefreshIntervalMs);
  }

  function stop() {
    running = false;
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (poolTimer) {
      clearInterval(poolTimer);
      poolTimer = null;
    }
    watchController?.abort();
    watchController = null;
    poolController?.abort();
    poolController = null;
  }

  function getSnapshot() {
    const states = {};
    for (const [tag, state] of nodeStates) {
      states[tag] = { ...state };
    }
    return {
      selectorName: cfg.selectorName,
      running,
      watchInProgress,
      poolInProgress,
      currentNow,
      members: [...members],
      memberTypes: { ...memberTypes },
      nodeStates: states,
      lastError,
      lastSwitch: lastSwitch ? { ...lastSwitch } : null,
      channelA: {
        baseline: [...watchBaseline],
        lastDelay: watchBaseline.length > 0 ? watchBaseline[watchBaseline.length - 1] : null,
        failureCount: watchFailureCount,
        degradationCount: watchDegradationCount,
      },
      candidates: [...candidates],
    };
  }

  return { start, stop, getSnapshot, watchCycle, poolCycle };
}

  return {
    DEFAULT_CONFIG,
    normalizeConfig,
    createNodeState,
    serializeNodeState,
    parseDelayResponse,
    createClashApi,
    recordProbeFailure,
    recordProbeSuccess,
    getProbePlan,
    isEligibleCandidate,
    markCooldown,
    createMonitor,
  };
})();

/**
 * GUI.for.SingBox 插件适配层：把内联核心（__core）接入 GFS 插件生命周期。
 * 本文件由 scripts/build-plugin.js 与内联核心拼接为自包含插件单文件；
 * 运行时不通过相对路径或运行时 import 引用项目 src/。
 * 仅面向 GUI.for.SingBox，不包含 GUI.for.Clash 分支。
 */

export default (Plugin) => {
  const { ref, computed, h, resolveComponent } = Vue;

  const isRunning = ref(false);
  const snapshot = ref(null);

  let monitor = null;
  let apiClient = null;
  let refreshTimer = null;
  let persistTimer = null;
  let disposed = false;

  const stateFile = 'data/plugins/singbox-resilient-node-switcher/state.json';

  // 从当前 profile 解析 sing-box Clash API 控制面地址与密钥（仅 GFS）
  function resolveEndpoint() {
    const { currentProfile: profile } = Plugins.useProfilesStore();
    const clash = profile && profile.experimental && profile.experimental.clash_api;
    if (!clash) return null;
    const controller = clash.external_controller || '127.0.0.1:20123';
    const secret = clash.secret || '';
    const idx = controller.lastIndexOf(':');
    const host = idx >= 0 ? controller.slice(0, idx) : '127.0.0.1';
    const port = idx >= 0 ? controller.slice(idx + 1) : '20123';
    return { baseUrl: `http://${host}:${port}`, secret };
  }

  // 从 Plugin 配置项构建 monitor 配置（数值项转数字，交给 normalizeConfig 归一化）
  function buildConfig() {
    return {
      selectorName: Plugin.SelectorName,
      probeUrls: typeof Plugin.ProbeUrls === 'string'
        ? Plugin.ProbeUrls.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      watchIntervalMs: Number(Plugin.WatchIntervalMs),
      watchTimeoutMs: Number(Plugin.WatchTimeoutMs),
      poolRefreshIntervalMs: Number(Plugin.PoolRefreshIntervalMs),
      poolTimeoutMs: Number(Plugin.PoolTimeoutMs),
      poolConcurrency: Number(Plugin.PoolConcurrency),
      poolFailureRateThreshold: Number(Plugin.PoolFailureRateThreshold),
      failureThreshold: Number(Plugin.FailureThreshold),
      recoveryThreshold: Number(Plugin.RecoveryThreshold),
      initialCooldownMs: Number(Plugin.InitialCooldownMs),
      maxCooldownMs: Number(Plugin.MaxCooldownMs),
      minDwellMs: Number(Plugin.MinDwellMs),
      degradationRatio: Number(Plugin.DegradationRatio),
      degradationThreshold: Number(Plugin.DegradationThreshold),
      baselineWindow: Number(Plugin.BaselineWindow),
    };
  }

  function refreshSnapshot() {
    if (monitor) snapshot.value = monitor.getSnapshot();
  }

  function persistSnapshot() {
    if (!monitor || disposed) return;
    try {
      Plugins.WriteFile(stateFile, JSON.stringify(monitor.getSnapshot(), null, 2));
    } catch (error) {
      console.warn(`[${Plugin.name}]`, '状态写入失败', error);
    }
  }

  function stop() {
    if (monitor) {
      monitor.stop();
      monitor = null;
    }
    apiClient = null;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (persistTimer) {
      clearInterval(persistTimer);
      persistTimer = null;
    }
    isRunning.value = false;
    Plugin.status = 0;
    return 2;
  }

  function start() {
    if (isRunning.value) return 1;
    const endpoint = resolveEndpoint();
    if (!endpoint) {
      throw new Error('未找到当前 profile 的 experimental.clash_api 配置');
    }
    const kernelApi = Plugins.useKernelApiStore();
    if (!kernelApi.running) {
      throw new Error('核心未运行，无法开始监控');
    }
    const config = buildConfig();
    apiClient = __core.createClashApi({
      baseUrl: endpoint.baseUrl,
      secret: endpoint.secret,
      timeoutMs: config.poolTimeoutMs,
    });
    monitor = __core.createMonitor({
      api: apiClient,
      config,
      clock: Date,
      logger: {
        info: (...args) => console.log(`[${Plugin.name}]`, ...args),
        warn: (...args) => console.warn(`[${Plugin.name}]`, ...args),
        error: (...args) => console.error(`[${Plugin.name}]`, ...args),
      },
    });
    monitor.start();
    refreshSnapshot();
    refreshTimer = setInterval(refreshSnapshot, 2000);
    persistTimer = setInterval(persistSnapshot, 30000);
    isRunning.value = true;
    Plugin.status = 1;
    return 1;
  }

  function statusText(status) {
    switch (status) {
      case 'healthy':
        return '🟢 正常';
      case 'suspect':
        return '🟡 疑似故障';
      case 'cooldown':
        return '🔴 冷却中';
      case 'half-open':
        return '🔵 半开检测';
      default:
        return '❓ 未知';
    }
  }

  function createUI() {
    const component = {
      template: `
    <Card>
      <template #title-suffix>
        <div class="font-bold">
          {{ isRunning ? '监控中' : '已停止' }} · 当前节点：{{ currentNow || '-' }}
          <span v-if="lastSwitchText" style="margin-left: 8px; font-weight: normal">
            · 上次切换 {{ lastSwitchText }}
          </span>
        </div>
      </template>
      <template #extra>
        <Button v-if="isRunning" type="primary" icon="pause" @click="handleStop()">停止</Button>
        <Button v-else type="primary" icon="play" @click="handleStart()">启动</Button>
      </template>
      <Alert v-if="lastError" type="warning" :message="'最近错误：' + lastError" style="margin-bottom: 8px" />
      <Table :data-source="rows" :columns="columns" size="small" />
      <div v-if="candidates.length" style="margin-top: 8px">
        <div class="font-bold" style="margin-bottom: 4px">候选池</div>
        <div>
          <Tag v-for="tag in candidates" :key="tag" style="margin-right: 4px">{{ tag }}</Tag>
        </div>
      </div>
    </Card>`,
      setup() {
        const columns = [
          {
            title: '节点名',
            key: 'tag',
            align: 'left',
            customRender({ value, record }) {
              if (!(record && record.isCurrent)) return value;
              return h(resolveComponent('Tag'), { color: 'green' }, () => `${value}（当前）`);
            },
          },
          {
            title: '状态',
            key: 'status',
            align: 'center',
            customRender({ value }) {
              return statusText(value);
            },
          },
          {
            title: '最近延迟',
            key: 'lastDelay',
            align: 'center',
            customRender({ value }) {
              return value == null ? '-' : value.toFixed(2) + 'ms';
            },
          },
          { title: '连续失败', key: 'failureCount', align: 'center' },
          { title: '连续成功', key: 'recoverySuccessCount', align: 'center' },
          {
            title: '冷却截止',
            key: 'cooldownUntil',
            align: 'center',
            customRender({ value }) {
              return value == null ? '-' : Plugins.formatRelativeTime(value);
            },
          },
        ];
        const rows = computed(() => {
          const snap = snapshot.value;
          if (!snap) return [];
          return snap.members
            .map((tag) => {
              const st = snap.nodeStates[tag] || {};
              return {
                tag,
                isCurrent: tag === snap.currentNow,
                status: st.status,
                lastDelay: st.lastDelay,
                failureCount: st.failureCount,
                recoverySuccessCount: st.recoverySuccessCount,
                cooldownUntil: st.cooldownUntil,
              };
            })
            .sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
        });
        const currentNow = computed(() => (snapshot.value ? snapshot.value.currentNow : null));
        const lastError = computed(() => (snapshot.value ? snapshot.value.lastError : null));
        const candidates = computed(() => (snapshot.value ? snapshot.value.candidates : []));
        const lastSwitchText = computed(() => {
          const ls = snapshot.value ? snapshot.value.lastSwitch : null;
          return ls ? `${ls.from} → ${ls.to}` : '';
        });
        return {
          isRunning,
          currentNow,
          lastError,
          candidates,
          lastSwitchText,
          rows,
          columns,
          handleStart() {
            try {
              start();
            } catch (error) {
              Plugins.message.error(error.message || String(error));
            }
          },
          handleStop() {
            stop();
          },
        };
      },
    };
    const modal = Plugins.modal(
      {
        title: Plugin.name,
        maskClosable: true,
        submit: false,
        width: '85',
        height: '85',
        cancelText: 'common.close',
      },
      { default: () => h(component) }
    );
    return modal;
  }

  return {
    onRun() {
      createUI().open();
    },
    onCoreStarted() {
      try {
        start();
      } catch (error) {
        console.warn(`[${Plugin.name}]`, '核心启动后开始监控失败', error);
      }
    },
    onCoreStopped() {
      stop();
    },
    onShutdown() {
      disposed = true;
      stop();
    },
    onDispose() {
      disposed = true;
      stop();
    },
    onUninstall() {
      disposed = true;
      stop();
      try {
        Plugins.RemoveFile(stateFile);
      } catch (error) {
        console.warn(`[${Plugin.name}]`, '清理状态文件失败', error);
      }
    },
    onConfigure() {
      stop();
      try {
        start();
      } catch (error) {
        console.warn(`[${Plugin.name}]`, '配置变更后重启失败', error);
      }
    },
    Start() {
      return start();
    },
    Stop() {
      return stop();
    },
  };
};

