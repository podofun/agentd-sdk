# agentd-sdk

Connect your application to [agent.d](https://github.com/podofun/agent.d) to run tasks and build conversations with your agents. The SDK gives you a TypeScript API for calling actions, running agents, streaming replies and managing conversation history.

You will mainly work with three things: an **action** performs a specific operation, such as checking a Git repository; a **runner** uses a model to respond to a prompt and can call permitted actions along the way; a **session** keeps the conversation available for later replies.

## Installation

You need Node.js 22 or newer and a running agent.d daemon that supports the `0.10.0-alpha` API.

```bash
npm install @podofun/agentd-sdk@alpha
```

## Your first request

Start by checking which actions and runners your daemon has loaded. Set `AGENTD_URL` to its address and `AGENTD_TOKEN` to the token your application uses to connect. The example defaults to a local daemon at `http://127.0.0.1:7777`.

Save the following code as `example.mjs`, then run `node example.mjs`. You can also use it in a TypeScript project.

```ts
import { AgentdClient, isAgentdError } from '@podofun/agentd-sdk';

const client = new AgentdClient({
  url: process.env.AGENTD_URL ?? 'http://127.0.0.1:7777',
  token: process.env.AGENTD_TOKEN,
});

try {
  const actions = await client.tools.list();
  const runners = await client.runners.list();
  console.log('Available actions:', actions);
  console.log('Available runners:', runners);
} catch (error) {
  if (isAgentdError(error)) {
    console.error(error.code, error.message);
    if (error.tip) console.error(error.tip);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  client.close();
}
```

The client connects when you make your first request. For a short script, close it in `finally` as shown above. For a server application, reuse the client across requests and close it when the application shuts down. If you need to check the connection during startup, call `await client.connect()` first. Create a new client if you need to connect again after `close()`.

To try the examples below, replace the contents of this script's `try` block. Use action and runner names from your daemon. The examples assume that `git.status` and a runner named `support` are registered, and that `support` has a configured model provider and the required grant in `grants.toml`.

## Call an action

Call an action when you know which operation you want to perform. For example, a registered `git.status` action can report the state of a repository:

```ts
const response = await client.actions.call('git.status');
console.log(response.result);
console.log(`Completed in ${response.duration_ms} ms`);
```

The handler's return value is in `response.result`; `duration_ms` tells you how long it took. If the action takes arguments, pass them as the second parameter: `client.actions.call('notes.save', { text: 'Check the release notes' })`. The action must be registered and have the permissions it needs in the daemon's `grants.toml`.

## Ask a runner

Give a runner a prompt and await its answer with `runners.run`. The runner uses its configured model, instructions and permitted actions to handle the request.

```ts
const reply = await client.runners.run({
  name: 'support',
  prompt: 'Explain how to reset my password.',
});

console.log(reply.text);
```

Read the answer from `reply.text`. The response also identifies the `provider` and `model`, and includes a `stop_reason`. If every model call reports token usage, `reply.usage` contains the totals.

A call like this has no conversation history attached. For follow-up questions, use a session or provide the earlier messages yourself through `messages`.

## Continue a conversation

A session lets a runner use earlier messages when it answers a follow-up question. Your application supplies a stable label, such as a user id and chat id, and `sessions.open` finds or creates the conversation.

Pass the returned `id` as `session_id` with each prompt. In this example, the second request receives the first exchange as part of its history:

```ts
const userId = 'alice'; // In your app, use the authenticated user's id.
const chatId = '42';
const session = await client.sessions.open(`user-${userId}:chat-${chatId}`, {
  user: userId,
});

await client.runners.run({
  name: 'support',
  prompt: 'My name is Alice.',
  session_id: session.id,
  user: userId,
});

const reply = await client.runners.run({
  name: 'support',
  prompt: 'What is my name?',
  session_id: session.id,
  user: userId,
});
console.log(reply.text);

const saved = await client.sessions.get({ id: session.id, user: userId });
console.log(saved.turns);
```

Use `sessions.get` to read the saved conversation. Its `turns` array contains the messages in order, and the history remains available after a daemon restart. As the conversation grows, the daemon can replace older messages with a summary; the runner's compaction settings control this behavior. The stored history is therefore not a permanent copy of every original message.

Send one prompt at a time for each session. Starting a second run before the first finishes returns `session_busy`. When using `session_id`, include a `prompt` and leave out `messages`, because the daemon loads the history for you.

If the model run fails, the new exchange is not saved. A summary saved before that failure remains part of the history.

### Find and manage sessions

| Call                                        | What it does                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `client.sessions.create({ label, user })`   | Create a session. An existing label produces `session_label_taken`. Both fields are optional.                            |
| `client.sessions.open(label, { user })`     | Find or create a session with that label.                                                                                |
| `client.sessions.get({ id, user })`         | Get its metadata and stored messages. Use `{ label, user }` to look it up by label instead.                              |
| `client.sessions.list({ user, limit: 50 })` | List visible sessions, newest first. The default limit is 50; the maximum is 500.                                        |
| `client.sessions.delete(id, { user })`      | Delete the session and its messages. Returns `{ deleted: true }`, or `{ deleted: false }` if no visible session matches. |

The `user` field is optional, but if you set it when creating a session, you must send the same value when using that session later. The optional `runner` field on `create` and `open` is metadata; it does not select or restrict the runner used for later calls.

### Session ownership

The application's token identifies an interface in the daemon. Sessions belong to that interface, so give applications separate interface tokens when their conversations must stay separate.

Within an interface, `user` restricts a session to the person identified by your backend. Authenticate the person before passing their id, and send the same `user` with every request for that session. The daemon trusts this value, so take it from your authenticated application context rather than directly from browser input. Keep the SDK and its token on your server.

Without `user`, any caller from the same interface can use the session. Labels are also unique across the entire interface, so include a user identifier in the label when each person needs their own conversation.

`session_id` selects stored conversation history. The separate `session` parameter is a caller identity used by handlers; setting it does not save or load a conversation.

## Stream an answer

For an interface that displays an answer as it is generated, use `runners.stream`. Each iteration gives you an update: a piece of text, an action call or the end of a model turn. The method accepts the same inputs as `runners.run`, including `session_id` and `user` for an existing conversation.

```ts
const stream = client.runners.stream({
  name: 'support',
  prompt: 'Explain how to reset my password.',
});

for await (const delta of stream) {
  if (delta.type === 'text_delta') process.stdout.write(delta.text);
  if (delta.type === 'tool_call') console.error(`Using action: ${delta.name}`);
}

const reply = await stream.result;
console.log('\nCompleted with:', reply.model);
```

After reading the updates, await `stream.result` to get the completed response. Treat streamed text as provisional until the run succeeds, because an error can occur after some text has arrived. If you leave the loop early with `break`, the SDK asks the daemon to cancel the run.

## Timeouts and cancellation

Pass request options after the call parameters to control how long your application waits. This example uses an abort signal to stop waiting after 30 seconds:

```ts
const reply = await client.runners.run(
  { name: 'support', prompt: 'Explain how to reset my password.' },
  { signal: AbortSignal.timeout(30_000) },
);
console.log(reply.text);
```

For a Cancel button or a disconnected request, create an `AbortController`, pass its `signal` in the same position and call `controller.abort()` when the work is no longer needed.

| Setting                                       | What it controls                                                           | Default    |
| --------------------------------------------- | -------------------------------------------------------------------------- | ---------- |
| `connectTimeoutMs` in `new AgentdClient(...)` | Time allowed to establish the connection.                                  | 30 seconds |
| `timeoutMs` on the client or a call           | Time the client waits for a response after connecting.                     | 11 minutes |
| `timeout_ms` in runner parameters             | Time the daemon allows the runner to work. Accepts 1–600,000 milliseconds. | 2 minutes  |

Client and daemon deadlines serve different purposes: `timeoutMs` controls how long your application waits after connecting, while `timeout_ms` controls how long the daemon allows a runner to work. An abort signal can also stop waiting during connection setup.

When your application stops waiting for a runner, the SDK asks the daemon to cancel it. For a direct action call, the action can continue after your application stops waiting. Neither case undoes work that has already completed.

Session methods also accept request options. For `open` and `delete`, they are the third argument: `client.sessions.open(label, { user }, { signal })` and `client.sessions.delete(id, { user }, { signal })`.

## Handle errors

The first example catches errors with `isAgentdError`. When the daemon reports a failure, the error includes a `code` for application logic, a readable `message` and, when available, a `tip` explaining what to check.

For example, `isAgentdError(error, 'session_busy')` identifies a conversation that already has a run in progress. Wait for that run before trying again. If you receive `session_not_found`, check the session id, application token and user id; a session outside the caller's scope is treated as missing.

A `denied` error means the daemon's grants do not allow the operation. A `bad_params` error means the request needs to be corrected. Provider errors can include `providerStatus` and `retryAfterMs`, which help you decide whether to fix the provider configuration or try again later.

Connection failures, client timeouts and local cancellation are ordinary errors rather than `AgentdError`. After a dropped connection, the next request can reconnect, but failed calls are not retried automatically. Before repeating an operation that changes data, check whether it completed; a lost response does not mean the operation failed.

## Explore your daemon

| Call                           | Result                                                          |
| ------------------------------ | --------------------------------------------------------------- |
| `client.health()`              | `'ok'` when the daemon responds.                                |
| `client.tools.list()`          | Registered action names.                                        |
| `client.runners.list()`        | Runner names, models, skills and allowed actions.               |
| `client.runners.inspect(name)` | A runner's configuration, including its composed system prompt. |
| `client.skills.list()`         | Available skills and their descriptions.                        |
| `client.skills.inspect(name)`  | A skill's definition and prompt text.                           |
| `client.services.list()`       | Background services and their current state.                    |

For deployment health checks, `probeHealth(url)` reports whether the daemon is alive and `probeReady(url)` reports whether it is accepting work. Import either function from the package and await its result. They require no token and reject if the daemon cannot be reached; `probeReady` returns `false` while the daemon is shutting down.
