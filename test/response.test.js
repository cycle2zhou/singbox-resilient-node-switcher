import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDelayResponse } from '../src/response.js';

test('200 with positive delay returns success', () => {
  assert.deepEqual(parseDelayResponse(200, { delay: 123 }), {
    ok: true,
    delay: 123,
  });
});

test('non-2xx responses fail with readable reason', () => {
  for (const status of [503, 504, 400]) {
    const result = parseDelayResponse(status, { delay: 123 });
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(String(status)));
  }
});

test('invalid JSON body fails', () => {
  const result = parseDelayResponse(200, 'not-json');
  assert.equal(result.ok, false);
  assert.match(result.reason, /JSON/i);
});

test('zero and negative delays fail', () => {
  for (const delay of [0, -1]) {
    const result = parseDelayResponse(200, { delay });
    assert.equal(result.ok, false);
    assert.match(result.reason, /delay/i);
  }
});
