import { normalizeConfig } from './config.js';
import { createNodeState } from './model.js';
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

export function createMonitor({ api, config, clock, logger }) {
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
  let watchOptimizeCount = 0;
  let watchCycleCount = 0;
  let poolCycleCount = 0;

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

  // 短路多 URL 探测：按顺序依次探测，任一 URL 成功即返回 ok；
  // 全部失败则返回最后一个失败结果，交由调用方判定。
  async function probeAny(node, urls, timeoutMs, signal) {
    let last = null;
    for (const url of urls) {
      let result;
      try {
        result = await api.probe(node, url, timeoutMs, signal);
      } catch (error) {
        result = { ok: false, reason: error?.message || String(error) };
      }
      if (result && result.ok) return { ok: true, result };
      last = result;
    }
    return { ok: false, result: last };
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

  async function runPoolProbe(tag, signal, urls) {
    const now = time.now();
    const state = ensureNodeState(tag);
    const plan = getProbePlan(state, now, cfg);
    nodeStates.set(tag, plan.state);
    if (!plan.shouldProbe) {
      return { tag, probed: false };
    }
    const { ok, result } = await probeAny(tag, urls, cfg.poolTimeoutMs, signal);
    if (ok) {
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

      // 探测目标：跳过当前 now 与 URLTest，本轮按轮换起始顺序探测多 URL
      const probeTargets = members.filter((tag) => tag !== currentNow && memberTypes[tag] !== 'URLTest');
      const urls = probeUrlSequence(poolCycleCount);

      const results = [];
      for (let i = 0; i < probeTargets.length; i += cfg.poolConcurrency) {
        const batch = probeTargets.slice(i, i + cfg.poolConcurrency);
        const batchResults = await Promise.all(batch.map((tag) => runPoolProbe(tag, cycleController.signal, urls)));
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
        watchOptimizeCount = 0;
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
      const probeResult = await probeAny(
        observedNow,
        probeUrlSequence(watchCycleCount),
        cfg.watchTimeoutMs,
        cycleController.signal,
      );
      const result = probeResult.ok
        ? probeResult.result
        : { ok: false, reason: probeResult.result?.reason || 'probe failed' };

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

        // 性能择优：当前节点延迟明显高于候选池最优时累积计数，连续达标后切到最优节点
        const best = bestCandidate();
        if (best && result.delay > best.delay * cfg.optimizeRatio) {
          watchOptimizeCount += 1;
        } else {
          watchOptimizeCount = 0;
        }
      } else {
        watchFailureCount += 1;
        watchDegradationCount = 0;
        watchOptimizeCount = 0;
      }

      const optimizeTriggered = watchOptimizeCount >= cfg.optimizeThreshold;
      const shouldSwitch = (watchFailureCount >= cfg.failureThreshold)
        || (watchDegradationCount >= cfg.degradationThreshold)
        || optimizeTriggered;
      const dwellSatisfied = now >= (currentStartAt ?? now) + cfg.minDwellMs;

      if (shouldSwitch && dwellSatisfied) {
        if (candidates.length === 0) {
          lastError = '候选池为空，等待通道 B 刷新';
          log.info(lastError);
          return { skipped: false, switchedTo: null, error: lastError };
        }

        const best = bestCandidate();
        const target = optimizeTriggered && best ? best.tag : candidates[0];
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
          watchOptimizeCount = 0;
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
        optimizeCount: watchOptimizeCount,
      },
      candidates: [...candidates],
    };
  }

  return { start, stop, getSnapshot, watchCycle, poolCycle };
}
