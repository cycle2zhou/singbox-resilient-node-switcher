import { normalizeConfig } from './config.js';
import { createNodeState } from './model.js';
import { createCandidateStore } from './candidate-store.js';
import { createTopologySnapshot, createCandidateSnapshot, createCorrelationId } from './runtime-model.js';
import { createRuntimeState, applyRuntimeEvent } from './runtime-state.js';
import { createSwitchCoordinator } from './switch-coordinator.js';
import { createScanPolicy } from './scan-policy.js';
import { createStabilityScore } from './stability-score.js';
import { createOptimizationPolicy } from './optimization-policy.js';
import {
  createSchedulerState,
  reserveForeground,
  releaseForeground,
  beginBackgroundRound,
  setBackgroundTargets,
  startBackgroundBatch,
  finishBackgroundBatch,
  expireBackgroundRound,
} from './scheduler-model.js';
import { realProbe } from './api.js';
import {
  getProbePlan,
  recordProbeSuccess,
  recordProbeFailure,
  markCooldown,
} from './health-state.js';

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

// GFS 实时测速会改写节点名（追加「 | IP | 延迟ms | 速度mb/s [...]_序号_序号」后缀），
// 同一节点的 tag 在不同时刻后缀不同，导致精确匹配失效（切换确认失败、剔除旧节点失效）。
// stableKey 截断「| 延迟ms」及之后的可变后缀，保留到 IP，得到稳定身份用于比较。
function stableKey(tag) {
  if (typeof tag !== 'string') return tag;
  const m = tag.match(/^(.*?)\s*\|\s*\d+(?:\.\d+)?ms\b/);
  return m ? m[1].trim() : tag;
}

// 节点死亡判定：只匹配 503（TCP 连接失败 = 明确的节点死亡）。
// 504（sing-box 探测超时）/timeout（fetch 超时）不在此列——它们既可能是节点慢（偶发抖动，
// 实测日本01 间歇 504：第一次 504、第二次 200ms），也可能是探测 URL 被墙的全局故障，
// 必须保留累积/熔断保护，避免把抖动误判为断网、或把健康节点误标记为失败。
// 此判定用于 watchCycle 前台断网即时判定（poolCycle 全池熔断改用「无成功即熔断」，见下方）。
function isNodeDeath(reason) {
  const t = String(reason || '').toLowerCase();
  return t.includes('503');
}

