/**
 * GUI.for.SingBox 插件：弹性节点切换（可恢复冷却 + 谨慎故障切换）。
 * 本文件由 scripts/build-plugin.js 自动生成，勿手改；来源 src/*.js + scripts/plugin-adapter.js。
 * 自包含单文件：不通过相对路径或运行时 import 引用项目 src/。
 */

const __core = (() => {
// ---- src/config.js ----
const DEFAULT_CONFIG = Object.freeze({
  intervalMs: 30000,
  timeoutMs: 5000,
  concurrency: 3,
  failureThreshold: 3,
  recoveryThreshold: 2,
  initialCooldownMs: 120000,
  maxCooldownMs: 1800000,
  minDwellMs: 60000,
  selectorName: '🚀 节点选择',
  probeUrl: 'https://www.gstatic.com/generate_204',
});

const POSITIVE_KEYS = [
  'intervalMs',
  'timeoutMs',
  'initialCooldownMs',
  'minDwellMs',
];

const POSITIVE_INTEGER_KEYS = [
  'concurrency',
  'failureThreshold',
  'recoveryThreshold',
];

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
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

  config.probeUrl = typeof source.probeUrl === 'string' && source.probeUrl.trim()
    ? source.probeUrl
    : DEFAULT_CONFIG.probeUrl;

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
      const combined = combineSignal(signal, timeoutMs);
      try {
        const result = await request(`/proxies/${encodedNode}/delay?${query}`, {}, combined.signal);
        if (!result.ok) return result;
        return parseDelayResponse(result.status, result.body);
      } finally {
        combined.cleanup();
      }
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

const DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204';

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
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
  let running = false;
  let cycleInProgress = false;
  let timer = null;
  let controller = null;

  function ensureNodeState(tag) {
    if (!nodeStates.has(tag)) {
      nodeStates.set(tag, createNodeState(tag));
    }
    return nodeStates.get(tag);
  }

  function probeUrl() {
    return typeof cfg.probeUrl === 'string' && cfg.probeUrl.trim() ? cfg.probeUrl : DEFAULT_PROBE_URL;
  }

  async function runProbe(tag, signal) {
    const now = time.now();
    const state = ensureNodeState(tag);
    const plan = getProbePlan(state, now, cfg);
    nodeStates.set(tag, plan.state);
    if (!plan.shouldProbe) {
      return { tag, probed: false };
    }
    let result;
    try {
      result = await api.probe(tag, probeUrl(), cfg.timeoutMs, signal);
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

  async function runCycle() {
    if (cycleInProgress) {
      return { skipped: true, switchedTo: null, error: null };
    }
    cycleInProgress = true;
    controller = new AbortController();

    try {
      let data;
      try {
        data = await api.getProxies(controller.signal);
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
      const all = Array.isArray(selector.all) ? selector.all : [];
      if (all.length === 0) {
        lastError = `主 Selector「${cfg.selectorName}」无成员`;
        log.error(lastError);
        return { skipped: false, switchedTo: null, error: lastError };
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

      const now = time.now();
      currentNow = selector.now;

      // 外部选择变化防抖：接受新选择为事实，重置其失败窗口，不切回旧节点
      if (lastObservedNow !== null && lastObservedNow !== currentNow) {
        const st = nodeStates.get(currentNow);
        if (st) {
          nodeStates.set(currentNow, {
            ...st,
            status: 'healthy',
            failureCount: 0,
            recoverySuccessCount: 0,
            cooldownMs: 0,
            cooldownUntil: null,
            lastError: null,
          });
        }
        currentStartAt = now;
      }
      if (currentStartAt === null) {
        currentStartAt = now;
      }
      lastObservedNow = currentNow;

      // 主动探测（并发受限，分批）
      const probeOrder = members;
      for (let i = 0; i < probeOrder.length; i += cfg.concurrency) {
        const batch = probeOrder.slice(i, i + cfg.concurrency);
        await Promise.all(batch.map((tag) => runProbe(tag, controller.signal)));
      }

      // 判断当前节点是否故障并满足驻留时间
      const curState = nodeStates.get(currentNow);
      const curFailed = curState && curState.status === 'cooldown';
      const dwellSatisfied = now >= (currentStartAt ?? now) + cfg.minDwellMs;

      if (curFailed && dwellSatisfied) {
        const candidates = members
          .filter((tag) => tag !== currentNow)
          .filter((tag) => isEligibleCandidate(nodeStates.get(tag), now))
          .filter((tag) => {
            const st = nodeStates.get(tag);
            return st && st.status === 'healthy' && st.lastDelay != null && st.lastError == null;
          });

        if (candidates.length > 0) {
          const target = candidates[0];
          try {
            await api.select(cfg.selectorName, target, controller.signal);
          } catch (error) {
            log.warn(`切换到 ${target} 失败`, error?.message || String(error));
            currentStartAt = now;
            return { skipped: false, switchedTo: null, error: `switch failed: ${error?.message}` };
          }

          // 三段式确认：刷新并核对 now
          let confirmNow = null;
          try {
            const refreshed = await api.getProxies(controller.signal);
            confirmNow = refreshed?.proxies?.[cfg.selectorName]?.now ?? null;
          } catch (error) {
            confirmNow = null;
          }

          if (confirmNow === target) {
            lastSwitch = { from: currentNow, to: target, at: now };
            currentNow = target;
            lastObservedNow = target;
            currentStartAt = now;
            log.info(`已切换到 ${target}`);
            return { skipped: false, switchedTo: target, error: null };
          }
          log.warn(`切换确认失败：期望 now=${target} 实际 now=${confirmNow}`);
          currentStartAt = now;
          return { skipped: false, switchedTo: null, error: 'switch confirm failed' };
        }

        log.info('当前节点故障但无合格候选，保留当前选择');
      }

      return { skipped: false, switchedTo: null, error: lastError };
    } finally {
      cycleInProgress = false;
      controller = null;
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      runCycle().catch((error) => log.error('监控轮次异常', error?.message || String(error)));
    }, cfg.intervalMs);
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  function getSnapshot() {
    const states = {};
    for (const [tag, state] of nodeStates) {
      states[tag] = { ...state };
    }
    return {
      selectorName: cfg.selectorName,
      running,
      cycleInProgress,
      currentNow,
      members: [...members],
      memberTypes: { ...memberTypes },
      nodeStates: states,
      lastError,
      lastSwitch: lastSwitch ? { ...lastSwitch } : null,
    };
  }

  return { runCycle, start, stop, getSnapshot };
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
  const { ref, computed, h } = Vue;

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
      intervalMs: Number(Plugin.IntervalMs),
      timeoutMs: Number(Plugin.TimeoutMs),
      concurrency: Number(Plugin.Concurrency),
      failureThreshold: Number(Plugin.FailureThreshold),
      recoveryThreshold: Number(Plugin.RecoveryThreshold),
      initialCooldownMs: Number(Plugin.InitialCooldownMs),
      maxCooldownMs: Number(Plugin.MaxCooldownMs),
      minDwellMs: Number(Plugin.MinDwellMs),
      probeUrl: Plugin.ProbeUrl,
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
      timeoutMs: config.timeoutMs,
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
        </div>
      </template>
      <template #extra>
        <Button v-if="isRunning" type="primary" icon="pause" @click="handleStop()">停止</Button>
        <Button v-else type="primary" icon="play" @click="handleStart()">启动</Button>
      </template>
      <Alert v-if="lastError" type="warning" :message="'最近错误：' + lastError" style="margin-bottom: 8px" />
      <Table :data-source="rows" :columns="columns" size="small" />
    </Card>`,
      setup() {
        const columns = [
          { title: '节点名', key: 'tag', align: 'left' },
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
          return snap.members.map((tag) => {
            const st = snap.nodeStates[tag] || {};
            return {
              tag,
              status: st.status,
              lastDelay: st.lastDelay,
              failureCount: st.failureCount,
              recoverySuccessCount: st.recoverySuccessCount,
              cooldownUntil: st.cooldownUntil,
            };
          });
        });
        const currentNow = computed(() => (snapshot.value ? snapshot.value.currentNow : null));
        const lastError = computed(() => (snapshot.value ? snapshot.value.lastError : null));
        return {
          isRunning,
          currentNow,
          lastError,
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

