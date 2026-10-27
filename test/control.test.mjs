import { test } from 'node:test';
import util from 'node:util';
import assert from 'node:assert/strict';
import { AgentdControl } from '../dist/index.js';
import { startServer, reply, fail, TOKEN } from './helpers/server.mjs';

const caller = { runner: 'coder', interface: 'ws', service: null, session: 'ws-3', user: null };

const missingGrant = {
  id: 7,
  kind: 'missing_grant',
  action: 'dev.shell',
  tool: 'dev',
  reason: 'the handler asked for `shell.exec:cargo`',
  requires: ['shell.exec:cargo'],
  missing: ['shell.exec:cargo'],
  detail: { argv: ['cargo', 'test'], cwd: '/home/me/project' },
  run_id: 'run-12',
  session_id: 'sess-1',
  caller: { ...caller, run_id: 'run-12', approval: 'human' },
};

const folder = {
  id: 8,
  kind: 'folder',
  action: '/home/me/project',
  tool: null,
  reason: 'Let agent.d work in this folder?',
  requires: [],
  missing: [],
  detail: { folder: '/home/me/project' },
  caller,
};

const push = (socket, req) => socket.send(JSON.stringify({ event: 'approval.request', req }));

const acknowledge = (socket, req) => {
  if (req.method === 'approvals.subscribe') reply(socket, req, { subscribed: true });
};

async function fixture(t, handler = acknowledge, onConnect = () => {}) {
  const server = await startServer(t, handler, { path: '/control' });
  const control = new AgentdControl({ url: server.url, adminToken: TOKEN, timeoutMs: 1000 });
  t.after(() => control.close());
  return { ...server, control, onConnect };
}

/** Wait until the fake daemon sees the control socket, then hand it over. */
async function connectedSocket(f) {
  await f.control.connect();
  for (let i = 0; i < 100 && f.clients.size === 0; i++) await new Promise(r => setTimeout(r, 5));
  return [...f.clients].at(-1);
}

test('connects to /control with the admin token and sends subscribe and resolve', async t => {
  const f = await fixture(t, (socket, req) => {
    if (req.method === 'approvals.subscribe') return reply(socket, req, { subscribed: true });
    if (req.method === 'approvals.resolve') return reply(socket, req, { resolved: req.params.request_id });
    return fail(socket, req, { code: 'invalid', error: `unknown control method \`${req.method}\`` });
  });
  assert.deepEqual(await f.control.approvals.subscribe(), { subscribed: true });
  assert.deepEqual(await f.control.approvals.resolve(7, 'allow_once'), { resolved: 7 });
  await f.control.approvals.resolve(8, 'allow_forever');
  await f.control.approvals.resolve(9, 'deny');
  assert.deepEqual(
    f.requests.slice(1).map(r => [r.method, r.params]),
    [
      ['approvals.resolve', { request_id: 7, verdict: 'allow_once' }],
      ['approvals.resolve', { request_id: 8, verdict: 'allow_forever' }],
      ['approvals.resolve', { request_id: 9, verdict: 'deny' }],
    ],
  );
  assert.equal(f.connections(), 1);
});