export function createMonitor({ api, config, clock, logger, httpGetImpl = null }) {
  const cfg = normalizeConfig(config);
  const time = clock && typeof clock.now === 'function' ? clock : Date;
  const log = logger && typeof logger.info === 'function' ? logger : silentLogger();

  const nodeStates = new Map();
  let members = [];
  let memberTypes = {};
  let currentUrlTestGroup = null;
  let currentNow = null;
  let lastObservedNow = null;
  let currentStartAt = null;
  let lastError = null;
  let lastSwitch = null;
  let candidates = [];
  const candidateStore = createCandidateStore({ clock: time });
  const scanPolicy = createScanPolicy({ config: cfg, clock: time });
  const stabilityScore = createStabilityScore({
    config: {
      stabilityWindowMs: cfg.stabilityWindowMs,
      stabilityMaxSamples: cfg.stabilityMaxSamples,
      headMinSamples: cfg.stabilityHeadMinSamples,
      realMinSamples: cfg.stabilityRealMinSamples,
      realLatencyMinSamples: cfg.stabilityRealLatencyMinSamples,
    },
    clock: time,
  });
  const optimizationPolicy = createOptimizationPolicy({ config: cfg, clock: time });
  let stabilityCandidateProbeCount = 0;
  let candidateGeneration = 0;
  let topologyFingerprint = null;
  let running = false;
  let watchInProgress = false;
  let watchRerunRequested = false;
  let watchStopped = false;
  let poolInProgress = false;
  let watchTimer = null;
  let poolTimer = null;
  let watchController = null;
  let poolController = null;
  let backgroundDeadlineTimer = null;
  let switchCoordinator = null;
  let schedulerState = createSchedulerState({
    totalConcurrency: cfg.foregroundReserved + cfg.backgroundConcurrency,
    foregroundReserved: cfg.foregroundReserved,
    backgroundConcurrency: cfg.backgroundConcurrency,
    backgroundBatchSize: cfg.backgroundBatchSize,
    backgroundRoundDeadlineMs: cfg.backgroundRoundDeadlineMs,
    backgroundBackoffMs: cfg.backgroundBackoffMs,
  });

  // 通道 A 专用状态
  let watchBaseline = [];
  let watchFailureCount = 0;
  let watchDegradationCount = 0;
  let watchOptimizeCount = 0;
  let watchSlowCount = 0;
  let realSlowCount = 0;
  let realDelay = null;
  let watchCycleCount = 0;
  let poolCycleCount = 0;
  let lastScanStartedAt = null;
  let lastScanDurationMs = null;
  let lastScanTargetCount = 0;
  let lastScanRound = 0;
  let lastBatchDiagnostics = null;
  let lastTimeoutReason = 'none';
  // 盯梢期：切换后短窗口内快速失败快速切换，待新节点稳定后退出
  let stalking = false;
  let stalkingSuccessCount = 0;
  let stalkTimer = null;
  // 真实探测单飞：真实 GET 独立于 HEAD 快探周期，单飞避免并发堆积；
  // generation 用于丢弃「节点已变化/已切换」后的过期结果
  let realProbeInFlight = false;
  let realProbeGeneration = 0;
  let realProbeLastAt = 0;
  let realProbeTimer = null;
  let nativeHttpGetTail = Promise.resolve();
  function serializedHttpGet(url) {
    const request = nativeHttpGetTail.then(() => httpGetImpl(url));
    nativeHttpGetTail = request.catch(() => {});
    return request;
  }
  // 真实 GET 失败/超慢后请求一次立即快探；消费后清除，避免失败时反复重入。
  let realSwitchRequested = false;
  // 故障切换成功后的保护窗口：避免择优逻辑立即打断恢复过程。
  let failureProtectionUntil = 0;
  // 事件时间线：内存环形队列，仅保留最近 eventLogLimit 条
  let eventLog = [];
  let runtimeState = createRuntimeState();
  let correlationCounter = 0;

  function applyEvent(type, fields = {}) {
    runtimeState = applyRuntimeEvent(runtimeState, { type, at: time.now(), ...fields });
  }

  function reserveForegroundSlot() {
    const result = reserveForeground(schedulerState, 1);
    if (result.accepted) schedulerState = result.state;
    return result.accepted;
  }

  async function getProxiesWithTimeout(signal, timeoutMs, label) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    let timer = null;
    try {
      return await Promise.race([
        api.getProxies(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(new DOMException(`${label} timeout`, 'TimeoutError'));
            reject(new Error(`${label} timeout`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  function releaseForegroundSlot() {
    schedulerState = releaseForeground(schedulerState, 1);
  }

  function ensureNodeState(tag) {
    if (!nodeStates.has(tag)) {
      nodeStates.set(tag, createNodeState(tag));
    }
    return nodeStates.get(tag);
  }

  // 返回本轮探测 URL 序列：从 cycleCount 对应的起始位开始轮换，
  // 使各 URL 轮流充当首个探测目标，避免固定顺序下对首个 URL 不可达的节点
  // 每次都要先耗尽超时才能轮到可达的 URL。
  function probeUrlSequence(cycleCount) {
    const urls = cfg.probeUrls;
    if (!Array.isArray(urls) || urls.length === 0) return [];
    const start = cycleCount % urls.length;
    const sequence = [];
    for (let i = 0; i < urls.length; i += 1) {
      sequence.push(urls[(start + i) % urls.length]);
    }
    return sequence;
  }

  // 多 URL 探测：真实 GET 串行执行，避免 GFS 原生请求桥并发占满；任一 URL 成功即返回 ok。
  // 全部失败则返回最后一个 URL 的失败结果，交由调用方判定。
  async function probeAny(node, urls, timeoutMs, signal) {
    if (!Array.isArray(urls) || urls.length === 0) {
      return { ok: false, result: null };
    }
    const probeOne = async (url) => {
      let result;
      try {
        result = await api.probe(node, url, timeoutMs, signal);
      } catch (error) {
        result = { ok: false, reason: error?.message || String(error) };
      }
      if (result && result.ok) return result;
      throw result || new Error('probe failed');
    };
    try {
      const result = await Promise.any(urls.map(probeOne));
      return { ok: true, result };
    } catch (aggregate) {
      const errors = Array.isArray(aggregate?.errors) ? aggregate.errors : [];
      return { ok: false, result: errors[errors.length - 1] || { ok: false, reason: 'probe failed' } };
    }
  }

  async function probeAnyWithTimeout(node, urls, timeoutMs, signal) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    let timer = null;
    try {
      return await Promise.race([
        probeAny(node, urls, timeoutMs, controller.signal),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort(new DOMException('watch probe timeout', 'TimeoutError'));
            resolve({ ok: false, result: { ok: false, reason: 'watch probe timeout' } });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  // 真实延迟多 URL 探测：并行用 httpGetImpl（native 层，走系统代理）发起真实 GET 并读 body。
  // 至少一个 URL 真实访问成功即返回「最慢延迟」（用户感知的是最慢的站点）；
  // 全部失败才返回失败（视为「HEAD 通但 GET 不通」的盲区）。
  async function realProbeAny(urls, timeoutMs, serializeNative = false) {
    if (!Array.isArray(urls) || urls.length === 0) {
      return { ok: false, result: null };
    }
    const results = [];
    for (const url of urls) {
      try {
        // 外层软超时不能取消 GFS 原生请求；先等前一个原生请求真正结束，
        // 再启动下一个 URL，避免“上一个仍挂起、下一个已超时”的隐性并发。
        // 但 native 请求可能因当前节点不可用而永久挂起（走系统代理的 HttpGet 无取消机制），
        // 死等会让 runRealProbe 卡住、foregroundInFlight 泄漏、后台快扫被 foreground-wait 阻塞。
        // 因此等待加软超时兜底，超时后继续下一个 URL（每个 realProbe 自身仍有 withTimeout 保护）。
        if (serializeNative) {
          await Promise.race([
            nativeHttpGetTail,
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
          ]);
        }
        results.push(await realProbe(url, timeoutMs, serializeNative ? serializedHttpGet : httpGetImpl));
      } catch (error) {
        results.push({ ok: false, reason: error?.message || String(error) });
      }
    }
    const successful = results.filter((result) => result && result.ok);
    let slowest = null;
    for (const result of successful) {
      if (slowest === null || result.delay > slowest.delay) {
        slowest = result;
      }
    }
    const minSuccesses = Math.min(
      Math.max(1, Number.isInteger(cfg.realProbeMinSuccesses) ? cfg.realProbeMinSuccesses : 1),
      urls.length,
    );
    return {
      ok: successful.length >= minSuccesses,
      result: slowest,
      successCount: successful.length,
      requiredSuccesses: minSuccesses,
    };
  }

  // 返回候选池中延迟最小的节点 {tag, delay}；候选池为空或全无延迟时返回 null
  function bestCandidate() {
    let best = null;
    for (const tag of candidates) {
      const st = nodeStates.get(tag);
      if (st && st.lastDelay != null && (best === null || st.lastDelay < best.delay)) {
        best = { tag, delay: st.lastDelay };
      }
    }
    return best;
  }

  // 切换后安排一次立即快探：不等下一轮轮询，尽快确认新节点是否可用。
  // 仅在真实运行（running）时排定时器，测试手动驱动 watchCycle 时不排，避免定时器泄漏。
  function scheduleStalkProbe() {
    if (!running) return;
    if (stalkTimer) clearTimeout(stalkTimer);
    stalkTimer = setTimeout(() => {
      stalkTimer = null;
      watchCycle().catch((error) => log.error('盯梢快探异常', error?.message || String(error)));
    }, cfg.stalkProbeDelayMs);
  }

  function stabilitySnapshot() {
    const now = time.now();
    const currentSummary = currentNow ? stabilityScore.getSummary(stableKey(currentNow), now) : null;
    return {
      current: currentSummary,
      candidates: stabilityScore.getAllSummaries(now),
      candidateProbes: stabilityCandidateProbeCount,
    };
  }

  function optimizationInput(now) {
    const currentState = currentNow ? nodeStates.get(currentNow) : null;
    const currentStability = currentNow ? stabilityScore.getSummary(stableKey(currentNow), now) : null;
    const current = currentStability && currentState
      ? { ...currentStability, delay: currentState.lastDelay }
      : null;
    const candidateInputs = candidates.map((tag) => {
      const state = nodeStates.get(tag);
      const summary = stabilityScore.getSummary(stableKey(tag), now);
      return summary && state ? { ...summary, tag, delay: state.lastDelay } : null;
    }).filter(Boolean);
    return { current, candidates: candidateInputs };
  }

  function recordEvent(type, fields = {}) {
    eventLog.push({ type, at: time.now(), ...fields });
    if (eventLog.length > cfg.eventLogLimit) {
      eventLog = eventLog.slice(-cfg.eventLogLimit);
    }
  }

  function resetAfterConfirmedSwitch(from, to, now, fallback = false, metadata = {}) {
    const oldState = ensureNodeState(from);
    nodeStates.set(from, markCooldown(oldState, now, cfg));
    lastSwitch = {
      from,
      to,
      at: now,
      reason: metadata.reason ?? 'unknown',
      requestId: metadata.requestId ?? null,
      switchId: metadata.switchId ?? null,
      priority: metadata.priority ?? null,
      candidateGeneration: metadata.candidateGeneration ?? null,
      candidateDelay: metadata.candidateDelay ?? null,
      candidateRecheck: metadata.candidateRecheck ?? false,
    };
    currentNow = to;
    lastObservedNow = to;
    currentStartAt = now;
    watchBaseline = [];
    watchFailureCount = 0;
    watchDegradationCount = 0;
    watchOptimizeCount = 0;
    watchSlowCount = 0;
    realSlowCount = 0;
    realSwitchRequested = false;
    realDelay = null;
    failureProtectionUntil = metadata.reason === 'failure' ? now + cfg.optimizeDwellMs : 0;
    stalking = true;
    stalkingSuccessCount = 0;
    realProbeGeneration += 1;
    const switchId = createCorrelationId('switch', ++correlationCounter);
    applyEvent('switch.succeeded', {
      from,
      to,
      switchId: metadata.switchId ?? switchId,
      requestId: metadata.requestId ?? switchId,
      reason: metadata.reason ?? 'unknown',
      priority: metadata.priority ?? null,
      candidateGeneration: metadata.candidateGeneration ?? null,
      candidateDelay: metadata.candidateDelay ?? null,
      candidateRecheck: metadata.candidateRecheck ?? false,
    });
    recordEvent('switch-confirmed', {
      from,
      to,
      fallback,
      switchId: metadata.switchId ?? switchId,
      requestId: metadata.requestId ?? switchId,
      reason: metadata.reason ?? 'unknown',
      priority: metadata.priority ?? null,
      candidateGeneration: metadata.candidateGeneration ?? null,
      candidateDelay: metadata.candidateDelay ?? null,
      candidateRecheck: metadata.candidateRecheck ?? false,
    });
    scheduleStalkProbe();
  }

  switchCoordinator = createSwitchCoordinator({
    api,
    config: cfg,
    clock: time,
    logger: log,
    candidateStore,
    observeCurrent: () => ({ now: currentNow }),
    probeCandidate: async (tag, request = {}) => {
      const check = await probeAnyWithTimeout(tag, probeUrlSequence(watchCycleCount + (request.attempt || 0)), cfg.watchTimeoutMs, watchController?.signal);
      return check;
    },
    realProbe: async (_tag, options = {}) => {
      const check = await realProbeAny(cfg.realProbeUrls, options.timeoutMs || cfg.realStalkTimeoutMs);
      if (!check.ok || !check.result) return { ok: false, reason: '真实探测失败' };
      if (check.result.delay > cfg.realDelayMs) return { ok: false, delay: check.result.delay, reason: '真实延迟超过阈值' };
      return check.result;
    },
    fallback: async ({ current }) => {
      if (currentUrlTestGroup && stableKey(currentUrlTestGroup) !== stableKey(current)) return current;
      return members.find((tag) => memberTypes[tag] === 'URLTest' && stableKey(tag) !== stableKey(current))
        || (memberTypes[current] === 'URLTest' ? current : null);
    },
    onNowConfirmed: async (now) => { currentNow = now; },
    onConfirmed: async ({ from, to, at, fallback, reason, requestId, switchId, priority, candidateGeneration, candidateDelay, candidateRecheck }) => resetAfterConfirmedSwitch(from, to, at, fallback, {
      reason,
      requestId,
      switchId,
      priority,
      candidateGeneration,
      candidateDelay,
      candidateRecheck,
    }),
    onDiagnostic: async (diagnostic) => recordEvent(diagnostic.type || 'switch-diagnostic', diagnostic),
  });

  // 单飞真实探测：真实 GET 走系统代理读 body 测真实延迟，覆盖 sing-box HEAD 探测盲区。
  // 独立于 HEAD 快探周期、不阻塞 watchCycle；结果绑定 stableKey + generation，
  // 节点已变化/切换后返回的过期结果直接丢弃。
  async function runRealProbe() {
    if (!cfg.realProbeEnabled || realProbeInFlight || currentNow == null) {
      return { skipped: true, stale: false };
    }
    if (!reserveForegroundSlot()) {
      recordEvent('foreground-budget-exhausted', { kind: 'real' });
      return { skipped: true, stale: false, reason: 'foreground-budget-exhausted' };
    }
    realProbeInFlight = true;
    const generation = ++realProbeGeneration;
    const targetKey = stableKey(currentNow);
    const isStalking = stalking;
    const timeoutMs = isStalking ? cfg.realStalkTimeoutMs : cfg.realProbeTimeoutMs;
    recordEvent('real-probe-start', { key: targetKey, generation, stalking: isStalking });
    try {
      const realResult = await realProbeAny(cfg.realProbeUrls, timeoutMs, true);
      // 过期丢弃：节点身份已变（外部切换/自动切换）或期间已启动新探测
      if (stableKey(currentNow) !== targetKey || generation !== realProbeGeneration) {
        recordEvent('real-probe-stale', { key: targetKey, generation });
        return { skipped: false, stale: true };
      }
      if (realResult.ok && realResult.result) {
        realDelay = realResult.result.delay;
        stabilityScore.recordReal({
          tag: currentNow,
          stableKey: targetKey,
          delay: realDelay,
          ok: true,
          at: time.now(),
        });
        if (realResult.result.delay > cfg.realDelayMs) {
          realSlowCount += 1;
          if (realSlowCount >= cfg.realSlowThreshold) realSwitchRequested = true;
        } else {
          realSlowCount = 0;
          realSwitchRequested = false;
          // 盯梢期：真实 GET 达标才累计，达到 realStalkSuccessThreshold 次退出盯梢
          if (stalking) {
            stalkingSuccessCount += 1;
            if (stalkingSuccessCount >= cfg.realStalkSuccessThreshold) {
              stalking = false;
              stalkingSuccessCount = 0;
              recordEvent('stalk-exit', { key: targetKey });
              log.info('盯梢期结束，新节点真实可用');
            }
          }
        }
      } else {
        realDelay = null;
        stabilityScore.recordReal({
          tag: currentNow,
          stableKey: targetKey,
          delay: null,
          ok: false,
          error: 'real probe failed',
          at: time.now(),
        });
        realSlowCount += 1;
        if (realSlowCount >= cfg.realSlowThreshold) realSwitchRequested = true;
      }
      if (realSwitchRequested) {
        recordEvent('real-probe-switch-requested', { key: targetKey, realSlowCount });
        if (running) {
          scheduleStalkProbe();
        }
      }
      recordEvent('real-probe-result', { key: targetKey, generation, ok: realResult.ok, delay: realDelay, realSlowCount, stalking });
      return { skipped: false, stale: false, ok: realResult.ok };
    } finally {
      realProbeInFlight = false;
      realProbeLastAt = time.now();
      releaseForegroundSlot();
    }
  }

  // 真实探测调度：setTimeout 链式，按是否盯梢动态调整间隔
  function scheduleRealProbe() {
    if (!running || !cfg.realProbeEnabled) return;
    if (realProbeTimer) clearTimeout(realProbeTimer);
    const interval = stalking ? cfg.stalkProbeDelayMs : cfg.realProbeIntervalMs;
    realProbeTimer = setTimeout(() => {
      realProbeTimer = null;
      runRealProbe()
        .then(() => scheduleRealProbe())
        .catch((error) => {
          log.error('真实探测异常', error?.message || String(error));
          scheduleRealProbe();
        });
    }, interval);
  }

  async function runPoolProbe(tag, signal, urls, fastScan = false) {
    const now = time.now();
    const state = ensureNodeState(tag);
    const plan = getProbePlan(state, now, cfg);
    nodeStates.set(tag, plan.state);
    if (!plan.shouldProbe) {
      return { tag, probed: false };
    }
    // 冷启动快扫：用更短超时快速分辨死活（精确延迟交给后续正常轮次）。
    // 死节点 504 在 sing-box 端默认 2s 才返回，短超时让 187 节点全量快扫从 ~7 分钟降到 ~3 分钟。
    const probeTimeoutMs = fastScan ? cfg.coldStartTimeoutMs : cfg.poolTimeoutMs;
    // 软超时兜底：WebView fetch 偶发挂起（不响应 abort，底层请求无法取消），Promise.race
    // 让 runPoolProbe 不永久卡住。挂起的 fetch 会占用连接，但快扫一次性扫完即停止，
    // 挂起请求最终被 GC，不会无限累积。
    const { ok, result } = await Promise.race([
      probeAny(tag, urls, probeTimeoutMs, signal),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, result: { ok: false, reason: 'probe soft timeout' } }), probeTimeoutMs * 3)),
    ]);
    if (ok) {
      nodeStates.set(tag, recordProbeSuccess(nodeStates.get(tag), now, result.delay, cfg));
      scanPolicy.recordProbe({ tag, ok: true, delay: result.delay, now });
      return { tag, probed: true, ok: true };
    }
    const reason = result?.reason || 'probe failed';
    nodeStates.set(tag, recordProbeFailure(nodeStates.get(tag), now, reason, cfg));
    scanPolicy.recordProbe({ tag, ok: false, reason, now });
    return { tag, probed: true, ok: false, reason };
  }

  async function poolCycle() {
    if (poolInProgress) {
      return { skipped: true, error: null };
    }
    poolInProgress = true;
    lastScanStartedAt = time.now();
    const cycleController = new AbortController();
    poolController = cycleController;
    const startedBackground = beginBackgroundRound(schedulerState, { now: time.now() });
    if (!startedBackground.accepted) {
      poolInProgress = false;
      poolController = null;
      return { skipped: true, error: startedBackground.reason };
    }
    schedulerState = startedBackground.state;
    const snapshotStates = new Map([...nodeStates].map(([k, v]) => [k, { ...v }]));
    const snapshotCandidates = [...candidates];
    const snapshotScanPolicy = scanPolicy.snapshot();
    const snapshotMembers = [...members];
    const snapshotMemberTypes = { ...memberTypes };
    const snapshotCurrentNow = currentNow;
    const snapshotTopologyFingerprint = topologyFingerprint;
    const snapshotCurrentUrlTestGroup = currentUrlTestGroup;
    const restorePoolSnapshot = () => {
      nodeStates.clear();
      for (const [k, v] of snapshotStates) nodeStates.set(k, v);
      candidates = snapshotCandidates;
      scanPolicy.restore(snapshotScanPolicy);
      members = snapshotMembers;
      memberTypes = snapshotMemberTypes;
      currentNow = snapshotCurrentNow;
      topologyFingerprint = snapshotTopologyFingerprint;
      currentUrlTestGroup = snapshotCurrentUrlTestGroup;
    };
    let deadlineReached = false;
    let rejectDeadline;
    const deadlinePromise = new Promise((_, reject) => { rejectDeadline = reject; });
    backgroundDeadlineTimer = setTimeout(() => {
      deadlineReached = true;
      lastTimeoutReason = 'round-deadline';
      cycleController.abort();
      rejectDeadline(new DOMException('后台扫描轮次已到期', 'AbortError'));
    }, cfg.backgroundRoundDeadlineMs);

    try {
      let data;
      try {
        data = await Promise.race([
          getProxiesWithTimeout(cycleController.signal, cfg.backgroundRoundDeadlineMs, '后台 Selector 读取'),
          deadlinePromise,
        ]);
      } catch (error) {
        if (deadlineReached) {
          restorePoolSnapshot();
          return { skipped: true, error: null };
        }
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

      // 探测目标：评分策略控制后台预算；当前节点和候选始终强制保留，URLTest 不参与叶子探测。
      // 冷启动快扫：首次成功发布候选快照前（candidateGeneration===0）全量探测建立 score 画像，
      // 避免重启后死节点按成员顺序堵住好节点、候选池十几分钟为空。
      const fastScan = candidateGeneration === 0;
      const policyTargets = scanPolicy.selectTargets({
        tags: members.filter((tag) => memberTypes[tag] !== 'URLTest'),
        currentNow,
        candidateTags: candidates,
        now: time.now(),
        fastScan,
      });
      const probeTargets = policyTargets.filter((tag) => tag !== currentNow && memberTypes[tag] !== 'URLTest');
      lastScanTargetCount = probeTargets.length;
      lastScanRound = scanPolicy.snapshot().round;
      const topology = createTopologySnapshot(members, memberTypes, currentNow, time.now());
      const scanTopologyFingerprint = topology.topologyFingerprint;
      const targetState = setBackgroundTargets(schedulerState, {

        targets: probeTargets,
        topologyFingerprint: scanTopologyFingerprint,
      });
      if (!targetState.accepted) {
        return { skipped: true, error: targetState.reason };
      }
      schedulerState = targetState.state;
      // 冷启动快扫：只用最稳定的最后一个探测 URL（github）快速分辨死活。
      // 3 URL 并行 × poolConcurrency 会在 WebView 低并发连接池上排队，死节点 1s 超时
      // 让 187 节点全量快扫远超 5 分钟 deadline；单 URL 把请求数降到 1/3，快扫 ~1.3 分钟完成。
      const urls = fastScan ? [cfg.probeUrls[cfg.probeUrls.length - 1]] : probeUrlSequence(poolCycleCount);
      const results = [];
      const batchSize = fastScan
        ? Math.min(cfg.coldStartConcurrency, probeTargets.length)
        : Math.min(schedulerState.backgroundBatchSize, schedulerState.backgroundConcurrency);
      for (let i = schedulerState.backgroundCursor; i < probeTargets.length; i += batchSize) {
        const batchStartedAt = time.now();
        let foregroundWaitMs = 0;
        if (cycleController.signal.aborted) {
          if (fastScan) {
            // 冷启动快扫超时：保留已探测结果，发布部分候选池（渐进建立），
            // 打破「超时回滚→candidateGeneration 不增→反复快扫」死循环。
            break;
          }
          schedulerState = expireBackgroundRound(schedulerState, { now: time.now(), cursor: i }).state;
          restorePoolSnapshot();
          return { skipped: true, error: null };
        }
        // 冷启动快扫是建立候选池的关键路径，不应被前台探测（watchCycle/runRealProbe）占用
        // foreground 预算而无限等待——尤其 runRealProbe 可能因当前节点不可用卡住导致
        // foregroundInFlight 泄漏，快扫会死等。快扫时跳过 foreground 等待，让快扫尽快完成。
        if (!fastScan && schedulerState.foregroundInFlight > 0) {
          const waitStartedAt = time.now();
          await new Promise((resolve) => setTimeout(resolve, 10));
          foregroundWaitMs += Math.max(0, time.now() - waitStartedAt);
          if (cycleController.signal.aborted) {
            lastTimeoutReason = 'foreground-wait';
            lastBatchDiagnostics = {
              startedAt: batchStartedAt,
              durationMs: Math.max(0, time.now() - batchStartedAt),
              cursor: i,
              foregroundWaitMs,
              targetCount: 0,
              timeoutReason: lastTimeoutReason,
            };
            schedulerState = expireBackgroundRound(schedulerState, { now: time.now(), cursor: i }).state;
            restorePoolSnapshot();
            return { skipped: true, error: null };
          }
          i -= batchSize;
          continue;
        }
        schedulerState = { ...schedulerState, backgroundCursor: i };
        const batch = probeTargets.slice(i, i + batchSize);
        try {
          const batchResults = await Promise.all(batch.map((tag) => runPoolProbe(tag, cycleController.signal, urls, fastScan)));
          results.push(...batchResults);
          if (cycleController.signal.aborted) {
            throw new DOMException('后台扫描轮次已到期', 'AbortError');
          }
          lastBatchDiagnostics = {
            startedAt: batchStartedAt,
            durationMs: Math.max(0, time.now() - batchStartedAt),
            cursor: i,
            foregroundWaitMs,
            targetCount: batch.length,
            timeoutReason: 'none',
          };
          lastTimeoutReason = 'none';
        } catch (error) {
          if (cycleController.signal.aborted) {
            lastTimeoutReason = foregroundWaitMs > 0 ? 'foreground-wait' : 'probe-batch';
            lastBatchDiagnostics = {
              startedAt: batchStartedAt,
              durationMs: Math.max(0, time.now() - batchStartedAt),
              cursor: i,
              foregroundWaitMs,
              targetCount: batch.length,
              timeoutReason: lastTimeoutReason,
            };
            if (fastScan) {
              // 冷启动快扫超时：发布部分候选池（渐进建立），不回滚已探测结果。
              break;
            }
            schedulerState = expireBackgroundRound(schedulerState, { now: time.now(), cursor: i }).state;
            restorePoolSnapshot();
            return { skipped: true, error: null };
          }
          restorePoolSnapshot();
          throw error;
        }
      }
      schedulerState = finishBackgroundBatch(schedulerState, {
        now: time.now(),
        completed: true,
        topologyFingerprint: topology.topologyFingerprint,
      }).state;

      // 全池失败熔断：仅当「无任何探测成功」时判定为探测基础设施故障（探测 URL 被墙 / API 挂）。
      // 只要有任一节点成功，说明探测目标可达，失败均为节点真实死亡/超时，正常记录淘汰。
      // （504 大量出现可能是死节点被短超时误判，而非全局故障，不能据此熔断作废整轮。）
      const probed = results.filter((r) => r.probed);
      if (probed.length > 0) {
        const successCount = probed.filter((r) => r.ok).length;
        if (successCount === 0) {
          restorePoolSnapshot();
          schedulerState = finishBackgroundBatch(schedulerState, {
            now: time.now(),
            completed: false,
            topologyFingerprint: topology.topologyFingerprint,
          }).state;
          lastError = '全池探测失败率超过阈值，判定为探测目标/API 故障，本轮作废';
          log.warn(lastError);
          return { skipped: false, error: lastError };
        }
      }

      // 候选池按 lastDelay 升序排序，candidates[0] 恒为当前最快节点，
      // 使故障切换与择优切换统一切「最快」，复核也按「最快优先」探测
      candidates = probeTargets
        .filter((tag) => {
          const st = nodeStates.get(tag);
          return st && st.status === 'healthy' && st.lastDelay != null && st.lastError == null;
        })
        .sort((a, b) => {
          const diff = (nodeStates.get(a)?.lastDelay ?? Infinity) - (nodeStates.get(b)?.lastDelay ?? Infinity);
          return diff !== 0 ? diff : a.localeCompare(b);
        });

      candidateStore.setTopology(scanTopologyFingerprint);
      const candidateSnapshot = createCandidateSnapshot({
        generation: candidateGeneration + 1,
        createdAt: time.now(),
        // 后台整轮可能超过刷新间隔；快照至少覆盖一轮截止时间，避免扫描期间误判过期。
        expiresAt: time.now() + Math.max(cfg.poolRefreshIntervalMs, cfg.backgroundRoundDeadlineMs),
        topologyFingerprint: topology.topologyFingerprint,
        candidates: candidates.map((tag) => {
          const state = nodeStates.get(tag);
          return { tag, stableKey: stableKey(tag), delay: state.lastDelay, checkedAt: state.lastProbeAt ?? time.now() };
        }),
      });
      if (candidateStore.publish(candidateSnapshot)) {
        topologyFingerprint = scanTopologyFingerprint;
        candidateGeneration = candidateSnapshot.generation;
        const scanId = createCorrelationId('scan', ++correlationCounter);
        lastScanDurationMs = Math.max(0, time.now() - lastScanStartedAt);
        applyEvent('candidate.published', { snapshot: candidateSnapshot });
        applyEvent('scan.completed', {
          scanId,
          durationMs: lastScanDurationMs,
          targetCount: lastScanTargetCount,
          round: lastScanRound,
          published: true,
        });
        recordEvent('scan-completed', {
          scanId,
          generation: candidateSnapshot.generation,
          candidateCount: candidates.length,
          targetCount: lastScanTargetCount,
          durationMs: lastScanDurationMs,
        });
      }

      return { skipped: false, error: null };
    } finally {
      if (backgroundDeadlineTimer) {
        clearTimeout(backgroundDeadlineTimer);
        backgroundDeadlineTimer = null;
      }
      if (schedulerState.backgroundInProgress) {
        schedulerState = expireBackgroundRound(schedulerState, {
          now: time.now(),
          cursor: schedulerState.backgroundCursor,
        }).state;
      }
      poolInProgress = false;
      poolController = null;
      poolCycleCount += 1;
    }
  }

  async function watchCycle() {
    if (watchInProgress) {
      watchRerunRequested = true;
      return { skipped: true, switchedTo: null, error: null };
    }
    if (!reserveForegroundSlot()) {
      recordEvent('foreground-budget-exhausted', { kind: 'watch' });
      return { skipped: true, switchedTo: null, error: 'foreground-budget-exhausted' };
    }
    watchInProgress = true;
    const cycleController = new AbortController();
    watchController = cycleController;

    try {
      let data;
      try {
        data = await getProxiesWithTimeout(cycleController.signal, cfg.watchTimeoutMs, '前台 Selector 读取');
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
      currentUrlTestGroup = Object.entries(proxies).find(([tag, proxy]) => (
        proxy?.type === 'URLTest' && Array.isArray(proxy.all) && proxy.all.some((member) => stableKey(member) === stableKey(observedNow))
      ))?.[0] || null;

      // 外部变化检测：接受新选择，不切回旧节点；手动选择的新节点立即进入盯梢期
      // stableKey 忽略 GFS 实时测速追加的延迟/速度后缀，避免同一节点被反复重置。
      if (lastObservedNow !== null && stableKey(lastObservedNow) !== stableKey(observedNow)) {
        watchBaseline = [];
        watchFailureCount = 0;
        watchDegradationCount = 0;
        watchOptimizeCount = 0;
        watchSlowCount = 0;
        realSlowCount = 0;
        realSwitchRequested = false;
        realDelay = null;
        realProbeGeneration += 1; // 使在途真实探测结果过期
        stalking = true;
        stalkingSuccessCount = 0;
        currentStartAt = now;
      }
      if (currentStartAt === null) {
        currentStartAt = now;
      }
      lastObservedNow = observedNow;
      currentNow = observedNow;

      // GFS 实时测速会改写节点名（追加 IP/延迟/速度/序号后缀），
      // 若 members 仅在 poolCycle 更新而 currentNow 在 watchCycle 更新，
      // 两次响应间节点名漂移会导致精确匹配失效、UI 无法标识当前节点。
      // 因此此处让 members 与 currentNow 取自同一次响应。
      const all = Array.isArray(selector.all) ? selector.all : [];
      if (all.length > 0) {
        members = [...all];
        memberTypes = {};
        for (const tag of members) {
          memberTypes[tag] = proxies[tag]?.type ?? 'unknown';
          ensureNodeState(tag);
        }
        for (const tag of [...nodeStates.keys()]) {
          if (!members.includes(tag)) nodeStates.delete(tag);
        }
      }

      lastError = null;

      // 只探测当前 now，多 URL 短路探测（任一成功即健康）
      const probeResult = await probeAnyWithTimeout(
        observedNow,
        probeUrlSequence(watchCycleCount),
        cfg.watchTimeoutMs,
        cycleController.signal,
      );
      const result = probeResult.ok
        ? probeResult.result
        : { ok: false, reason: probeResult.result?.reason || 'probe failed' };
      stabilityScore.recordHead({
        tag: observedNow,
        stableKey: stableKey(observedNow),
        delay: result?.delay ?? null,
        ok: result?.ok === true,
        error: result?.ok === true ? null : result?.reason || 'probe failed',
        at: now,
      });

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
        // 绝对慢判定：探测成功但延迟超过 maxDelayMs 即计「慢」，连续达标触发切换
        if (result.delay > cfg.maxDelayMs) {
          watchSlowCount += 1;
        } else {
          watchSlowCount = 0;
        }

        // 性能择优：当前节点延迟明显高于候选池最优时累积计数，连续达标后切到最优节点
        const best = bestCandidate();
        if (best && result.delay > best.delay * cfg.optimizeRatio) {
          watchOptimizeCount += 1;
        } else {
          watchOptimizeCount = 0;
        }
      } else {
        // 明确断网（503 连接失败）一次即判，无需累积 failureThreshold 次；
        // 软失败（504 超时/timeout/延迟高/退化）仍走多次确认，避免把偶发抖动误判为断网。
        watchFailureCount = isNodeDeath(result?.reason)
          ? (stalking ? 1 : cfg.failureThreshold)
          : watchFailureCount + 1;
        watchDegradationCount = 0;
        watchOptimizeCount = 0;
        watchSlowCount = 0;
        realSlowCount = 0;
        realDelay = null;
      }

      // 盯梢期内：失败 1 次即切、HEAD 高延迟 1 次即切、免驻留，尽快摆脱故障节点
      const effectiveFailureThreshold = stalking ? 1 : cfg.failureThreshold;
      const effectiveSlowThreshold = stalking ? 1 : cfg.slowThreshold;
      const effectiveMinDwellMs = stalking || realSwitchRequested ? 0 : cfg.minDwellMs;
      const failureTriggered = (watchFailureCount >= effectiveFailureThreshold)
        || (watchDegradationCount >= cfg.degradationThreshold)
        || (watchSlowCount >= effectiveSlowThreshold)
        || (realSlowCount >= cfg.realSlowThreshold);
      const optimization = optimizationPolicy.evaluate({
        ...optimizationInput(now),
        generation: candidateGeneration,
        topologyFingerprint: candidateStore.getSnapshot()?.topologyFingerprint || null,
        now,
        reason: failureTriggered ? 'failure' : 'optimize',
        failureProtectionUntil,
      });
      // 在稳定性样本尚未满足资格时保留旧择优路径，避免把缺失真实样本伪装成稳定结论；
      // 具备资格后由新策略接管择优请求。故障条件始终独立计算，不受择优策略阻塞。
      const legacyOptimizeFallback = !failureTriggered && optimization.kind === 'none'
        && typeof optimization.reason === 'string'
        && optimization.reason.startsWith('insufficient-')
        && watchOptimizeCount >= cfg.optimizeThreshold;
      const optimizeTriggered = !failureTriggered && (optimization.kind === 'optimize' || legacyOptimizeFallback);
      const shouldSwitch = failureTriggered || optimizeTriggered;
      const dwellSatisfied = now >= (currentStartAt ?? now) + effectiveMinDwellMs;

      if (shouldSwitch && dwellSatisfied) {
        const coordinated = await switchCoordinator.requestSwitch({
          reason: optimizeTriggered ? 'optimize' : 'failure',
          priority: optimizeTriggered ? 1 : 10,
          attempt: watchCycleCount,
        });
        if (coordinated.ok) {
          if (optimizeTriggered && !failureTriggered && optimization.candidate) {
            optimizationPolicy.recordResult({ kind: 'optimize', candidate: optimization.candidate, ok: true, at: now });
          }
          return { skipped: false, switchedTo: coordinated.node, error: null };
        }
        if (coordinated.reason === 'candidate snapshot unavailable') {
          lastError = '候选池为空，等待通道 B 刷新';
        } else if (coordinated.reason === 'all candidates failed') {
          lastError = 'switch failed: all candidates failed';
        } else if (coordinated.reason === 'switch confirmation failed') {
          lastError = 'switch confirm failed';
        } else {
          lastError = coordinated.reason || 'switch failed';
        }
        if (coordinated.reason !== 'candidate snapshot unavailable') {
          watchFailureCount = 0;
          watchDegradationCount = 0;
          watchOptimizeCount = 0;
          watchSlowCount = 0;
          realSlowCount = 0;
          realDelay = null;
        }
        return { skipped: false, switchedTo: null, error: lastError };

      }

      return { skipped: false, switchedTo: null, error: lastError };
    } finally {
      watchInProgress = false;
      watchController = null;
      releaseForegroundSlot();
      watchCycleCount += 1;
      if (watchRerunRequested) {
        watchRerunRequested = false;
        queueMicrotask(() => {
          if (!watchStopped) watchCycle().catch((error) => log.error('补充快探轮次异常', error?.message || String(error)));
        });
      }
    }
  }

  function start() {
    if (running) return;
    watchStopped = false;
    running = true;
    poolCycle().catch((error) => log.error('候选池预热异常', error?.message || String(error)));
    watchTimer = setInterval(() => {
      watchCycle().catch((error) => log.error('快探轮次异常', error?.message || String(error)));
    }, cfg.watchIntervalMs);
    poolTimer = setInterval(() => {
      poolCycle().catch((error) => log.error('候选池轮次异常', error?.message || String(error)));
    }, cfg.scanIntervalMs);
    scheduleRealProbe();
  }

  function stop() {
    watchStopped = true;
    running = false;
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (poolTimer) {
      clearInterval(poolTimer);
      poolTimer = null;
    }
    if (backgroundDeadlineTimer) {
      clearTimeout(backgroundDeadlineTimer);
      backgroundDeadlineTimer = null;
    }
    if (stalkTimer) {
      clearTimeout(stalkTimer);
      stalkTimer = null;
    }
    if (realProbeTimer) {
      clearTimeout(realProbeTimer);
      realProbeTimer = null;
    }
    stalking = false;
    stalkingSuccessCount = 0;
    realProbeGeneration += 1; // 使在途真实探测结果过期
    watchController?.abort();
    watchController = null;
    poolController?.abort();
    poolController = null;
    switchCoordinator?.stop();
  }

  function getSnapshot() {
    const states = {};
    const storedCandidateSnapshot = candidateStore.getSnapshot();
    const usableCandidates = candidateStore.getUsableCandidates({
      now: time.now(),
      topologyFingerprint,
      allowExpired: false,
    });
    for (const [tag, state] of nodeStates) {
      states[tag] = { ...state };
    }
    return {
      selectorName: cfg.selectorName,
      revision: runtimeState.revision,
      diagnostics: {
        ...runtimeState.diagnostics,
        candidateGeneration,
        candidateCount: candidates.length,
        lastSwitchId: runtimeState.lastSwitch?.switchId ?? null,
        candidateSnapshot: {
          generation: storedCandidateSnapshot?.generation ?? null,
          expiresAt: storedCandidateSnapshot?.expiresAt ?? null,
          topologyFingerprint: storedCandidateSnapshot?.topologyFingerprint ?? topologyFingerprint,
          usableCandidateCount: usableCandidates.candidates.length,
          requiresRecheck: usableCandidates.requiresRecheck,
          rejectionReason: usableCandidates.rejectionReason ?? null,
        },
        scan: {
          round: lastScanRound,
          targetCount: lastScanTargetCount,
          startedAt: lastScanStartedAt,
          durationMs: lastScanDurationMs,
          policy: scanPolicy.snapshot(),
        },
        stability: stabilitySnapshot(),
        scheduler: {
          foregroundReserved: schedulerState.foregroundReserved,
          foregroundInFlight: schedulerState.foregroundInFlight,
          backgroundConcurrency: schedulerState.backgroundConcurrency,
          backgroundBatchSize: schedulerState.backgroundBatchSize,
          backgroundInProgress: schedulerState.backgroundInProgress,
          backgroundRound: schedulerState.backgroundRound,
          backgroundCursor: schedulerState.backgroundCursor,
          backgroundTargetCount: schedulerState.backgroundTargets.length,
          backgroundStartedAt: schedulerState.backgroundStartedAt,
          backgroundTimeouts: schedulerState.backgroundTimeouts,
          backgroundNextStartAt: schedulerState.backgroundNextStartAt,
          lastBatch: lastBatchDiagnostics ? { ...lastBatchDiagnostics } : null,
          lastTimeoutReason,
        },
      },
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
        optimizeCount: watchOptimizeCount,
        slowCount: watchSlowCount,
        realSlowCount,
        realDelay,
        stalking,
        stalkingSuccessCount,
      },
      candidates: [...candidates],
      events: [...eventLog],
    };
  }

  return { start, stop, getSnapshot, watchCycle, poolCycle, runRealProbe };
}
