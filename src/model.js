export function createNodeState(tag) {
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

export function serializeNodeState(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('节点状态必须是对象');
  }

  return { ...state };
}
