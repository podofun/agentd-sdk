import { test } from 'node:test';
import util from 'node:util';
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
    [() => c.sessions.create({ label: 'tg-1', user: 'u' }), 'sessions.create', { label: 'tg-1', user: 'u' }],
    [() => c.sessions.create(), 'sessions.create', {}],
    [() => c.sessions.get({ id: 'abc' }), 'sessions.get', { id: 'abc' }],
    [() => c.sessions.get({ label: 'tg-1' }), 'sessions.get', { label: 'tg-1' }],
    [() => c.sessions.get({ label: 'tg-1', user: 'u' }), 'sessions.get', { label: 'tg-1', user: 'u' }],
    [() => c.sessions.list(), 'sessions.list', {}],
    [() => c.sessions.list({ limit: 5, user: 'u' }), 'sessions.list', { limit: 5, user: 'u' }],
    [() => c.sessions.delete('abc'), 'sessions.delete', { id: 'abc' }],
    [() => c.sessions.delete('abc', { user: 'u' }), 'sessions.delete', { id: 'abc', user: 'u' }],
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

test('runners.run passes session_id through and the outcome echoes it', async t => {
  const f = await fixture(t, (socket, req) =>
    reply(socket, req, {
      text: 'hi',
      provider: 'p',
      model: null,
      stop_reason: null,
      session_id: req.params.session_id,
    }),
  );
  const out = await f.client.runners.run({ name: 'chat', prompt: 'hello', session_id: 'sess-1' });
  assert.equal(out.session_id, 'sess-1');
  assert.deepEqual(f.requests[0].params, {
    name: 'chat',
    prompt: 'hello',
    session_id: 'sess-1',
    stream: false,
  });
});

test('sessions.open returns the existing session or creates it', async t => {
  const store = new Map();
  const f = await fixture(t, (socket, req) => {
    if (req.method === 'sessions.get') {
      const s = store.get(req.params.label);
      return s
        ? reply(socket, req, { ...s, turns: [] })
        : fail(socket, req, { code: 'session_not_found', error: 'no such session' });
    }
    if (req.method === 'sessions.create') {
      const s = { id: `id-${store.size + 1}`, label: req.params.label, user: req.params.user, turn_count: 0 };
      store.set(req.params.label, s);
      return reply(socket, req, s);
    }
    return fail(socket, req, { code: 'unknown_method', error: req.method });
  });
  const a = await f.client.sessions.open('chat-9', { user: 'alice' });
  const b = await f.client.sessions.open('chat-9', { user: 'alice' });
  assert.equal(a.id, 'id-1');
  assert.equal(b.id, 'id-1');
  assert.equal(a.user, 'alice');
  assert.deepEqual(
    f.requests.map(r => r.method),
    ['sessions.get', 'sessions.create', 'sessions.get'],
  );
  // The user rides along on the lookup, not only on create.
  assert.deepEqual(f.requests[0].params, { label: 'chat-9', user: 'alice' });
});

test('sessions.open survives losing the create race', async t => {
  let gets = 0;
  const f = await fixture(t, (socket, req) => {
    if (req.method === 'sessions.get') {
      gets++;
      return gets === 1
        ? fail(socket, req, { code: 'session_not_found', error: 'none yet' })
        : reply(socket, req, { id: 'theirs', label: req.params.label, turn_count: 0, turns: [] });
    }
    return fail(socket, req, { code: 'session_label_taken', error: 'taken' });
  });
  const s = await f.client.sessions.open('race');
  assert.equal(s.id, 'theirs');
});

test('sessions.open rethrows unrelated errors', async t => {
  const f = await fixture(t, (socket, req) => fail(socket, req, { code: 'denied', error: 'nope' }));
  await assert.rejects(f.client.sessions.open('x'), e => isAgentdError(e, 'denied'));
});

test('the bearer token never appears when the client is logged or serialised', t => {
  const token = 'super-secret-token-123';
  const client = new AgentdClient({ url: 'http://127.0.0.1:1', token });
  t.after(() => client.close());
  const dumps = [util.inspect(client, { depth: 20 }), JSON.stringify(client), String(client)];
  for (const dump of dumps) assert.ok(!dump.includes(token), dump);
  assert.deepEqual(Object.keys(client), ['tools', 'actions', 'runners', 'sessions', 'skills', 'services']);
});
