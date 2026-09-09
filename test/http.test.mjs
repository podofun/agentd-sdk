import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { probeHealth, probeReady } from '../dist/index.js';

async function server(t, handler) {
  const http = createServer(handler);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => new Promise(r => http.close(r)));
  return `http://127.0.0.1:${http.address().port}`;
}

test('health and ready hit the daemon HTTP routes without auth', async t => {
  const paths = [];
  const url = await server(t, (req, res) => {
    paths.push([req.url, req.headers.authorization]);
    res.statusCode = req.url === '/ready' ? 503 : 200;
    res.end(req.url === '/ready' ? 'daemon is draining' : 'ok');
  });
  assert.equal(await probeHealth(url), true);
  assert.equal(await probeReady(url), false);
  assert.equal(await probeHealth(`${url}/prefix/ws`), true);
  assert.deepEqual(paths, [
    ['/health', undefined],
    ['/ready', undefined],
    ['/prefix/health', undefined],
  ]);
});

test('unexpected statuses and network failures throw', async t => {
  const url = await server(t, (_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await assert.rejects(probeHealth(url), /HTTP 404/);
  await assert.rejects(probeHealth('http://127.0.0.1:1'), TypeError);
  await assert.rejects(probeHealth(url, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
