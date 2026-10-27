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

The token decides who your application is to the daemon. The daemon's own token connects you as the interface `ws`. A token from an `[interfaces.<name>]` entry in the daemon's `config.toml` connects you as that interface, with its own grants and its own sessions, which is what a bot or a web app should use. The admin token makes an admin connection, which may relax a run's approval setting and keeps its sessions apart from everyone else's; keep that one for tools you run yourself.

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

| Call                                                  | What it does                                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.sessions.create({ label, user })`             | Create a session. An existing label produces `session_label_taken`. Both fields are optional.                                                                         |
| `client.sessions.open(label, { user })`               | Find or create a session with that label.                                                                                                                             |
| `client.sessions.get({ id, user })`                   | Get its metadata and stored messages. Use `{ label, user }` to look it up by label instead.                                                                           |
| `client.sessions.list({ user, limit: 50 })`           | List visible sessions, newest first. The default limit is 50; the maximum is 500.                                                                                     |
| `client.sessions.rename(id, label, { user })`         | Give the session a new label, or pass `null` to clear it. A label another session already uses produces `session_label_taken`.                                        |
| `client.sessions.setApproval(id, approval, { user })` | Change who answers questions for the session's runs, or pass `null` to clear it. See [Decide who answers approval questions](#decide-who-answers-approval-questions). |
| `client.sessions.delete(id, { user })`                | Delete the session and its messages. Returns `{ deleted: true }`, or `{ deleted: false }` if no visible session matches.                                              |

The `user` field is optional, but if you set it when creating a session, you must send the same value when using that session later. The optional `runner` field on `create` and `open` is metadata; it does not select or restrict the runner used for later calls.

Every session's metadata keeps a running total of the tokens its runs have used, in `usage`, alongside `turn_count` and the number of `compactions` so far. That makes it easy to show a conversation's cost or cut it off past a budget.

A run in a session keeps going until it finishes. It has no default deadline and no limit on how many model turns it takes, so a long task can see itself through. The SDK waits for it too: the client's default `timeoutMs` does not apply to a session run without `timeout_ms`. Pass `timeout_ms` when you want a deadline anyway, pass `timeoutMs` in the call options to stop waiting after a while, or cancel the run as described in [Timeouts and cancellation](#timeouts-and-cancellation).

### Work in a folder

When your application runs on the same machine as the daemon, a session can work in a folder of your choosing, so its runs read and write files relative to that project. Pass an absolute path as `cwd` when you create the session:

```ts
const session = await client.sessions.create({ label: 'repo-chat', cwd: '/home/alice/code/shop' });
console.log(session.cwd);
```

The daemon asks an approver once before it trusts a folder it does not know (see [Answer approval requests](#answer-approval-requests)), and remembers it for good if they choose "allow forever". If nobody approves, the call fails with `session_folder_denied`. A relative path, a folder that does not exist, or a request from an interface token fails with `session_folder_not_allowed`, because only the daemon's own token and admin connections may pick a folder. This needs a daemon release that supports session folders. On an older daemon, `sessions.create` and `sessions.open` reject with an error that says so, rather than quietly making a session without the folder.

### Session ownership

The application's token identifies an interface in the daemon. Sessions belong to that interface, so give applications separate interface tokens when their conversations must stay separate.

Within an interface, `user` restricts a session to the person identified by your backend. Authenticate the person before passing their id, and send the same `user` with every request for that session. The daemon trusts this value, so take it from your authenticated application context rather than directly from browser input. Keep the SDK and its token on your server.

Without `user`, any caller from the same interface can use the session. Labels are also unique across the entire interface, so include a user identifier in the label when each person needs their own conversation.

`session_id` selects stored conversation history. The separate `session` parameter is a caller identity used by handlers; setting it does not save or load a conversation.

## Stream an answer

For an interface that displays an answer as it is generated, use `runners.stream`. Each iteration gives you an update: a piece of text, an action the model asked for, the result of that action, or the end of a model turn. The method accepts the same inputs as `runners.run`, including `session_id` and `user` for an existing conversation.

```ts
const stream = client.runners.stream({
  name: 'support',
  prompt: 'Explain how to reset my password.',
});

for await (const delta of stream) {
  if (delta.type === 'text_delta') process.stdout.write(delta.text);
  if (delta.type === 'tool_call') console.error(`Using action: ${delta.name}`);
  if (delta.type === 'tool_result') {
    console.error(delta.error ? `${delta.name} failed: ${delta.error}` : `${delta.name} finished`);
  }
}

