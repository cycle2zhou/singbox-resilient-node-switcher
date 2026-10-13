import { createTopologySnapshot, createCandidateSnapshot } from './runtime-model.js';

function stableKey(tag) {
  if (typeof tag !== 'string') return tag;
  const match = tag.match(/^(.*?)\s*\|\s*\d+(?:\.\d+)?ms\b/);
  return match ? match[1].trim() : tag;
}

function asProxyMap(body) {
  return body?.proxies && typeof body.proxies === 'object' ? body.proxies : {};
}

function withDeadline(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
  ]);
}

export function createCandidateScanner({ api, config, clock = Date, logger = {}, store }) {
  if (!api || typeof api.getProxies !== 'function') throw new TypeError('api.getProxies is required');
  if (!store) throw new TypeError('store is required');
  const time = clock && typeof clock.now === 'function' ? clock : Date;
  let stopped = false;
  let timer = null;
  let scanGeneration = 0;
  let active = null;

  async function scan() {
    if (stopped) return { published: false, reason: 'stopped' };
    if (active) return active;
    const controller = new AbortController();
    const operation = (async () => {
      const startedAt = time.now();
      try {
        const body = await api.getProxies(controller.signal);
        const proxies = asProxyMap(body);
        const selector = proxies[config.selectorName];
        if (!selector || !Array.isArray(selector.all)) return { published: false, reason: 'selector unavailable' };
        const members = selector.all.filter((tag) => tag !== selector.now && proxies[tag]?.type !== 'URLTest');
        const memberTypes = Object.fromEntries(selector.all.map((tag) => [tag, proxies[tag]?.type ?? 'unknown']));
        const topology = createTopologySnapshot(selector.all, memberTypes, selector.now, startedAt);
        store.setTopology(topology.topologyFingerprint);
        const limit = Math.max(1, Number(config.poolConcurrency) || 1);
        const results = [];
        let cursor = 0;
        const worker = async () => {
          while (cursor < members.length && !controller.signal.aborted) {
            const tag = members[cursor++];
            try {
              const urls = Array.isArray(config.probeUrls) && config.probeUrls.length > 0 ? config.probeUrls : ['https://www.gstatic.com/generate_204'];
              const probes = urls.map((url) => api.probe(tag, url, config.poolTimeoutMs, controller.signal));
              const successful = await Promise.any(probes.map((probe) => probe.then((result) => {
                if (!result?.ok || !Number.isFinite(result.delay) || result.delay <= 0) {
                  throw new Error(result?.reason || 'candidate probe failed');
                }
                return result;
              })));
              results.push({ tag, stableKey: stableKey(tag), delay: successful.delay, checkedAt: time.now() });
            } catch (error) {
              logger.warn?.(`candidate probe failed: ${tag}: ${error?.message || error}`);
            }
          }
        };
        let deadlineExpired = false;
        const workers = Promise.all(Array.from({ length: Math.min(limit, members.length) }, worker));
        const deadlineTimer = setTimeout(() => {
          deadlineExpired = true;
          controller.abort(new DOMException('candidate scan deadline exceeded', 'TimeoutError'));
        }, Math.max(1, Number(config.poolTimeoutMs) || 1));
        try {
          await Promise.race([
            workers,
            new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true })),
          ]);
        } finally {
          clearTimeout(deadlineTimer);
        }
        if (deadlineExpired) return { published: false, reason: 'deadline' };
        if (controller.signal.aborted) return { published: false, reason: 'cancelled' };
        if (results.length === 0 && members.length > 0) return { published: false, reason: 'deadline' };
        results.sort((left, right) => left.delay - right.delay || left.tag.localeCompare(right.tag));
        const previous = store.getSnapshot();
        const snapshot = createCandidateSnapshot({
          generation: Math.max(scanGeneration + 1, (previous?.generation ?? 0) + 1),
          createdAt: startedAt,
          expiresAt: startedAt + config.poolRefreshIntervalMs,
          topologyFingerprint: topology.topologyFingerprint,
          candidates: results,
        });
        scanGeneration = snapshot.generation;
        return store.publish(snapshot) ? { published: true, snapshot } : { published: false, reason: 'stale' };
      } catch (error) {
        logger.warn?.(`candidate scan failed: ${error?.message || error}`);
        return { published: false, reason: 'api error', error };
      }
    })();
    active = operation.finally(() => { active = null; });
    return active;
  }

  function start() {
    if (timer || stopped) return;
    void scan();
    timer = setInterval(() => void scan(), config.poolRefreshIntervalMs);
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
    active?.catch(() => {});
    active = null;
    return { stopped: true };
  }

  return { scan, start, stop };
}
