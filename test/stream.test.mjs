import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentdClient } from '../dist/index.js';
import { startServer, reply, fail, delta, TOKEN } from './helpers/server.mjs';

async function fixture(t, handler) {
  const server = await startServer(t, handler);
  const client = new AgentdClient({ url: server.url, token: TOKEN, timeoutMs: 1000 });
  t.after(() => client.close());
  return { ...server, client };
}

const outcome = { text: 'hello', provider: 'p', model: 'm', stop_reason: 'end_turn' };

test('yields deltas in order, then result resolves after the final envelope', async t => {
  const f = await fixture(t, (socket, req) => {
    delta(socket, req.id + 99, { type: 'text_delta', text: 'stray' });
    delta(socket, req.id, { type: 'text_delta', text: 'hel' });
    delta(socket, req.id, { type: 'text_delta', text: 'lo' });
    delta(socket, req.id, { type: 'tool_call', name: 'git.diff' });
    delta(socket, req.id, { type: 'turn_end' });
    reply(socket, req, outcome);
  });
  const stream = f.client.runners.stream({ name: 'r', prompt: 'hi' });
  const seen = [];
  for await (const d of stream) seen.push(d);
  assert.deepEqual(seen, [
    { type: 'text_delta', text: 'hel' },
    { type: 'text_delta', text: 'lo' },
    { type: 'tool_call', name: 'git.diff' },
    { type: 'turn_end' },
  ]);
  assert.deepEqual(await stream.result, outcome);
  assert.equal(f.requests[0].params.stream, true);
  assert.equal(f.requests[0].params.name, 'r');
});

test('deltas buffer until consumed', async t => {
  const f = await fixture(t, (socket, req) => {
    delta(socket, req.id, { type: 'text_delta', text: 'a' });
    delta(socket, req.id, { type: 'text_delta', text: 'b' });
    reply(socket, req, outcome);
  });
  const stream = f.client.runners.stream({ name: 'r', prompt: 'hi' });
  await stream.result;
  const seen = [];
  for await (const d of stream) seen.push(d.text);
  assert.deepEqual(seen, ['a', 'b']);
});

test('an error after partial deltas rejects result and throws from the iterator', async t => {
  const f = await fixture(t, (socket, req) => {
    delta(socket, req.id, { type: 'text_delta', text: 'partial' });
    fail(socket, req, { code: 'provider_upstream', error: 'Provider failed', provider_status: 502 });
  });
  const stream = f.client.runners.stream({ name: 'r', prompt: 'hi' });
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const d of stream) seen.push(d);
    })(),
    /Provider failed/,
  );
  assert.equal(seen.length, 1);
  await assert.rejects(stream.result, e => e.code === 'provider_upstream' && e.providerStatus === 502);
});

test('disconnect mid-stream rejects', async t => {
  const f = await fixture(t, (socket, req) => {
    delta(socket, req.id, { type: 'text_delta', text: 'partial' });
    socket.close();
  });
  const stream = f.client.runners.stream({ name: 'r', prompt: 'hi' });
  await assert.rejects(
    (async () => {
      for await (const _delta of stream) void _delta;
    })(),
    /closed before response/,
  );
  await assert.rejects(stream.result, /closed before response/);
});

test('breaking out of the loop cancels the run', async t => {
  let cancelId;
  const cancelled = new Promise(resolve => {
    cancelId = resolve;
  });
  const f = await fixture(t, (socket, req) => {
    if (req.method === 'runners.cancel') {
      cancelId(req.params.id);
      reply(socket, req, { cancelled: true });
      return;
    }
    delta(socket, req.id, { type: 'text_delta', text: 'a' });
    delta(socket, req.id, { type: 'text_delta', text: 'b' });
  });
  const stream = f.client.runners.stream({ name: 'r', prompt: 'hi' });
  for await (const _delta of stream) {
    void _delta;
    break;
  }
  assert.equal(await cancelled, f.requests[0].id);
  await assert.rejects(stream.result, { name: 'AbortError' });
});

test('abort signal and timeout apply to streams', async t => {
  const f = await fixture(t, (socket, req) => {
    if (req.method === 'runners.cancel') reply(socket, req, { cancelled: true });
  });
  const controller = new AbortController();
  const aborted = f.client.runners.stream({ name: 'r', prompt: 'hi' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted.result, { name: 'AbortError' });
  const timed = f.client.runners.stream({ name: 'r', prompt: 'hi' }, { timeoutMs: 30 });
  await assert.rejects(timed.result, /timed out/);
});
