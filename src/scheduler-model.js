const DEFAULTS = Object.freeze({
  totalConcurrency: 5,
  foregroundReserved: 2,
  backgroundConcurrency: 3,
  backgroundBatchSize: 3,
  backgroundRoundDeadlineMs: 300000,
  backgroundBackoffMs: 30000,
});

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function copy(state) {
  return { ...state, backgroundTargets: [...state.backgroundTargets] };
}

export function createSchedulerState(config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const foregroundReserved = positive(cfg.foregroundReserved, DEFAULTS.foregroundReserved);
  const totalConcurrency = positive(cfg.totalConcurrency, DEFAULTS.totalConcurrency);
  const backgroundConcurrency = Math.min(
    positive(cfg.backgroundConcurrency, DEFAULTS.backgroundConcurrency),
    Math.max(1, totalConcurrency - foregroundReserved),
  );
  return {
    totalConcurrency,
    foregroundReserved,
    backgroundConcurrency,
    backgroundBatchSize: positive(cfg.backgroundBatchSize, DEFAULTS.backgroundBatchSize),
    backgroundRoundDeadlineMs: positive(cfg.backgroundRoundDeadlineMs, DEFAULTS.backgroundRoundDeadlineMs),
    backgroundBackoffMs: positive(cfg.backgroundBackoffMs, DEFAULTS.backgroundBackoffMs),
    foregroundInFlight: 0,
    backgroundInProgress: false,
    backgroundRound: 0,
    backgroundCursor: 0,
    backgroundTargets: [],
    backgroundTopologyFingerprint: null,
    backgroundStartedAt: null,
    backgroundTimeouts: 0,
    backgroundNextStartAt: 0,
  };
}

export function reserveForeground(state, amount = 1) {
  const next = copy(state);
  const requested = positive(amount, 1);
  if (next.foregroundInFlight + requested > next.foregroundReserved) {
    return { accepted: false, reason: 'foreground-budget-exhausted', state: next };
  }
  next.foregroundInFlight += requested;
  return { accepted: true, state: next };
}

export function releaseForeground(state, amount = 1) {
  const next = copy(state);
  next.foregroundInFlight = Math.max(0, next.foregroundInFlight - positive(amount, 1));
  return next;
}

export function beginBackgroundRound(state, { topologyFingerprint = null, now = Date.now() } = {}) {
  const next = copy(state);
  if (next.backgroundInProgress) return { accepted: false, reason: 'in-progress', state: next };
  if (now < next.backgroundNextStartAt) return { accepted: false, reason: 'backoff', state: next };
  next.backgroundInProgress = true;
  next.backgroundTargets = [];
  next.backgroundTopologyFingerprint = topologyFingerprint;
  next.backgroundStartedAt = now;
  return { accepted: true, state: next };
}

export function setBackgroundTargets(state, { targets = [], topologyFingerprint = null } = {}) {
  const next = copy(state);
  if (!next.backgroundInProgress) return { accepted: false, reason: 'not-in-progress', state: next };
  next.backgroundTargets = [...targets];
  next.backgroundTopologyFingerprint = topologyFingerprint;
  return { accepted: true, state: next };
}

export function startBackgroundBatch(state, { targets = [], topologyFingerprint = null, now = Date.now() } = {}) {
  const started = beginBackgroundRound(state, { topologyFingerprint, now });
  if (!started.accepted) return started;
  const updated = setBackgroundTargets(started.state, { targets, topologyFingerprint });
  const next = updated.state;
  const startIndex = Math.min(next.backgroundCursor, targets.length);
  const batch = targets.slice(startIndex, startIndex + next.backgroundBatchSize);
  return { accepted: true, state: next, batch: { targets: batch, topologyFingerprint, startedAt: now } };
}

export function finishBackgroundBatch(state, { now = Date.now(), completed = false, topologyFingerprint = null } = {}) {
  const next = copy(state);
  if (!next.backgroundInProgress) return { published: false, reason: 'not-in-progress', state: next };
  const valid = completed && topologyFingerprint === next.backgroundTopologyFingerprint;
  next.backgroundInProgress = false;
  next.backgroundTargets = [];
  next.backgroundStartedAt = null;
  if (!valid) return { published: false, reason: 'incomplete-or-stale', state: next };
  next.backgroundRound += 1;
  next.backgroundCursor = 0;
  next.backgroundNextStartAt = now;
  return { published: true, state: next };
}

export function expireBackgroundRound(state, { now = Date.now(), cursor = state.backgroundCursor } = {}) {
  const next = copy(state);
  if (!next.backgroundInProgress) return { published: false, reason: 'not-in-progress', state: next };
  next.backgroundInProgress = false;
  next.backgroundCursor = Math.max(0, cursor);
  next.backgroundTargets = [];
  next.backgroundStartedAt = null;
  next.backgroundTimeouts += 1;
  next.backgroundNextStartAt = now + next.backgroundBackoffMs;
  return { published: false, reason: 'deadline', state: next };
}
