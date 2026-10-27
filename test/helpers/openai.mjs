import { once } from 'node:events';
import { createServer } from 'node:http';

/**
 * A stand-in for an OpenAI-compatible chat completions endpoint, so a real daemon can run a runner
 * without any real model provider. `reply(body)` decides each turn:
 *
 * - `{ text }` answers with text,
 * - `{ tool, args }` asks for the action named `tool` (its dotted name; we map it to the wire alias),
 * - `{ hang: true }` never answers, to exercise cancellation and deadlines.
 *
 * Streaming and non-streaming requests both work. Every turn reports usage.
 */
export async function startFakeOpenAI(t, reply) {
  const requests = [];
  const open = new Set();
  const server = createServer((req, res) => {
    // A broken script or request should fail the run with a clear upstream error, not crash the test process.
    respond(req, res).catch(error => {
      if (res.headersSent) return res.destroy(error);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: `Fake model endpoint failed: ${error.message}` } }));
    });
  });
  const respond = async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const turn = reply(body, requests.length);
    if (turn.hang) {
      open.add(res);
      res.on('close', () => open.delete(res));
      return;
    }
    const usage = { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } };
    const call = turn.tool && {
      id: `call_${requests.length}`,
      type: 'function',
      function: { name: wireName(body, turn.tool), arguments: JSON.stringify(turn.args ?? {}) },
    };
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: call ? 'tool_calls' : 'stop',
              message: {
                role: 'assistant',
                content: turn.text ?? null,
                tool_calls: call ? [call] : undefined,
              },
            },
          ],
          usage,
        }),
      );
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const chunk = (delta, finish_reason = null) =>
      send({ model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    if (call) {
      chunk({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: call.function }] });
      chunk({}, 'tool_calls');
    } else {
      const text = turn.text ?? '';
      const mid = Math.floor(text.length / 2);
      chunk({ role: 'assistant', content: text.slice(0, mid) });
      chunk({ content: text.slice(mid) });
      chunk({}, 'stop');
    }
    send({ model: body.model, choices: [], usage });
    res.end('data: [DONE]\n\n');
  };
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const res of open) res.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

/** The daemon renames dotted actions to `<readable>_<hash>` on the wire; find the one it offered. */
function wireName(body, action) {
  const readable = action.replace(/[^A-Za-z0-9_]/g, '_');
  const names = (body.tools ?? []).map(tool => tool.function.name);
  const match = names.find(name => name === action || name.startsWith(`${readable}_`));
  if (!match) throw new Error(`The daemon did not offer \`${action}\`; it offered ${names.join(', ')}`);
  return match;
}
