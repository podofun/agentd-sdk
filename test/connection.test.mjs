import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Connection } from '../dist/connection.js';
import { AgentdError } from '../dist/errors.js';
import { resolveWsUrl } from '../dist/url.js';
import { startServer, reply, fail, delta, TOKEN } from './helpers/server.mjs';

function connection(url, overrides = {}) {
  return new Connection({
    url: resolveWsUrl(url),
    token: TOKEN,
    connectTimeoutMs: 1000,
    timeoutMs: 1000,
    ...overrides,
  });
}

async function fixture(t, handler, options) {
  const server = await startServer(t, handler, options);
  const conn = connection(server.url, options?.overrides);
  t.after(() => conn.close());
  return { ...server, conn };
}

test('multiplexes out-of-order replies over one connection with unique ids', async t => {
  const held = [];
  const f = await fixture(
    t,
    (socket, req) => {
      held.push(req);
      if (held.length === 3) for (const r of held.reverse()) reply(socket, r, r.method);
    },
    { path: '/gateway/ws', base: '/gateway' },
  );
  const results = await Promise.all(['a', 'b', 'c'].map(m => f.conn.request(m, {})));
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(f.connections(), 1);
  const ids = f.requests.map(r => r.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id, i) => Number.isSafeInteger(id) && id > 0 && (i === 0 || id > ids[i - 1])));
});

test('daemon errors become AgentdError', async t => {
  const f = await fixture(t, (socket, req) =>
    fail(socket, req, { code: 'denied', error: 'Denied', tip: 'grants', result: { duration_ms: 3 } }),
  );
  await assert.rejects(f.conn.request('actions.call', { name: 'x' }), e => {
    assert.ok(e instanceof AgentdError);
    assert.equal(e.code, 'denied');
    assert.equal(e.durationMs, 3);
    return true;
  });
});

test('in-flight cap and payload limit are enforced locally', async t => {
  const f = await fixture(t, () => {});
  await f.conn.connect();
  const pending = Array.from({ length: 32 }, () => f.conn.request('wait', {}));
  const settled = Promise.allSettled(pending);
  await assert.rejects(f.conn.request('wait', {}), /32 in-flight/);
  await assert.rejects(f.conn.request('big', { blob: 'x'.repeat(1_100_000) }), RangeError);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(f.requests.length, 32);
  f.conn.close();
  assert.ok((await settled).every(r => r.status === 'rejected'));
});

test('malformed frames reject all pending requests', async t => {
  for (const frame of [
    'bad json',
    '{"ok":true,"result":1}',
    '{"id":1,"ok":true}',
    '{"id":1,"ok":false}',
    '{"id":1,"event":"runner.delta","delta":{"type":"nope"}}',
  ]) {
    const f = await fixture(t, socket => socket.send(frame));
    const results = await Promise.allSettled([f.conn.request('a', {}), f.conn.request('b', {})]);
    assert.ok(
      results.every(r => r.status === 'rejected'),
      frame,
    );
  }
});

test('frames for unknown ids are ignored', async t => {
  const f = await fixture(t, (socket, req) => {
    socket.send(JSON.stringify({ id: req.id + 1000, ok: true, result: 'stray' }));
    delta(socket, req.id + 1000, { type: 'turn_end' });
    reply(socket, req, 'real');
  });
  assert.equal(await f.conn.request('x', {}), 'real');
});

test('server drop rejects pending work and the next request reconnects', async t => {
  const f = await fixture(t, (socket, req) =>
    req.method === 'drop' ? socket.terminate() : reply(socket, req, 'ok'),
  );
  await assert.rejects(f.conn.request('drop', {}), /closed/);
  assert.equal(await f.conn.request('health', {}), 'ok');
  assert.equal(f.connections(), 2);
});

