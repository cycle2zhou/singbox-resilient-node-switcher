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

export function recordProbeFailure(state, now, reason, config) {
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

export function recordProbeSuccess(state, now, delay, config) {
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

export function getProbePlan(state, now, config) {
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

export function isEligibleCandidate(state, now) {
  if (!state || typeof state !== 'object') {
    return false;
  }
  return state.status === STATUS.HEALTHY || state.status === STATUS.SUSPECT;
}

export function markCooldown(state, now, config) {
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