const reply = await stream.result;
console.log('\nCompleted with:', reply.model);
```

A `tool_result` update carries the action's `name`, the `input` the model passed and the `output` it got back, or an `error` when the call failed. Any secret the run read is replaced by `<secret name>` in both, so you can show these to the person watching without leaking credentials.

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

| Setting                                       | What it controls                                                              | Default                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `connectTimeoutMs` in `new AgentdClient(...)` | Time allowed to establish the connection.                                     | 30 seconds                                                     |
| `timeoutMs` on the client or a call           | Time the client waits for a response after connecting. `0` means no limit.    | 11 minutes, or no limit for a session run without `timeout_ms` |
| `timeout_ms` in runner parameters             | Time the daemon allows the runner to work. Accepts 1 to 600,000 milliseconds. | 2 minutes, or no limit for a run in a session                  |

Client and daemon deadlines serve different purposes: `timeoutMs` controls how long your application waits after connecting, while `timeout_ms` controls how long the daemon allows a runner to work. An abort signal can also stop waiting during connection setup.

When your application stops waiting for a runner, the SDK asks the daemon to cancel it. For a direct action call, the action can continue after your application stops waiting. Neither case undoes work that has already completed.

Session methods also accept request options. For `open` and `delete`, they are the third argument: `client.sessions.open(label, { user }, { signal })` and `client.sessions.delete(id, { user }, { signal })`.

## Handle errors

The first example catches errors with `isAgentdError`. When the daemon reports a failure, the error includes a `code` for application logic, a readable `message` and, when available, a `tip` explaining what to check.

For example, `isAgentdError(error, 'session_busy')` identifies a conversation that already has a run in progress. Wait for that run before trying again. If you receive `session_not_found`, check the session id, application token and user id; a session outside the caller's scope is treated as missing.

A `denied` error means the daemon's grants do not allow the operation, or an approver said no. A `bad_params` error means the request needs to be corrected. Provider errors can include `providerStatus` and `retryAfterMs`, which help you decide whether to fix the provider configuration or try again later.

A few codes come from approval settings and folders. `approval_forbidden` means a run asked for a looser approval setting than its runner or session allows, and only an admin connection may do that. `classifier_not_configured` means you chose `classifier`, but the daemon has no classifier runner set up. `runner_turn_limit` means a run outside a session used all its model turns; running it in a session lifts that limit. `session_folder_not_allowed` and `session_folder_denied` are explained in [Work in a folder](#work-in-a-folder).

Connection failures, client timeouts and local cancellation are ordinary errors rather than `AgentdError`. After a dropped connection, the next request can reconnect, but failed calls are not retried automatically. Before repeating an operation that changes data, check whether it completed; a lost response does not mean the operation failed.

## Decide who answers approval questions

When a run reaches for something its grants do not cover, the daemon can ask before refusing. Each run settles once, as it starts, who answers those questions:

- `human` sends the question to an approver connected to the daemon. This is the default.
- `classifier` lets the runner named in `[approval].classifier` in `grants.toml` decide, and passes the question to a human when it is unsure.
- `nobody` refuses anything that is not granted, without asking.

The runner's own setting in `grants.toml` comes first, then the session's, then the one you pass for a single run. You can always choose something stricter, so passing `approval: 'nobody'` for an unattended job is always allowed:

```ts
const reply = await client.runners.run({
  name: 'support',
  prompt: 'Tidy up the release notes.',
  approval: 'nobody',
});
```

To set it for every run in a conversation, pass `approval` to `sessions.create`, or change it later with `client.sessions.setApproval(session.id, 'nobody', { user })`. Something looser than the runner allows, such as `classifier` for a `human` runner, only takes effect for an admin connection. A run asking for it from any other connection fails with `approval_forbidden`, and a looser session setting is simply not applied to it.

## Answer approval requests

An approver is any program connected to the daemon's approval plane with the admin token. `AgentdControl` is that connection. Listen with `approvals.requests()` and answer each request with `approvals.resolve`:

```ts
import { AgentdControl } from '@podofun/agentd-sdk';

const control = new AgentdControl({
  url: process.env.AGENTD_URL,
  adminToken: process.env.AGENTD_ADMIN_TOKEN,
});

for await (const request of control.approvals.requests()) {
  if (request.kind === 'folder') {
    console.log(`Work in ${request.detail.folder}?`);
  } else {
    console.log(`${request.action} wants ${request.missing.join(', ')}: ${request.reason}`);
  }
  await control.approvals.resolve(request.id, 'allow_once');
}
```

Every request has a `kind`. `missing_grant` means a tool lacks permissions, `confirm` means the action always asks first, `runner_action` means a runner called an action outside its list, and `folder` means a client wants a session to work in a folder nobody has trusted yet. `detail` shows what the call is about to do, with secrets replaced by their names, and `caller` shows who asked. When `warning` is present, show it before offering "allow forever".

The verdict is one of `allow_once`, `allow_forever`, which also writes the grant or trusted folder to `grants.toml`, or `deny`. A request nobody answers is refused once the daemon's approval timeout runs out, and with no approver connected the daemon refuses straight away. The loop ends quietly when you break out of it, abort the `signal` you passed to `requests({ signal })`, or call `control.close()`. It throws if the connection drops, so wrap it in a retry if your approver should stay up. Keep the admin token on machines you control: anyone holding it can approve anything.

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
