function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function createRuntimeState(initial = {}) {
  return {
    revision: Number.isInteger(initial.revision) && initial.revision >= 0 ? initial.revision : 0,
    currentNow: initial.currentNow ?? null,
    lastSwitch: clone(initial.lastSwitch) ?? null,
    lastError: clone(initial.lastError) ?? null,
    candidateSnapshot: clone(initial.candidateSnapshot) ?? null,
    nodeStates: clone(initial.nodeStates) ?? {},
    stalking: Boolean(initial.stalking),
    diagnostics: clone(initial.diagnostics) ?? {},
  };
}

export function applyRuntimeEvent(state, event) {
  if (!state || !event || typeof event.type !== 'string') return state;
  const next = createRuntimeState(state);
  next.revision = state.revision + 1;
  if (event.type === 'switch.succeeded') {
    next.currentNow = event.to ?? next.currentNow;
    next.lastSwitch = {
      at: event.at,
      from: event.from ?? null,
      to: event.to ?? null,
      switchId: event.switchId ?? null,
      requestId: event.requestId ?? null,
    };
    next.lastError = null;
  } else if (event.type === 'switch.failed') {
    next.lastError = { at: event.at, reason: event.reason ?? 'switch failed', switchId: event.switchId ?? null, requestId: event.requestId ?? null };
  } else if (event.type === 'scan.completed') {
    next.diagnostics.lastScan = {
      scanId: event.scanId ?? null,
      at: event.at,
      durationMs: event.durationMs,
      published: Boolean(event.published),
    };
  } else if (event.type === 'candidate.published') {
    next.candidateSnapshot = clone(event.snapshot) ?? null;
  } else if (event.type === 'node.state') {
    if (typeof event.tag === 'string') next.nodeStates[event.tag] = clone(event.nodeState);
  } else if (event.type === 'stalking.changed') {
    next.stalking = Boolean(event.stalking);
  }
  return next;
}