test('abort on a runner request sends runners.cancel and leaves other calls alone', async t => {
  let seen;
  const cancelled = new Promise(resolve => {
    seen = resolve;
  });
  const controller = new AbortController();
  const f = await fixture(t, (socket, req) => {
    if (req.method === 'runners.run') controller.abort();
    else if (req.method === 'runners.cancel') {
      seen(req.params.id);
      reply(socket, req, { cancelled: true });
    } else reply(socket, req, 'ok');
  });
  const other = f.conn.request('health', {});
  await assert.rejects(
    f.conn.request('runners.run', { name: 'r' }, { signal: controller.signal, runner: true }),
    { name: 'AbortError' },
  );
  assert.equal(await cancelled, f.requests.find(r => r.method === 'runners.run').id);
  assert.equal(await other, 'ok');
  assert.equal(f.connections(), 1);
});

test('timeout on a runner request sends runners.cancel; non-runner timeouts do not', async t => {
  const cancels = [];
  const f = await fixture(t, (socket, req) => {
    if (req.method === 'runners.cancel') {
      cancels.push(req.params.id);
      reply(socket, req, { cancelled: true });
    }
  });
  await assert.rejects(
    f.conn.request('runners.run', {}, { timeoutMs: 30, runner: true }),
    /timed out after 30 ms/,
  );
  await assert.rejects(f.conn.request('actions.call', {}, { timeoutMs: 30 }), /timed out/);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(cancels, [f.requests[0].id]);
});

test('delta frames reach onDelta and a throwing callback cancels the runner', async t => {
  const deltas = [];
  let cancelled = false;
  const f = await fixture(t, (socket, req) => {
    if (req.method === 'runners.cancel') {
      cancelled = true;
      reply(socket, req, { cancelled: true });
      return;
    }
    delta(socket, req.id, { type: 'text_delta', text: 'hi' });
    delta(socket, req.id, { type: 'tool_call', name: 'git.diff' });
    delta(socket, req.id, { type: 'turn_end' });
    reply(socket, req, { text: 'hi' });
  });
  const result = await f.conn.request('runners.run', {}, { runner: true, onDelta: d => deltas.push(d) });
  assert.deepEqual(result, { text: 'hi' });
  assert.deepEqual(
    deltas.map(d => d.type),
    ['text_delta', 'tool_call', 'turn_end'],
  );
  await assert.rejects(
    f.conn.request(
      'runners.run',
      {},
      {
        runner: true,
        onDelta() {
          throw new Error('consumer failed');
        },
      },
    ),
    /consumer failed/,
  );
  await new Promise(r => setTimeout(r, 20));
  assert.ok(cancelled);
});

test('handshake rejection is explicit and close rejects pending and future work', async t => {
  const f = await fixture(t, () => {});
  const wrong = connection(f.url, { token: 'nope' });
  t.after(() => wrong.close());
  await assert.rejects(wrong.request('health', {}), /HTTP 401/);
  await f.conn.connect();
  const pending = f.conn.request('health', {});
  f.conn.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(f.conn.request('health', {}), /closed/);
});

test('pre-aborted requests, bad timeouts and unserializable params never touch the socket', async t => {
  const f = await fixture(t, () => {});
  await assert.rejects(f.conn.request('health', {}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(f.conn.request('health', {}, { timeoutMs: 0 }), RangeError);
  await assert.rejects(f.conn.request('health', { big: 1n }), TypeError);
  await assert.rejects(f.conn.request('', {}), TypeError);
  assert.equal(f.connections(), 0);
});

test('connect timeout, abort during handshake and close during handshake all settle', async t => {
  const http = createServer();
  const sockets = new Set();
  http.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  http.on('upgrade', () => {});
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise(r => http.close(r));
  });
  for (const mode of ['timeout', 'abort', 'close']) {
    const conn = connection(`http://127.0.0.1:${http.address().port}`, { connectTimeoutMs: 50 });
    const controller = new AbortController();
    const pending = conn.request('health', {}, { signal: controller.signal });
    if (mode === 'abort') controller.abort();
    if (mode === 'close') conn.close();
    await assert.rejects(
      pending,
      mode === 'abort' ? { name: 'AbortError' } : mode === 'close' ? /closed/ : /connection failed/,
    );
    conn.close();
  }
});
