import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export const TOKEN = 'test-token';

export const reply = (socket, request, result) =>
  socket.send(JSON.stringify({ id: request.id, ok: true, result }));

export const fail = (socket, request, frame) =>
  socket.send(JSON.stringify({ id: request.id, ok: false, ...frame }));

export const delta = (socket, id, delta) => socket.send(JSON.stringify({ event: 'runner.delta', id, delta }));

/**
 * Scripted mock daemon. `handler(socket, request)` receives each parsed request.
 * Rejects handshakes without the expected bearer token and asserts the upgrade path.
 */
export async function startServer(t, handler = () => {}, options = {}) {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_100_000 });
  const requests = [];
  let connections = 0;
  http.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    assert.equal(request.url, options.path ?? '/ws');
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', socket => {
    connections++;
    socket.on('message', text => {
      const request = JSON.parse(text.toString());
      requests.push(request);
      handler(socket, request);
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => http.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${http.address().port}${options.base ?? ''}`,
    requests,
    connections: () => connections,
    clients: wss.clients,
  };
}
