import { createCorrelationId } from './runtime-model.js';

function stableKey(tag) {
  if (typeof tag !== 'string') return tag;
  const match = tag.match(/^(.*?)\s*\|\s*\d+(?:\.\d+)?ms\b/);
  return match ? match[1].trim() : tag;
}

export function createSwitchCoordinator({ api, config, clock = Date, logger = {}, candidateStore, observeCurrent, realProbe }) {
  if (!api || typeof api.select !== 'function' || typeof api.getProxies !== 'function') throw new TypeError('api select/getProxies are required');
  if (!candidateStore || typeof candidateStore.getSnapshot !== 'function') throw new TypeError('candidateStore is required');
  if (typeof observeCurrent !== 'function') throw new TypeError('observeCurrent is required');
  if (typeof realProbe !== 'function') throw new TypeError('realProbe is required');
  const time = clock && typeof clock.now === 'function' ? clock : Date;
  let stopped = false;
  let serial = 0;
  let active = null;
  let pending = null;

  function result(ok, fields = {}) { return { ok, ...fields }; }

  async function execute(request) {
    const requestId = createCorrelationId('request', ++serial);
    const switchId = createCorrelationId('switch', serial);
    const before = observeCurrent();
    if (!before?.now) return result(false, { reason: 'current node unavailable', requestId, switchId });
    const priority = Number.isFinite(request?.priority) ? request.priority : (request?.reason === 'failure' ? 10 : 1);
    const snapshot = candidateStore.getSnapshot();
    const allowExpired = request?.reason === 'failure' || priority >= 10;
    const selection = candidateStore.getUsableCandidates({
      now: time.now(),
      topologyFingerprint: snapshot?.topologyFingerprint,
      allowExpired,
    });
    if (!selection.candidates.length) {
      return result(false, { reason: 'candidate snapshot unavailable', requestId, switchId });
    }
    const candidates = selection.candidates
      .filter((candidate) => stableKey(candidate.tag) !== stableKey(before.now))
      .slice(0, Number(config?.preSwitchMaxProbe) || selection.candidates.length);
    let allowedCurrent = before.now;
    let confirmationFailed = false;
    for (const candidate of candidates) {
      const observed = observeCurrent();
      if (stableKey(observed?.now) !== stableKey(allowedCurrent)) {
        return result(false, { reason: 'current node changed', requestId, switchId });
      }
      try {
        // 唯一的 Selector PUT 调用点：切换后立即确认 now，再用真实 GET 验证目标。
        await api.select(config.selectorName, candidate.tag);
        const confirmed = await api.getProxies();
        const now = confirmed?.proxies?.[config.selectorName]?.now;
        if (stableKey(now) !== stableKey(candidate.tag)) {
          confirmationFailed = true;
          logger.warn?.(`switch confirmation mismatch: expected ${candidate.tag}, got ${now}`);
          continue;
        }
        allowedCurrent = now;
        const checked = await realProbe(candidate.tag, { timeoutMs: config.realStalkTimeoutMs ?? config.realProbeTimeoutMs });
        if (!checked?.ok) {
          logger.warn?.(`candidate real probe failed: ${candidate.tag}: ${checked?.reason || 'unknown'}`);
          continue;
        }
        const afterProbe = observeCurrent();
        if (stableKey(afterProbe?.now) !== stableKey(allowedCurrent)) {
          return result(false, { reason: 'current node changed', requestId, switchId });
        }
        return result(true, { node: candidate.tag, requestId, switchId, requiresRecheck: Boolean(selection.requiresRecheck) });
      } catch (error) {
        logger.warn?.(`switch candidate failed: ${candidate.tag}: ${error?.message || error}`);
      }
    }
    return result(false, { reason: confirmationFailed ? 'switch confirmation failed' : 'all candidates failed', requestId, switchId });
  }

  function startEntry(entry) {
    entry.promise = execute(entry.request).then(
      (value) => { entry.resolve?.(value); return value; },
      (error) => { entry.reject?.(error); throw error; },
    ).finally(() => {
      if (active?.promise === entry.promise) {
        active = null;
        if (pending) {
          const next = pending;
          pending = null;
          startEntry(next);
        }
      }
    });
    active = entry;
    return entry.promise;
  }

  function requestSwitch(request = {}) {
    if (stopped) return Promise.resolve(result(false, { reason: 'stopped' }));
    const observed = observeCurrent();
    const key = `${stableKey(observed?.now)}:${request.reason || 'unknown'}`;
    if (active && active.key === key) return active.promise;
    if (active) {
      if ((request.priority ?? 0) <= active.priority) return active.promise;
      if (pending) {
        if ((request.priority ?? 0) <= pending.priority) return pending.promise;
        pending.resolve?.(result(false, { reason: 'superseded' }));
      }
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      pending = { request, key, priority: request.priority ?? 0, promise, resolve, reject };
      return promise;
    }
    return startEntry({ request, key, priority: request.priority ?? 0 });
  }

  function stop() {
    stopped = true;
    pending = null;
    return { stopped: true };
  }

  return { requestSwitch, stop };
}
