import { createRuntimeState, applyRuntimeEvent } from './runtime-state.js';

function parseState(raw) {
  if (!raw) return createRuntimeState();
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new Error('invalid runtime state');
  }
  return createRuntimeState(value);
}

export function createStateStore({ readFile, writeFile, clock = Date, logger = {}, path = 'state.json' }) {
  if (typeof readFile !== 'function' || typeof writeFile !== 'function') throw new TypeError('readFile and writeFile are required');
  const time = clock && typeof clock.now === 'function' ? clock : Date;
  let state = createRuntimeState();
  let loaded = false;
  let pendingWrites = new Map();
  let flushPromise = null;

  async function load({ currentNow = null } = {}) {
    try {
      const raw = await readFile(path);
      state = parseState(raw);
    } catch (error) {
      logger.warn?.(`runtime state load failed: ${error?.message || error}`);
      state = createRuntimeState();
    }
    if (currentNow !== null && currentNow !== undefined) state.currentNow = currentNow;
    loaded = true;
    return { ...state, diagnostics: { ...state.diagnostics } };
  }

  async function commit(event) {
    if (!loaded) await load();
    state = applyRuntimeEvent(state, event);
    const revision = state.revision;
    pendingWrites.set(revision, JSON.stringify(state));
    void flush();
    return { ...state, diagnostics: { ...state.diagnostics } };
  }

  async function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      while (pendingWrites.size) {
        const entries = [...pendingWrites.entries()].sort(([a], [b]) => a - b);
        pendingWrites.clear();
        for (const [revision, body] of entries) {
          try {
            await writeFile(path, body);
            if (revision < state.revision) continue;
          } catch (error) {
            logger.warn?.(`runtime state write failed at revision ${revision}: ${error?.message || error}`);
          }
        }
      }
    })().finally(() => { flushPromise = null; });
    return flushPromise;
  }

  function getState() { return { ...state, diagnostics: { ...state.diagnostics } }; }
  return { load, commit, flush, getState, now: () => time.now() };
}
