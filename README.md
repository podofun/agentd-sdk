# agentd-sdk

Standalone TypeScript client for the [agent.d](https://github.com/podofun/agent.d) WebSocket API. It talks to a daemon over `/ws` and has no dependency on `agentd`, `agentctl`, Cargo, or local daemon files, so your app and the daemon can live on different hosts or containers.

Requires Node.js 22 or newer. Targets the agent.d `0.8.3-alpha` protocol. The package is `@podofun/agentd-sdk` and is not published yet; until then run `npm install && npm pack` here and install the tarball.

## Quick start

```ts
import { AgentdClient, isAgentdError } from '@podofun/agentd-sdk';

const client = new AgentdClient({
  url: 'https://agentd.example.com', // or http://agentd:7777 inside Docker
  token: process.env.AGENTD_TOKEN,
});

try {
  await client.health(); // 'ok'
  const tools = await client.tools.list(); // ['git.diff', 'git.status', ...]
  const status = await client.actions.call('git.status'); // { result, duration_ms }
  const review = await client.runners.run({ name: 'backend_reviewer', prompt: 'Review my changes' });
  console.log(tools, status.result, review.text);
} catch (error) {
  if (isAgentdError(error)) console.error(error.code, error.message, error.tip);
  else throw error;
} finally {
  client.close();
}
```

The daemon is started and configured separately. Actions, runners, skills, and services come from its Lua configuration, and grants decide what a call may do.

## API

Every namespace mirrors a protocol method. Results keep the daemon's wire field names.

| Call                                      | Protocol method                   | Result                    |
| ----------------------------------------- | --------------------------------- | ------------------------- |
| `client.health()`                         | `health`                          | `'ok'`                    |
| `client.tools.list()`                     | `tools.list`                      | `string[]`                |
| `client.actions.call(name, args?, opts?)` | `actions.call`                    | `{ result, duration_ms }` |
| `client.runners.list()`                   | `runners.list`                    | `RunnerSummary[]`         |
| `client.runners.inspect(name)`            | `runners.inspect`                 | `RunnerComposition`       |
| `client.runners.run(params, opts?)`       | `runners.run`                     | `RunnerOutcome`           |
| `client.runners.stream(params, opts?)`    | `runners.run` with `stream: true` | `RunnerStream`            |
| `client.skills.list()`                    | `skills.list`                     | `SkillSummary[]`          |
| `client.skills.inspect(name)`             | `skills.inspect`                  | `SkillDef`                |
| `client.services.list()`                  | `services.list`                   | `ServiceStatus[]`         |
| `client.request(method, params?, opts?)`  | any                               | envelope `result`         |

`opts` accepts `signal` and `timeoutMs` everywhere. `actions.call` also accepts `session` and `user` to carry a bridged caller identity. `runners.run` takes the wire parameters directly: `name`, `prompt`, `messages`, `system`, `model`, `max_tokens`, `timeout_ms`, `session`, `user`. Fields set to `undefined` are stripped before sending because the daemon rejects unknown keys.

`connect()` opens the socket eagerly; otherwise the first request connects. `close()` terminates the socket and rejects in-flight work; create a new client afterwards.

## Streaming

```ts
const stream = client.runners.stream({ name: 'backend_reviewer', prompt: 'Review the diff' });
for await (const delta of stream) {
  if (delta.type === 'text_delta') process.stdout.write(delta.text);
  else if (delta.type === 'tool_call') console.error(`\n[tool ${delta.name}]`);
}
const outcome = await stream.result; // complete text, provider, model, stop_reason, usage
```

Deltas are provisional. Only `stream.result` is the finished answer; a provider error, deadline, or cancellation can still fail the run after text has streamed. Breaking out of the loop cancels the run.

## Cancellation and timeouts

Pass an `AbortSignal` or `timeoutMs` to any call. On abort or timeout the promise rejects immediately and, for runner calls, the client sends `runners.cancel` on the same connection. Cancellation is best effort and does not undo tools that already ran. Action calls have no server-side cancel; aborting only stops waiting.

Two deadlines apply to runners: the client-side `timeoutMs` (default 660000 ms, counted after the connection is open) and the daemon's `timeout_ms` run parameter (1 to 600000 ms, default 120000). The handshake has its own `connectTimeoutMs` (default 30000).

## Errors

Daemon failures reject with `AgentdError`, which carries `code`, `tip`, `trace` (Lua frames), `providerStatus`, `retryAfterMs`, and `durationMs` for action failures. `isAgentdError(error, code?)` narrows by code. Codes are typed as `ErrorCode`: `bad_params`, `busy`, `cancelled`, `denied`, `needs_confirmation`, `not_found`, `runner_not_found`, `unknown_skill`, `no_provider`, `provider_misconfigured`, `provider_upstream`, `timeout`, `slow_consumer`, `lua_error`, `invocation_failed`, `compose_failed`, `unknown_method`, `invalid_envelope`, `serialize_failed`.

Connection, handshake, timeout, and abort failures are plain `Error` or `AbortError`, never `AgentdError`.

## Connection details

- `http`/`https` URLs become `ws`/`wss` and `/ws` is appended unless already present. `https://example.com/agentd` becomes `wss://example.com/agentd/ws`.
- The token is sent as an `Authorization: Bearer` header on the handshake. Nothing is read from the environment or disk. Redirects are not followed.
- One connection multiplexes up to 32 in-flight requests, matching the daemon's cap; more reject locally. Request ids are never reused.
- Messages are capped at 1,100,000 bytes in both directions, the daemon's limit.
- A dropped socket rejects everything in flight. Nothing is retried or replayed; the next request opens a new connection, which gets a new default daemon session. Pass `session` explicitly to group calls.
- Conversation history is caller-owned. `session` and `user` describe the caller; they do not store or restore messages.

## HTTP probes

```ts
import { probeHealth, probeReady } from '@podofun/agentd-sdk';
await probeHealth('http://agentd:7777'); // true while the process is alive
await probeReady('http://agentd:7777'); // false (503) while the daemon drains
```

Both routes need no token. Use `probeReady` for container readiness checks.

## Not covered

The `/control` approvals plane, signed webhooks, browser transports, and automatic reconnection are out of scope for this package.

## Develop

```bash
npm ci
npm test              # builds, then runs node --test against a mock daemon
npm pack --dry-run
AGENTD_TEST_URL=http://127.0.0.1:7777 AGENTD_TEST_TOKEN=... npm test   # also runs the live test
```

Publish with `npm publish --access public --tag alpha` after bumping the version; use `latest` for stable releases. Publishing the SDK does not publish or install the daemon.
