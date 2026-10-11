function failure(reason, status) {
  return status === undefined ? { ok: false, reason } : { ok: false, status, reason };
}

export function parseDelayResponse(status, body) {
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    return failure(`delay request failed with HTTP ${status}`, status);
  }

  let value = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return failure('delay response is not valid JSON');
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure('delay response must be a JSON object');
  }
  if (typeof value.delay !== 'number' || !Number.isFinite(value.delay) || value.delay <= 0) {
    return failure('delay response must contain a positive delay');
  }

  return { ok: true, delay: value.delay };
}
