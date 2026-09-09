import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentdClient, AgentdError, isAgentdError } from '../dist/index.js';
import { startServer, reply, fail, TOKEN } from './helpers/server.mjs';

async function fixture(t, handler, options) {
  const server = await startServer(t, handler, options);
  const client = new AgentdClient({ url: server.url, token: TOKEN, timeoutMs: 1000 });
  t.after(() => client.close());
  return { ...server, client };
}

const echo = (socket, req) => reply(socket, req, { method: req.method, params: req.params });

test('each namespace method sends the matching protocol method and params', async t => {
  const f = await fixture(t, echo);
  const c = f.client;
  const cases = [
    [() => c.health(), 'health', {}],
    [() => c.tools.list(), 'tools.list', {}],
    [() => c.runners.list(), 'runners.list', {}],
    [() => c.runners.inspect('r'), 'runners.inspect', { name: 'r' }],
    [() => c.skills.list(), 'skills.list', {}],
    [() => c.skills.inspect('s'), 'skills.inspect', { name: 's' }],
    [() => c.services.list(), 'services.list', {}],
    [() => c.request('custom.method', { a: 1 }), 'custom.method', { a: 1 }],
  ];
  for (const [call, method, params] of cases) {
    assert.deepEqual(await call(), { method, params });
  }
  assert.equal(f.connections(), 1);
});

test('actions.call forwards args and caller identity and returns the raw envelope result', async t => {
  const f = await fixture(t, (socket, req) =>
    reply(socket, req, { result: req.params.args, duration_ms: 7 }),
  );
  const out = await f.client.actions.call('echo', { text: 'hi' }, { session: 'chat-1', user: 'u1' });
  assert.deepEqual(out, { result: { text: 'hi' }, duration_ms: 7 });
  assert.deepEqual(f.requests[0].params, {
    name: 'echo',
    args: { text: 'hi' },
    session: 'chat-1',
    user: 'u1',
  });
  await f.client.actions.call('noargs');
  assert.deepEqual(f.requests[1].params, { name: 'noargs' });
});

test('runners.run sends stream:false and strips undefined keys', async t => {
  const f = await fixture(t, (socket, req) =>
    reply(socket, req, { text: 'ok', provider: 'p', model: null, stop_reason: null }),
  );
  const messages = [{ role: 'user', content: 'hello' }];
  const out = await f.client.runners.run({
    name: 'review',
    messages,
    timeout_ms: 500,
    model: undefined,
    system: undefined,
  });
  assert.equal(out.text, 'ok');
  assert.deepEqual(f.requests[0].params, { name: 'review', messages, timeout_ms: 500, stream: false });
  assert.ok(!('model' in f.requests[0].params));
});

test('daemon failures surface as AgentdError with typed code', async t => {
  const f = await fixture(t, (socket, req) =>
    fail(socket, req, {
      code: 'runner_not_found',
      error: 'runner `x` not found',
      tip: 'Run `agentctl runner ls`',
    }),
  );
  await assert.rejects(f.client.runners.run({ name: 'x', prompt: 'hi' }), e => {
    assert.ok(e instanceof AgentdError);
    assert.ok(isAgentdError(e, 'runner_not_found'));
    assert.equal(e.tip, 'Run `agentctl runner ls`');
    return true;
  });
});

test('options validation happens in the constructor', () => {
  assert.throws(() => new AgentdClient({ url: 'file:///x' }), TypeError);
  assert.throws(() => new AgentdClient({ token: 'bad\r\n' }), TypeError);
  assert.throws(() => new AgentdClient({ timeoutMs: 0 }), RangeError);
  assert.throws(() => new AgentdClient({ connectTimeoutMs: -1 }), RangeError);
  new AgentdClient().close();
});
