function cloneRuntimeState(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function createRuntimeState(initial = {}) {
  return {
    revision: Number.isInteger(initial.revision) && initial.revision >= 0 ? initial.revision : 0,
    currentNow: initial.currentNow ?? null,
    lastSwitch: cloneRuntimeState(initial.lastSwitch) ?? null,
    lastError: cloneRuntimeState(initial.lastError) ?? null,
    candidateSnapshot: cloneRuntimeState(initial.candidateSnapshot) ?? null,
    nodeStates: cloneRuntimeState(initial.nodeStates) ?? {},
    stalking: Boolean(initial.stalking),
    diagnostics: cloneRuntimeState(initial.diagnostics) ?? {},
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
      reason: event.reason ?? 'unknown',
      priority: event.priority ?? null,
      candidateGeneration: event.candidateGeneration ?? null,
      candidateDelay: event.candidateDelay ?? null,
      candidateRecheck: event.candidateRecheck ?? false,
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
    next.candidateSnapshot = cloneRuntimeState(event.snapshot) ?? null;
  } else if (event.type === 'node.state') {
    if (typeof event.tag === 'string') next.nodeStates[event.tag] = cloneRuntimeState(event.nodeState);
  } else if (event.type === 'stalking.changed') {
    next.stalking = Boolean(event.stalking);
  }
  return next;
}
