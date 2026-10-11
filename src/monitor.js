import { normalizeConfig } from './config.js';
import { createNodeState } from './model.js';
import {
  getProbePlan,
  recordProbeSuccess,
  recordProbeFailure,
  isEligibleCandidate,
} from './health-state.js';

const DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204';

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
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
    const cycleController = new AbortController();
    controller = cycleController;

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
        await Promise.all(batch.map((tag) => runProbe(tag, cycleController.signal)));
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
            await api.select(cfg.selectorName, target, cycleController.signal);
          } catch (error) {
            log.warn(`切换到 ${target} 失败`, error?.message || String(error));
            currentStartAt = now;
            return { skipped: false, switchedTo: null, error: `switch failed: ${error?.message}` };
          }

          // 三段式确认：刷新并核对 now
          let confirmNow = null;
          try {
            const refreshed = await api.getProxies(cycleController.signal);
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