test('connect() and the start of requests() prove the subscription with a round trip', async t => {
  const f = await fixture(t);
  await f.control.connect();
  await f.control.connect();
  assert.deepEqual(
    f.requests.map(r => r.method),
    ['approvals.subscribe'],
  );

  // After a drop, connecting again subscribes again.
  [...f.clients].at(-1).terminate();
  await new Promise(r => setTimeout(r, 20));
  await f.control.connect();
  assert.deepEqual(
    f.requests.map(r => r.method),
    ['approvals.subscribe', 'approvals.subscribe'],
  );
  assert.equal(f.connections(), 2);

  const g = await fixture(t);
  const iterator = g.control.approvals.requests()[Symbol.asyncIterator]();
  const first = iterator.next();
  for (let i = 0; i < 100 && g.requests.length === 0; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(g.requests[0].method, 'approvals.subscribe');
  push([...g.clients].at(-1), folder);
  assert.deepEqual((await first).value, folder);
});

test('a refused subscription fails connect() and the requests() loop', async t => {
  const f = await fixture(t, (socket, req) =>
    fail(socket, req, { code: 'invalid', error: 'No approvals here.' }),
  );
  await assert.rejects(f.control.connect(), /No approvals here/);
  await assert.rejects(f.control.approvals.requests()[Symbol.asyncIterator]().next(), /No approvals here/);
});

test('requests() yields every pushed approval request, folder questions included', async t => {
  const f = await fixture(t);
  const seen = [];
  const listening = (async () => {
    for await (const request of f.control.approvals.requests()) {
      seen.push(request);
      if (seen.length === 2) break;
    }
  })();
  const socket = await connectedSocket(f);
  push(socket, missingGrant);
  push(socket, { ...folder, kind: 'some_future_kind' });
  push(socket, folder);
  await listening;
  assert.deepEqual(seen, [missingGrant, folder]);
});

test('two listeners each get every request, and breaking out stops only that one', async t => {
  const f = await fixture(t);
  const first = f.control.approvals.requests()[Symbol.asyncIterator]();
  const second = f.control.approvals.requests()[Symbol.asyncIterator]();
  const socket = await connectedSocket(f);
  push(socket, missingGrant);
  assert.deepEqual((await first.next()).value, missingGrant);
  assert.deepEqual((await second.next()).value, missingGrant);
  await first.return();
  push(socket, folder);
  assert.deepEqual((await second.next()).value, folder);
  assert.deepEqual(await first.next(), { value: undefined, done: true });
});

test('aborting the signal or closing the client ends the loop quietly', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const aborted = f.control.approvals.requests({ signal: controller.signal })[Symbol.asyncIterator]();
  const closed = f.control.approvals.requests()[Symbol.asyncIterator]();
  await connectedSocket(f);
  const pending = aborted.next();
  controller.abort();
  assert.deepEqual(await pending, { value: undefined, done: true });
  const waiting = closed.next();
  f.control.close();
  assert.deepEqual(await waiting, { value: undefined, done: true });
  const late = f.control.approvals.requests()[Symbol.asyncIterator]();
  assert.deepEqual(await late.next(), { value: undefined, done: true });
});

test('a dropped connection makes the loop throw', async t => {
  const f = await fixture(t);
  const iterator = f.control.approvals.requests()[Symbol.asyncIterator]();
  const socket = await connectedSocket(f);
  const waiting = iterator.next();
  socket.terminate();
  await assert.rejects(waiting, /closed/);
});

test('a malformed approval request drops the connection', async t => {
  const f = await fixture(t);
  const iterator = f.control.approvals.requests()[Symbol.asyncIterator]();
  const socket = await connectedSocket(f);
  const waiting = iterator.next();
  push(socket, { ...folder, detail: { path: '/x' } });
  await assert.rejects(waiting, /Invalid folder approval request/);

  const again = f.control.approvals.requests()[Symbol.asyncIterator]();
  const socket2 = await connectedSocket(f);
  const waiting2 = again.next();
  push(socket2, { id: 'nope' });
  await assert.rejects(waiting2, /Invalid approval request/);
});

test('a bad admin token fails the loop and the calls', async t => {
  const server = await startServer(t, () => {}, { path: '/control' });
  const control = new AgentdControl({ url: server.url, adminToken: 'wrong' });
  t.after(() => control.close());
  const iterator = control.approvals.requests()[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), /HTTP 401/);
  await assert.rejects(control.approvals.subscribe(), /HTTP 401/);
});

test('the admin token never appears when the control client is logged or serialised', t => {
  const token = 'super-secret-admin-token';
  const control = new AgentdControl({ url: 'http://127.0.0.1:1', adminToken: token });
  t.after(() => control.close());
  for (const dump of [util.inspect(control, { depth: 20 }), JSON.stringify(control), String(control)]) {
    assert.ok(!dump.includes(token), dump);
  }
  assert.throws(() => new AgentdControl({ timeoutMs: -1 }), RangeError);
  new AgentdControl({ timeoutMs: 0 }).close();
  assert.throws(() => new AgentdControl({ url: 'file:///x' }), TypeError);
});
