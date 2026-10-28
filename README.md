# agentd-sdk

The agentd SDK connects your TypeScript or JavaScript application to [agent.d](https://github.com/podofun/agent.d). Use it to call actions, run agents, stream their replies, keep conversations, and answer the approval questions agents ask.

Three ideas come up throughout this guide:

- An **action** does one specific job, such as checking a Git repository.
- A **runner** is an agent. It uses a model to answer a prompt, and it can call the actions it is allowed to use.
- A **session** is a conversation. It keeps the earlier messages, so a runner can answer follow-up questions.

## Installation

You need Node.js 22 or newer and a running agent.d daemon that supports the `0.10.0-alpha` API.

```bash
npm install @podofun/agentd-sdk@alpha
```

## Your first request

Start by listing the actions and runners your daemon has loaded. Set `AGENTD_URL` to the daemon's address and `AGENTD_TOKEN` to your application's token. Without `AGENTD_URL`, the example connects to a local daemon at `http://127.0.0.1:7777`.

Your token tells the daemon who your application is, and there are three kinds:

- **The daemon's own token** connects you as the `ws` interface.
- **A token from an `[interfaces.<name>]` entry** in the daemon's `config.toml` connects you as that interface, with its own grants and its own sessions. Use this kind for a bot or a web app.
- **The admin token** makes an admin connection. An admin connection can loosen a run's approval setting, and its sessions are kept apart from everyone else's. Use it only for tools you run yourself.

Save this code as `example.mjs` and run `node example.mjs`. It works in a TypeScript project too.

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

The client connects on your first request. In a short script, close it in `finally` as shown. In a server, create one client, reuse it for every request, and close it when the server shuts down. To check the connection at startup, call `await client.connect()`. After `close()`, create a new client to connect again.

To try the examples below, put them in place of the `try` block above, and use action and runner names from your own daemon. The examples use an action called `git.status` and a runner called `support`. The `support` runner needs a model provider and its grant in `grants.toml`.

## Call an action

Call an action when you know which job you want done. For example, a `git.status` action reports the state of a repository:

```ts
const response = await client.actions.call('git.status');
console.log(response.result);
console.log(`Completed in ${response.duration_ms} ms`);
```

`response.result` holds what the action returned, and `duration_ms` says how long it took. If the action takes arguments, pass them second: `client.actions.call('notes.save', { text: 'Check the release notes' })`. The action has to be registered in the daemon, with the permissions it needs in `grants.toml`.

## Ask a runner

Give a runner a prompt with `runners.run` and wait for its answer. The runner works with its own model, instructions and actions.

```ts
const reply = await client.runners.run({
  name: 'support',
  prompt: 'Explain how to reset my password.',
});

console.log(reply.text);
```

The answer is in `reply.text`. The reply also names the `provider` and `model` and gives a `stop_reason`. When the model reports token usage, `reply.usage` has the totals.

A call like this starts with an empty history. For a follow-up question, use a session, or pass the earlier messages yourself in `messages`.

## Continue a conversation

A session gives a runner the earlier messages of a conversation. Your application picks a stable label for it, for example from a user id and a chat id, and `sessions.open` finds that session or creates it.

Pass the session's `id` as `session_id` with each prompt. Here the second prompt can use the first exchange:

```ts
const userId = 'alice'; // In your app, use the signed-in user's id.
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

`sessions.get` returns the saved conversation, with the messages in order in `turns`. The history is kept when the daemon restarts. In a long conversation, the daemon can replace older messages with a summary, depending on the runner's compaction settings, so `turns` may not hold every original message.

Send one prompt at a time to a session. A second run that starts before the first one ends fails with `session_busy`. With `session_id`, send a `prompt` and leave out `messages`: the daemon loads the history itself.

When a run fails or is cancelled, the session keeps your prompt and every step that finished, followed by a note that the reply stopped early. Your next message then continues from there.

### Find and manage sessions

| Call                                                  | What it does                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.sessions.create({ label, user })`             | Creates a session. Both fields are optional. A label that is already in use fails with `session_label_taken`.                                                                           |
| `client.sessions.open(label, { user })`               | Finds the session with that label, or creates it.                                                                                                                                       |
| `client.sessions.get({ id, user })`                   | Returns the session's details and saved messages. Pass `{ label, user }` to look it up by label.                                                                                        |
| `client.sessions.list({ user, limit: 50 })`           | Lists the sessions you can see, newest first. The limit is 50 by default and 500 at most.                                                                                               |
| `client.sessions.rename(id, label, { user })`         | Gives the session a new label, or removes it when you pass `null`. A label another session uses fails with `session_label_taken`.                                                       |
| `client.sessions.setApproval(id, approval, { user })` | Changes who answers questions for the session's runs, or removes the setting when you pass `null`. See [Decide who answers approval questions](#decide-who-answers-approval-questions). |
| `client.sessions.delete(id, { user })`                | Deletes the session and its messages. Returns `{ deleted: true }`, or `{ deleted: false }` when no session you can see matches.                                                         |

`user` is optional. If you create a session with a `user`, send the same `user` every time you use that session. The optional `runner` field on `create` and `open` is a note for your own use: any runner can run in the session.

Each session counts the tokens its runs have used, in `usage`, next to `turn_count` and the number of `compactions`. You can use `usage` to show what a conversation costs, or to stop it at a budget.

A run in a session has no time limit and no limit on model turns by default, so a long task can finish. The SDK waits for it as long as it takes: the client's default `timeoutMs` does not apply to a session run without `timeout_ms`. To set a limit, pass `timeout_ms` for the daemon, pass `timeoutMs` in the call options to stop waiting, or cancel the run as shown in [Timeouts and cancellation](#timeouts-and-cancellation).

### Work in a folder

If your application runs on the same machine as the daemon, a session can work in a folder you choose. Its runs then read and write files in that folder. Pass the folder's absolute path as `cwd` when you create the session:

```ts
const session = await client.sessions.create({ label: 'repo-chat', cwd: '/home/alice/code/shop' });
console.log(session.cwd);
```

The first time a session asks for a folder the daemon does not trust yet, the daemon asks an approver (see [Answer approval requests](#answer-approval-requests)). If the approver chooses "allow forever", the daemon trusts that folder from then on. If nobody allows it, the call fails with `session_folder_denied`.

Only the daemon's own token and admin connections can choose a folder. A relative path, a folder that does not exist, or a request on an interface token fails with `session_folder_not_allowed`. Older daemons do not support session folders: on those, `sessions.create` and `sessions.open` fail with an error that says so.

### Who can use a session

Your application's token identifies an interface in the daemon, and sessions belong to that interface. Give two applications separate interface tokens when their conversations must stay apart.

Inside one interface, `user` limits a session to one person. Sign the person in first, then send their id as `user` on every request for that session. The daemon trusts whatever `user` you send, so take it from your signed-in session on the server, and keep the SDK and its token on your server.

A session without a `user` is open to every caller on the same interface. Labels are unique across the whole interface, so put the user's id in the label when each person needs their own conversation.

`session_id` chooses which saved conversation a run uses. The separate `session` parameter names the caller for action handlers, and it does not save or load any conversation.

## Stream an answer

To show an answer while it is being written, use `runners.stream`. Each step of the loop gives you one update: a piece of text, an action the model called, that action's result, or the end of a model turn. It takes the same inputs as `runners.run`, including `session_id` and `user`.

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

A `tool_result` update has the action's `name`, the `input` the model gave it, and the `output` it returned, or an `error` when it failed. Secrets the run read appear as `<secret name>` in both, so you can show these updates to the person watching.

After the loop, await `stream.result` for the finished reply. A run can still fail after some text has arrived, so treat streamed text as a draft until the run succeeds. If you `break` out of the loop, the SDK asks the daemon to cancel the run.

## Timeouts and cancellation

Pass request options after a call's parameters to control how long your application waits. Here an abort signal stops waiting after 30 seconds:

```ts
const reply = await client.runners.run(
  { name: 'support', prompt: 'Explain how to reset my password.' },
  { signal: AbortSignal.timeout(30_000) },
);
console.log(reply.text);
```

For a Cancel button, or a request whose user went away, create an `AbortController`, pass its `signal` in the same place, and call `controller.abort()` when you no longer need the result.

| Setting                                       | What it controls                                                             | Default                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `connectTimeoutMs` in `new AgentdClient(...)` | How long the client tries to connect.                                        | 30 seconds                                                     |
| `timeoutMs` on the client or a call           | How long the client waits for a response once connected. `0` means no limit. | 11 minutes, or no limit for a session run without `timeout_ms` |
| `timeout_ms` in runner parameters             | How long the daemon lets the runner work, from 1 to 600,000 milliseconds.    | 2 minutes, or no limit for a run in a session                  |

`timeoutMs` is how long your application waits. `timeout_ms` is how long the daemon lets the runner work. An abort signal also works while the client is still connecting.

When your application stops waiting for a runner, the SDK asks the daemon to cancel the run. An action call keeps running on the daemon after you stop waiting. In both cases, work that already finished stays done.

Session methods take request options too. For `open` and `delete`, they come third: `client.sessions.open(label, { user }, { signal })` and `client.sessions.delete(id, { user }, { signal })`.

## Handle errors

The first example catches errors with `isAgentdError`. An error from the daemon has a `code` for your program to check, a `message` to show, and often a `tip` that says what to look at.

For example, `isAgentdError(error, 'session_busy')` tells you a conversation already has a run going: wait for it to finish, then try again. If you get `session_not_found`, check the session id, the token and the user id. A session that belongs to someone else looks the same as a missing one.

| Code                                                  | What it means                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `denied`                                              | The daemon's grants do not allow it, or an approver said no.                                                      |
| `bad_params`                                          | Something in the request needs fixing.                                                                            |
| `approval_forbidden`                                  | The run asked for a looser approval setting than its runner or session has. Only an admin connection can do that. |
| `classifier_not_configured`                           | You chose `classifier`, but the daemon has no classifier runner set up.                                           |
| `runner_turn_limit`                                   | A run outside a session used all of its model turns. Runs in a session have no turn limit.                        |
| `session_folder_not_allowed`, `session_folder_denied` | See [Work in a folder](#work-in-a-folder).                                                                        |

Provider errors can carry `providerStatus` and `retryAfterMs`, which tell you whether to fix the provider's settings or try again later.

A failed connection, a client timeout, and a call you cancelled throw an ordinary `Error`. Only errors from the daemon are `AgentdError`. After the connection drops, your next request reconnects, but the SDK does not retry failed calls for you. Before you repeat a call that changes data, check whether it went through: a lost response does not mean the call failed.

## Decide who answers approval questions

When a run needs something its grants do not cover, the daemon can ask before it refuses. When a run starts, the daemon settles who answers its questions:

- `human`: an approver connected to the daemon answers. This is the default.
- `classifier`: the runner named in `[approval].classifier` in `grants.toml` answers, and hands a question to a human when it is unsure.
- `nobody`: anything not granted is refused, and nobody is asked.

The runner's setting in `grants.toml` applies first, then the session's, then the one you pass for a single run. You can always choose a stricter setting, so `approval: 'nobody'` works for any unattended job:

```ts
const reply = await client.runners.run({
  name: 'support',
  prompt: 'Tidy up the release notes.',
  approval: 'nobody',
});
```

To set it for every run in a conversation, pass `approval` to `sessions.create`, or change it later with `client.sessions.setApproval(session.id, 'nobody', { user })`. A looser setting than the runner's own, such as `classifier` for a `human` runner, works only on an admin connection. From any other connection, a run that asks for it fails with `approval_forbidden`, and a looser session setting does not apply to it.

## Answer approval requests

An approver is a program that answers the daemon's approval questions. It connects with the admin token through `AgentdControl`, listens with `approvals.requests()`, and answers each question with `approvals.resolve`.

An approver should refuse anything it has no reason to allow. This one allows two hosts and one projects folder, and refuses everything else:

```ts
import { AgentdControl, type ApprovalRequest, type Verdict } from '@podofun/agentd-sdk';

const trustedHosts = new Set(['net:api.github.com', 'net:registry.npmjs.org']);
const projects = '/home/alice/code/';

function decide(request: ApprovalRequest): Verdict {
  if (request.kind === 'folder') {
    return request.detail.folder.startsWith(projects) ? 'allow_once' : 'deny';
  }
  if (request.kind === 'missing_grant' && request.missing.length > 0) {
    return request.missing.every(permission => trustedHosts.has(permission)) ? 'allow_once' : 'deny';
  }
  return 'deny';
}

const control = new AgentdControl({
  url: process.env.AGENTD_URL,
  adminToken: process.env.AGENTD_ADMIN_TOKEN,
});
await control.connect();

for await (const request of control.approvals.requests()) {
  const verdict = decide(request);
  console.log(`${verdict}: ${request.action} (${request.reason})`);
  await control.approvals.resolve(request.id, verdict);
}
```

`connect()` returns once the daemon has confirmed it will send you questions, so you receive every question asked after that. The loop also connects by itself, but calling `connect()` first means a wrong address or token fails at startup.

Every request has a `kind`:

- `missing_grant`: a tool is missing a permission.
- `confirm`: the action asks before every use.
- `runner_action`: a runner called an action that is not on its list.
- `folder`: a session wants to work in a folder the daemon does not trust yet.

`detail` shows what the call is about to do, with secrets replaced by their names, and `caller` shows who is asking. When a request has a `warning`, show it before you offer "allow forever".

The answer is `allow_once`, `allow_forever` or `deny`. `allow_forever` also writes the grant or the trusted folder into `grants.toml`. A question nobody answers is refused when the daemon's approval timeout runs out, and when no approver is connected the daemon refuses at once.

The loop ends when you `break` out of it, abort the `signal` you passed to `requests({ signal })`, or call `control.close()`. It throws if the connection drops, so restart it if your approver has to stay up. Keep the admin token on machines you control: whoever has it can approve anything.

## Explore your daemon

| Call                           | Result                                                 |
| ------------------------------ | ------------------------------------------------------ |
| `client.health()`              | `'ok'` when the daemon responds.                       |
| `client.tools.list()`          | The names of the registered actions.                   |
| `client.runners.list()`        | Each runner's name, model, skills and allowed actions. |
| `client.runners.inspect(name)` | A runner's settings, including its full system prompt. |
| `client.skills.list()`         | The available skills and their descriptions.           |
| `client.skills.inspect(name)`  | A skill's definition and its prompt text.              |
| `client.services.list()`       | The background services and their current state.       |

For health checks in a deployment, `probeHealth(url)` tells you whether the daemon is up, and `probeReady(url)` whether it is taking work. Import them from the package and await the result. They need no token and throw if the daemon cannot be reached. `probeReady` returns `false` while the daemon is shutting down.
