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

test('tool results stream through with their input, output, error and changed files', async t => {
  const results = [
    { type: 'tool_call', name: 'demo.token' },
    {
      type: 'tool_result',
      name: 'demo.token',
      input: { scope: 'repo' },
      output: { token: '<secret gh_token>' },
    },
    { type: 'tool_result', name: 'demo.fail', input: {}, error: 'the action failed' },
    {
      type: 'tool_result',
      name: 'shell.run',
      input: { command: ['cargo', 'fmt'] },
      output: { exit_code: 0 },
      changes: [
        {
          path: 'src/a.rs',
          operation: 'modified',
          revision: 2,
          diff: '@@ -1 +1 @@\n-a\n+b\n',
          binary: false,
          added: 1,
          removed: 1,
        },
      ],
      more: 3,
    },
    { type: 'turn_end' },
  ];
  const f = await fixture(t, (socket, req) => {
    for (const d of results) delta(socket, req.id, d);
    reply(socket, req, outcome);
  });
  const stream = f.client.runners.stream({ name: 'r', prompt: 'hi' });
  const seen = [];
  for await (const d of stream) seen.push(d);
  assert.deepEqual(seen, results);
  assert.deepEqual(await stream.result, outcome);
});

test('delta types this SDK does not know are skipped without dropping the connection', async t => {
  const f = await fixture(t, (socket, req) => {
    delta(socket, req.id, { type: 'thinking_delta', text: 'hmm' });
    delta(socket, req.id, { type: 'text_delta', text: 'ok' });
    reply(socket, req, outcome);
  });
  const stream = f.client.runners.stream({ name: 'r', prompt: 'hi' });
  const seen = [];
  for await (const d of stream) seen.push(d);
  assert.deepEqual(seen, [{ type: 'text_delta', text: 'ok' }]);
  // The same socket keeps serving requests afterwards.
  assert.deepEqual(await f.client.health(), outcome);
  assert.equal(f.connections(), 1);
});

test('stream params carry the approval setting and session id', async t => {
  const f = await fixture(t, (socket, req) => reply(socket, req, { ...outcome, session_id: 's-1' }));
  const stream = f.client.runners.stream({
    name: 'r',
    prompt: 'hi',
    session_id: 's-1',
    approval: 'nobody',
  });
  assert.equal((await stream.result).session_id, 's-1');
  assert.deepEqual(f.requests[0].params, {
    name: 'r',
    prompt: 'hi',
    session_id: 's-1',
    approval: 'nobody',
    stream: true,
  });
});
