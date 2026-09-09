import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentdError, isAgentdError } from '../dist/errors.js';

test('maps every error frame field', () => {
  const error = new AgentdError({
    id: 1,
    ok: false,
    code: 'lua_error',
    error: 'boom',
    tip: 'fix it',
    trace: ['init.lua:3'],
    provider_status: 429,
    retry_after_ms: 500,
    result: { duration_ms: 12 },
  });
  assert.equal(error.name, 'AgentdError');
  assert.equal(error.message, 'boom');
  assert.equal(error.code, 'lua_error');
  assert.equal(error.tip, 'fix it');
  assert.deepEqual(error.trace, ['init.lua:3']);
  assert.equal(error.providerStatus, 429);
  assert.equal(error.retryAfterMs, 500);
  assert.equal(error.durationMs, 12);
  assert.ok(error instanceof Error);
});

test('minimal frames get sane defaults', () => {
  const error = new AgentdError({
    id: 1,
    ok: false,
    code: 'busy',
    error: 'connection has 32 in-flight requests',
  });
  assert.equal(error.tip, undefined);
  assert.deepEqual(error.trace, []);
  assert.equal(error.providerStatus, undefined);
  assert.equal(error.retryAfterMs, undefined);
  assert.equal(error.durationMs, undefined);
});

test('isAgentdError narrows by code', () => {
  const error = new AgentdError({ id: 1, ok: false, code: 'denied', error: 'no' });
  assert.equal(isAgentdError(error), true);
  assert.equal(isAgentdError(error, 'denied'), true);
  assert.equal(isAgentdError(error, 'not_found'), false);
  assert.equal(isAgentdError(new Error('x')), false);
  assert.equal(isAgentdError(null), false);
});
