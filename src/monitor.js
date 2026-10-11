import { normalizeConfig } from './config.js';
import { createNodeState } from './model.js';
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

export function createMonitor({ api, config, clock, logger, httpGetImpl = null }) {
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
  let watchSlowCount = 0;
  let realSlowCount = 0;
  let realDelay = null;
  let watchCycleCount = 0;
  let poolCycleCount = 0;
  // 盯梢期：切换后短窗口内快速失败快速切换，待新节点稳定后退出
  let stalking = false;
  let stalkingSuccessCount = 0;
  let stalkTimer = null;

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

  // 真实延迟多 URL 探测：依次用 httpGetImpl（native 层，走系统代理）发起真实 GET 并读 body。
  // 至少一个 URL 真实访问成功即返回「最慢延迟」（用户感知的是最慢的站点）；
  // 全部失败才返回失败（视为「HEAD 通但 GET 不通」的盲区）。
  async function realProbeAny(urls, timeoutMs) {
    if (!Array.isArray(urls) || urls.length === 0) {
      return { ok: false, result: null };
    }
    let slowest = null;
    for (const url of urls) {
      let result;
      try {
        result = await realProbe(url, timeoutMs, httpGetImpl);
      } catch (error) {
        result = { ok: false, reason: error?.message || String(error) };
      }
      if (result && result.ok && (slowest === null || result.delay > slowest.delay)) {
        slowest = result;
      }
    }
    return slowest ? { ok: true, result: slowest } : { ok: false, result: null };
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

      // 候选池按 lastDelay 升序排序，candidates[0] 恒为当前最快节点，
      // 使故障切换与择优切换统一切「最快」，复核也按「最快优先」探测
      candidates = probeTargets
        .filter((tag) => {
          const st = nodeStates.get(tag);
          return st && st.status === 'healthy' && st.lastDelay != null && st.lastError == null;
        })
        .sort((a, b) => (nodeStates.get(a)?.lastDelay ?? Infinity) - (nodeStates.get(b)?.lastDelay ?? Infinity));

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
        watchSlowCount = 0;
        realSlowCount = 0;
        realDelay = null;
        stalking = false;
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
        if (stalking) {
          stalkingSuccessCount += 1;
          if (stalkingSuccessCount >= cfg.stalkSuccessThreshold) {
            stalking = false;
            stalkingSuccessCount = 0;
            log.info('盯梢期结束，新节点稳定');
          }
        }
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

        // 真实延迟探测：sing-box 的 /delay 用 HEAD 不读 body，系统性低估真实 GET 延迟，
        // 用 httpGetImpl（native 层 HttpGet，走系统代理）测真实延迟作为可靠的慢判定（覆盖「探测快但真实慢」的盲区）。
        if (cfg.realProbeEnabled) {
          const realResult = await realProbeAny(cfg.realProbeUrls, cfg.realProbeTimeoutMs);
          if (realResult.ok && realResult.result) {
            realDelay = realResult.result.delay;
            realSlowCount = realResult.result.delay > cfg.realDelayMs ? realSlowCount + 1 : 0;
          } else {
            // 真实访问全部失败：sing-box 探测通但真实 GET 不通，视为慢/故障盲区
            realDelay = null;
            realSlowCount += 1;
          }
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
        watchSlowCount = 0;
        realSlowCount = 0;
        realDelay = null;
      }

      const optimizeTriggered = watchOptimizeCount >= cfg.optimizeThreshold;
      // 盯梢期内：失败 1 次即切、免驻留，尽快摆脱故障节点
      const effectiveFailureThreshold = stalking ? 1 : cfg.failureThreshold;
      const effectiveMinDwellMs = stalking ? 0 : cfg.minDwellMs;
      const shouldSwitch = (watchFailureCount >= effectiveFailureThreshold)
        || (watchDegradationCount >= cfg.degradationThreshold)
        || (watchSlowCount >= cfg.slowThreshold)
        || (realSlowCount >= cfg.realSlowThreshold)
        || optimizeTriggered;
      const dwellSatisfied = now >= (currentStartAt ?? now) + effectiveMinDwellMs;

      if (shouldSwitch && dwellSatisfied) {
        if (candidates.length === 0) {
          lastError = '候选池为空，等待通道 B 刷新';
          log.info(lastError);
          return { skipped: false, switchedTo: null, error: lastError };
        }

        // tag 漂移下，候选池可能残留「当前节点」的旧/新后缀快照，切换前按稳定身份排除
        candidates = candidates.filter((t) => stableKey(t) !== stableKey(observedNow));

        // 循环切换：切到候选后立即真实验证，真实失效则排除该候选继续切下一个，
        // 最多尝试 preSwitchMaxProbe 个候选，避免「切到失效节点」陷入长判定等待
        let attempts = 0;
        while (candidates.length > 0 && attempts < cfg.preSwitchMaxProbe) {
          attempts += 1;

          // 并行复核前 preSwitchMaxProbe 个候选（已按延迟升序），取最快可达者
          const probePool = candidates.slice(0, cfg.preSwitchMaxProbe);
          const checks = await Promise.all(probePool.map(async (candidate) => {
            const check = await probeAny(
              candidate,
              probeUrlSequence(watchCycleCount + attempts - 1),
              cfg.watchTimeoutMs,
              cycleController.signal,
            );
            return { candidate, ok: check.ok };
          }));
          const unreachable = new Set(checks.filter((c) => !c.ok).map((c) => c.candidate));
          const reachable = checks.filter((c) => c.ok).map((c) => c.candidate);
          if (unreachable.size > 0) {
            candidates = candidates.filter((t) => !unreachable.has(t));
            for (const c of unreachable) log.warn(`候选 ${c} 复核不可达，跳过`);
          }
          if (reachable.length === 0) {
            lastError = '候选池内候选复核均不可达，等待通道 B 刷新';
            log.warn(lastError);
            return { skipped: false, switchedTo: null, error: lastError };
          }
          const target = reachable[0]; // probePool 已按延迟升序，第一个即最快可达

          // 切换
          try {
            await api.select(cfg.selectorName, target, cycleController.signal);
          } catch (error) {
            log.warn(`切换到 ${target} 失败`, error?.message || String(error));
            lastError = `switch failed: ${error?.message}`;
            currentStartAt = now;
            // 切换失败可能由节点或控制面瞬时问题引起，重置计数避免 failureCount 累积卡死
            watchFailureCount = 0;
            watchDegradationCount = 0;
            watchOptimizeCount = 0;
            watchSlowCount = 0;
            realSlowCount = 0;
            realDelay = null;
            return { skipped: false, switchedTo: null, error: lastError };
          }

          // 刷新确认 now
          let confirmNow = null;
          try {
            const refreshed = await api.getProxies(cycleController.signal);
            confirmNow = refreshed?.proxies?.[cfg.selectorName]?.now ?? null;
          } catch (error) {
            confirmNow = null;
          }

          if (confirmNow !== null && stableKey(confirmNow) === stableKey(target)) {
            // 切换后立即真实验证：真实 GET 读 body，识别「探测通但真实失效/超慢」的节点
            let realOk = true;
            if (cfg.realProbeEnabled) {
              const realCheck = await realProbeAny(cfg.realProbeUrls, cfg.realProbeTimeoutMs);
              realOk = realCheck.ok && realCheck.result && realCheck.result.delay <= cfg.realDelayMs;
              if (!realOk) {
                const realMs = realCheck.ok && realCheck.result ? realCheck.result.delay : null;
                log.warn(`切换到 ${target} 后真实验证失败（真实延迟 ${realMs}ms），立即回退`);
              }
            }
            if (!realOk) {
              // 真实失效/超慢：标记 cooldown 排除该候选，继续循环切下一个
              const targetState = ensureNodeState(target);
              nodeStates.set(target, markCooldown(targetState, now, cfg));
              candidates = candidates.filter((t) => stableKey(t) !== stableKey(target));
              continue;
            }

            // 真实可用，正常进入盯梢期
            const oldState = ensureNodeState(observedNow);
            nodeStates.set(observedNow, markCooldown(oldState, now, cfg));
            lastSwitch = { from: observedNow, to: target, at: now };
            currentNow = target;
            lastObservedNow = target;
            currentStartAt = now;
            candidates = candidates.filter((t) => stableKey(t) !== stableKey(target) && stableKey(t) !== stableKey(observedNow));
            watchBaseline = [];
            watchFailureCount = 0;
            watchDegradationCount = 0;
            watchOptimizeCount = 0;
            watchSlowCount = 0;
            realSlowCount = 0;
            realDelay = null;
            stalking = true;
            stalkingSuccessCount = 0;
            scheduleStalkProbe();
            log.info(`已切换到 ${target}`);
            return { skipped: false, switchedTo: target, error: null };
          }

          log.warn(`切换确认失败：期望 now=${target} 实际 now=${confirmNow}`);
          lastError = 'switch confirm failed';
          currentStartAt = now;
          watchFailureCount = 0;
          watchDegradationCount = 0;
          watchOptimizeCount = 0;
          watchSlowCount = 0;
          realSlowCount = 0;
          realDelay = null;
          return { skipped: false, switchedTo: null, error: lastError };
        }

        // 循环耗尽：候选池内候选均真实失效或切换失败
        lastError = '候选池内候选均切换失败，等待通道 B 刷新';
        log.warn(lastError);
        return { skipped: false, switchedTo: null, error: lastError };
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
    if (stalkTimer) {
      clearTimeout(stalkTimer);
      stalkTimer = null;
    }
    stalking = false;
    stalkingSuccessCount = 0;
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
        slowCount: watchSlowCount,
        realSlowCount,
        realDelay,
        stalking,
        stalkingSuccessCount,
      },
      candidates: [...candidates],
    };
  }

  return { start, stop, getSnapshot, watchCycle, poolCycle };
}
