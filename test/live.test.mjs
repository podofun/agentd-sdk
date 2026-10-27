import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentdClient, AgentdControl, isAgentdError, probeHealth, probeReady } from '../dist/index.js';
import { startDaemon, ADMIN_TOKEN, BOT_TOKEN, DAEMON_TOKEN } from './helpers/daemon.mjs';
import { startFakeOpenAI } from './helpers/openai.mjs';

const url = process.env.AGENTD_TEST_URL;
/** An agentd binary to start for these tests. */
const bin = process.env.AGENTD_BIN;
/** An agentd binary that knows session folders (`sessions.create { cwd }`). */
const cwdBin = process.env.AGENTD_CWD_BIN;

test('talks to a separately managed daemon', { skip: !url }, async t => {
  const client = new AgentdClient({ url, token: process.env.AGENTD_TEST_TOKEN });
  t.after(() => client.close());
  assert.equal(await probeHealth(url), true);
  assert.equal(await client.health(), 'ok');
  assert.ok(Array.isArray(await client.tools.list()));
  assert.ok(Array.isArray(await client.runners.list()));
  await assert.rejects(client.actions.call('does.not.exist'), e => isAgentdError(e, 'not_found'));
  const wrong = new AgentdClient({ url, token: 'invalid-token' });
  t.after(() => wrong.close());
  await assert.rejects(wrong.health(), /HTTP 401/);
});

const SECRET = 'sk-live-demo-value-123';

const INIT = `
local d = agentd

d.tool({ name = "demo", requires = { "secret:demo_key" } })
d.action({ name = "demo.echo", handler = function(args) return args end })
d.action({ name = "demo.boom", handler = function() error("the demo action blew up") end })
d.action({
  name = "demo.secret",
  requires = { "secret:demo_key" },
  handler = function(_, ctx) return { key = ctx.secret.get("demo_key") } end,
})

d.tool({ name = "locked", requires = { "secret:other_key" } })
d.action({
  name = "locked.peek",
  requires = { "secret:other_key" },
  handler = function() return { peeked = true } end,
})

d.runner({ name = "mocky", model = "mock/test" })
d.runner({ name = "chat", model = "fake/m", actions = { "demo.secret", "demo.boom" } })
`;

const GRANTS = `
[tool.demo]
granted = ["secret:demo_key"]

[runner.mocky]
granted = ["ai:mock"]

[runner.chat]
granted = ["ai:fake"]
allowed_actions = ["demo.secret", "demo.boom"]
`;

const config = baseUrl => `
[interfaces.bot]
token = "${BOT_TOKEN}"

[providers.fake]
kind = "openai"
base_url = "${baseUrl}"
auth = "none"
`;

/** Scripted model: "use the tools" calls demo.secret, then demo.boom, then answers; "hang" never answers. */
function model(body) {
  const messages = body.messages ?? [];
  const lastUserIndex = messages.findLastIndex(m => m.role === 'user');
  const lastUser = messages[lastUserIndex]?.content ?? '';
  if (lastUser.includes('hang')) return { hang: true };
  const toolsThisRun = messages.slice(lastUserIndex).filter(m => m.role === 'tool').length;
  if (lastUser.includes('use the tools')) {
    if (toolsThisRun === 0) return { tool: 'demo.secret', args: { why: 'testing' } };
    if (toolsThisRun === 1) return { tool: 'demo.boom', args: {} };
    return { text: 'All tools ran.' };
  }
  return { text: `You said: ${lastUser}` };
}

async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test('a real daemon', { skip: !bin }, async t => {
  const fake = await startFakeOpenAI(t, model);
  const daemon = await startDaemon(t, bin, {
    init: INIT,
    grants: GRANTS,
    config: config(fake.baseUrl),
    secrets: { demo_key: SECRET },
  });
  const client = new AgentdClient({ url: daemon.url, token: DAEMON_TOKEN, timeoutMs: 20_000 });
  const bot = new AgentdClient({ url: daemon.url, token: BOT_TOKEN, timeoutMs: 20_000 });
  const admin = new AgentdClient({ url: daemon.url, token: ADMIN_TOKEN, timeoutMs: 20_000 });
  t.after(() => [client, bot, admin].forEach(c => c.close()));

  await t.test('health, probes and discovery', async () => {
    assert.equal(await probeHealth(daemon.url), true);
    assert.equal(await probeReady(daemon.url), true);
    assert.equal(await client.health(), 'ok');
    assert.deepEqual((await client.tools.list()).sort(), [
      'demo.boom',
      'demo.echo',
      'demo.secret',
      'locked.peek',
    ]);
    const runners = await client.runners.list();
    assert.deepEqual(runners.map(r => r.name).sort(), ['chat', 'mocky']);
    assert.equal((await client.runners.inspect('chat')).model, 'fake/m');
    assert.deepEqual(await client.skills.list(), []);
    assert.deepEqual(await client.services.list(), []);
  });

  await t.test('actions and their errors', async () => {
    const echoed = await client.actions.call('demo.echo', { text: 'hi' }, { user: 'u1' });
    assert.deepEqual(echoed.result, { text: 'hi' });
    assert.ok(Number.isInteger(echoed.duration_ms));
    await assert.rejects(client.actions.call('does.not.exist'), e => {
      assert.ok(isAgentdError(e, 'not_found'));
      assert.ok(e.tip);
      return true;
    });
    await assert.rejects(client.actions.call('demo.boom'), e => {
      assert.ok(isAgentdError(e, 'lua_error'));
      assert.match(e.message, /the demo action blew up/);
      assert.ok(e.trace.length > 0);
      assert.ok(Number.isInteger(e.durationMs));
      return true;
    });
    await assert.rejects(client.request('nope.method'), e => isAgentdError(e, 'unknown_method'));
    await assert.rejects(client.sessions.get({}), e => isAgentdError(e, 'bad_params'));
  });

  await t.test('tokens: a wrong one is refused, and each kind of connection owns its sessions', async () => {
    const wrong = new AgentdClient({ url: daemon.url, token: 'wrong-token' });
    await assert.rejects(wrong.health(), /HTTP 401/);
    wrong.close();

    const mine = await client.sessions.create({ label: 'shared-label' });
    const theirs = await bot.sessions.create({ label: 'shared-label' });
    const admins = await admin.sessions.create({ label: 'shared-label' });
    assert.equal(mine.owner, 'interface:ws');
    assert.equal(theirs.owner, 'interface:bot');
    assert.equal(admins.owner, 'admin:ws');
    await assert.rejects(bot.sessions.get({ id: mine.id }), e => isAgentdError(e, 'session_not_found'));
    await assert.rejects(client.sessions.get({ id: admins.id }), e => isAgentdError(e, 'session_not_found'));
    assert.equal((await admin.sessions.get({ label: 'shared-label' })).id, admins.id);
    for (const [c, s] of [
      [client, mine],
      [bot, theirs],
      [admin, admins],
    ]) {
      assert.deepEqual(await c.sessions.delete(s.id), { deleted: true });
    }
  });

  await t.test('sessions: create, get, list, rename, set approval, delete', async () => {
    const created = await client.sessions.create({ label: 'live-1', runner: 'chat', user: 'alice' });
    assert.equal(created.label, 'live-1');
    assert.equal(created.user, 'alice');
    assert.equal(created.turn_count, 0);
    assert.equal(created.compactions, 0);
    assert.equal(created.approval, undefined);
    assert.deepEqual(created.usage, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const strict = await client.sessions.create({ label: 'live-2', approval: 'nobody', user: 'alice' });
    assert.equal(strict.approval, 'nobody');

    assert.deepEqual((await client.sessions.get({ label: 'live-1', user: 'alice' })).turns, []);
    await assert.rejects(client.sessions.get({ label: 'live-1' }), e =>
      isAgentdError(e, 'session_not_found'),
    );
    assert.equal((await client.sessions.list({ user: 'alice', limit: 1 })).length, 1);
    assert.equal((await client.sessions.list({ user: 'alice' })).length, 2);

    const renamed = await client.sessions.rename(created.id, 'live-1b', { user: 'alice' });
    assert.equal(renamed.label, 'live-1b');
    await assert.rejects(client.sessions.rename(created.id, 'live-2', { user: 'alice' }), e =>
      isAgentdError(e, 'session_label_taken'),
    );
    await assert.rejects(client.sessions.rename(created.id, 'x'), e => isAgentdError(e, 'session_not_found'));
    assert.equal((await client.sessions.rename(created.id, null, { user: 'alice' })).label, undefined);

    const nobody = await client.sessions.setApproval(created.id, 'nobody', { user: 'alice' });
    assert.equal(nobody.approval, 'nobody');
    assert.equal(
      (await client.sessions.setApproval(created.id, null, { user: 'alice' })).approval,
      undefined,
    );
    await assert.rejects(client.sessions.setApproval(created.id, 'classifier', { user: 'alice' }), e => {
      assert.ok(isAgentdError(e, 'classifier_not_configured'));
      assert.ok(e.tip);
      return true;
    });
    await assert.rejects(client.sessions.create({ approval: 'classifier' }), e =>
      isAgentdError(e, 'classifier_not_configured'),
    );

    assert.equal((await client.sessions.open('live-2', { user: 'alice' })).id, strict.id);
    assert.deepEqual(await client.sessions.delete(created.id, { user: 'alice' }), { deleted: true });
    assert.deepEqual(await client.sessions.delete(created.id, { user: 'alice' }), { deleted: false });
    await client.sessions.delete(strict.id, { user: 'alice' });
  });

  await t.test('cwd is never silently dropped', async () => {
    // An older daemon ignores the field, so the SDK reports that; a newer one asks an approver, and none is connected.
    await assert.rejects(
      client.sessions.create({ label: 'folder-1', cwd: daemon.work }),
      e => /does not support session folders/.test(e.message) || isAgentdError(e, 'session_folder_denied'),
    );
    await assert.rejects(client.sessions.get({ label: 'folder-1' }), e =>
      isAgentdError(e, 'session_not_found'),
    );
  });

  await t.test('a mock/ model has no provider, and loosening approval needs the admin token', async () => {
    await assert.rejects(client.runners.run({ name: 'mocky', prompt: 'hi' }), e => {
      assert.ok(isAgentdError(e, 'no_provider'));
      assert.ok(e.tip);
      return true;
    });
    await assert.rejects(client.runners.run({ name: 'mocky', prompt: 'hi', approval: 'classifier' }), e => {
      assert.ok(isAgentdError(e, 'approval_forbidden'));
      assert.match(e.tip, /admin token/);
      return true;
    });
    // Stricter is always fine, so these get as far as the missing provider.
    await assert.rejects(client.runners.run({ name: 'mocky', prompt: 'hi', approval: 'nobody' }), e =>
      isAgentdError(e, 'no_provider'),
    );
    await assert.rejects(admin.runners.run({ name: 'mocky', prompt: 'hi', approval: 'classifier' }), e =>
      isAgentdError(e, 'no_provider'),
    );
    await assert.rejects(client.runners.run({ name: 'nobody-here', prompt: 'hi' }), e =>
      isAgentdError(e, 'runner_not_found'),
    );
    await assert.rejects(client.runners.run({ name: 'chat', prompt: 'hi', timeout_ms: 0 }), e =>
      isAgentdError(e, 'bad_params'),
    );
  });

  await t.test('runners.run against a fake OpenAI-compatible endpoint', async () => {
    const out = await client.runners.run({ name: 'chat', prompt: 'hello' });
    assert.equal(out.provider, 'fake');
    assert.equal(out.text, 'You said: hello');
    assert.ok(out.usage.input_tokens > 0);
  });

  await t.test('streaming a session run shows tool calls and redacted tool results', async () => {
    const session = await client.sessions.create({ label: 'stream-1' });
    const stream = client.runners.stream({
      name: 'chat',
      prompt: 'please use the tools',
      session_id: session.id,
    });
    const deltas = [];
    for await (const delta of stream) deltas.push(delta);
    const out = await stream.result;
    assert.equal(out.text, 'All tools ran.');
    assert.equal(out.session_id, session.id);

    assert.deepEqual(
      deltas.map(d => d.type).filter(type => type !== 'text_delta'),
      ['tool_call', 'turn_end', 'tool_result', 'tool_call', 'turn_end', 'tool_result', 'turn_end'],
    );
    const text = deltas.filter(d => d.type === 'text_delta').map(d => d.text);
    assert.equal(text.join(''), 'All tools ran.');
    const [secret, boom] = deltas.filter(d => d.type === 'tool_result');
    assert.equal(secret.name, 'demo.secret');
    assert.deepEqual(secret.input, { why: 'testing' });
    assert.ok(!JSON.stringify(secret.output).includes(SECRET), 'the secret value must be redacted');
    assert.match(JSON.stringify(secret.output), /demo_key/);
    assert.equal(secret.error, undefined);
    assert.equal(boom.name, 'demo.boom');
    assert.equal(boom.output, undefined);
    assert.match(boom.error, /the demo action blew up/);
    // The model itself saw the real value; only what the stream shows people is redacted.
    assert.ok(JSON.stringify(fake.requests.at(-1).messages).includes(SECRET));

    const saved = await client.sessions.get({ id: session.id });
    assert.ok(saved.turn_count >= 2);
    assert.equal(saved.turns[0].content, 'please use the tools');
    assert.deepEqual(saved.usage, out.usage);
    assert.ok(saved.usage.output_tokens > 0);
    assert.ok(saved.usage.cache_read_input_tokens > 0);
  });

  await t.test('cancelling, deadlines and busy sessions', async () => {
    const session = await client.sessions.create({ label: 'cancel-1' });
    const seen = fake.requests.length;
    const controller = new AbortController();
    const hanging = client.runners.run(
      { name: 'chat', prompt: 'hang please', session_id: session.id },
      { signal: controller.signal },
    );
    await waitFor(() => fake.requests.length > seen, 'the model request');
    await assert.rejects(client.runners.run({ name: 'chat', prompt: 'hi', session_id: session.id }), e =>
      isAgentdError(e, 'session_busy'),
    );
    controller.abort();
    await assert.rejects(hanging, { name: 'AbortError' });

    // The SDK sent runners.cancel, so the session frees up.
    const runWhenFree = async params => {
      let result;
      await waitFor(async () => {
        result = await client.runners.run({ name: 'chat', session_id: session.id, ...params }).catch(e => e);
        return !isAgentdError(result, 'session_busy');
      }, 'the session to free up');
      return result;
    };
    const after = await runWhenFree({ prompt: 'are you there' });
    assert.equal(after.text, 'You said: are you there');

    // Breaking out of a stream cancels too.
    const before = fake.requests.length;
    const stream = client.runners.stream({ name: 'chat', prompt: 'hang again', session_id: session.id });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitFor(() => fake.requests.length > before, 'the model request');
    await iterator.return();
    await assert.rejects(stream.result, { name: 'AbortError' });
    await next.catch(() => {});

    // A session run has no default deadline, but honours timeout_ms.
    const timedOut = await runWhenFree({ prompt: 'hang with a deadline', timeout_ms: 300 });
    assert.ok(isAgentdError(timedOut, 'timeout'), String(timedOut));
  });

  await t.test('approvals over /control', async t2 => {
    const control = new AgentdControl({ url: daemon.url, adminToken: ADMIN_TOKEN });
    t2.after(() => control.close());
    const requests = control.approvals.requests()[Symbol.asyncIterator]();
    assert.deepEqual(await control.approvals.subscribe(), { subscribed: true });

    const allowed = client.actions.call('locked.peek', {}, { user: 'bob' });
    const { value: ask } = await requests.next();
    assert.equal(ask.kind, 'missing_grant');
    assert.equal(ask.action, 'locked.peek');
    assert.equal(ask.tool, 'locked');
    assert.deepEqual(ask.missing, ['secret:other_key']);
    assert.equal(ask.caller.interface, 'ws');
    assert.equal(ask.caller.user, 'bob');
    assert.deepEqual(await control.approvals.resolve(ask.id, 'allow_once'), { resolved: ask.id });
    assert.deepEqual((await allowed).result, { peeked: true });

    const refused = client.actions.call('locked.peek');
    const { value: again } = await requests.next();
    await control.approvals.resolve(again.id, 'deny');
    await assert.rejects(refused, e => isAgentdError(e, 'denied'));

    await assert.rejects(control.approvals.resolve(1, 'maybe'), e => isAgentdError(e, 'invalid'));

    control.close();
    assert.deepEqual(await requests.next(), { value: undefined, done: true });
    // With nobody listening the daemon refuses at once.
    await assert.rejects(client.actions.call('locked.peek'), e => isAgentdError(e, 'denied'));

    const wrong = new AgentdControl({ url: daemon.url, adminToken: DAEMON_TOKEN });
    await assert.rejects(wrong.connect(), /HTTP 401/);
    wrong.close();
  });

  await t.test('the trace file records the requests', async () => {
    assert.match(await daemon.trace(), /demo\.echo/);
  });
});

test('session folders on a daemon that supports them', { skip: !cwdBin }, async t => {
  const daemon = await startDaemon(t, cwdBin, {
    init: 'agentd.action({ name = "demo.echo", handler = function(args) return args end })',
    config: `[interfaces.bot]\ntoken = "${BOT_TOKEN}"\n`,
  });
  const client = new AgentdClient({ url: daemon.url, token: DAEMON_TOKEN, timeoutMs: 20_000 });
  const bot = new AgentdClient({ url: daemon.url, token: BOT_TOKEN });
  const admin = new AgentdClient({ url: daemon.url, token: ADMIN_TOKEN });
  t.after(() => [client, bot, admin].forEach(c => c.close()));
  const folder = async name => {
    const path = join(daemon.work, name);
    await mkdir(path, { recursive: true });
    return realpath(path);
  };

  await t.test('folders that are never allowed', async () => {
    const app = await folder('app');
    await assert.rejects(client.sessions.create({ cwd: 'relative/path' }), e => {
      assert.ok(isAgentdError(e, 'session_folder_not_allowed'));
      assert.ok(e.tip);
      return true;
    });
    await assert.rejects(client.sessions.create({ cwd: join(app, 'missing') }), e =>
      isAgentdError(e, 'session_folder_not_allowed'),
    );
    await assert.rejects(bot.sessions.create({ cwd: app }), e =>
      isAgentdError(e, 'session_folder_not_allowed'),
    );
  });

  await t.test('with no approver connected the folder is refused', async () => {
    await assert.rejects(client.sessions.create({ cwd: await folder('app') }), e => {
      assert.ok(isAgentdError(e, 'session_folder_denied'));
      assert.ok(e.tip);
      return true;
    });
  });

  await t.test('an approver answers folder questions', async t2 => {
    const control = new AgentdControl({ url: daemon.url, adminToken: ADMIN_TOKEN });
    t2.after(() => control.close());
    const asked = [];
    const answers = [];
    const listening = (async () => {
      for await (const request of control.approvals.requests()) {
        asked.push(request);
        await control.approvals.resolve(request.id, answers.shift() ?? 'deny');
      }
    })();
    await control.connect();

    const app = await folder('app');
    answers.push('deny');
    await assert.rejects(client.sessions.create({ cwd: app }), e =>
      isAgentdError(e, 'session_folder_denied'),
    );
    assert.equal(asked.at(-1).kind, 'folder');
    assert.equal(asked.at(-1).action, app);
    assert.deepEqual(asked.at(-1).detail, { folder: app });
    assert.equal(asked.at(-1).tool, null);

    answers.push('allow_once');
    const once = await client.sessions.create({ cwd: app, label: 'in-app' });
    assert.equal(once.cwd, app);
    assert.equal((await client.sessions.get({ id: once.id })).cwd, app);
    assert.equal(asked.length, 2);

    // A taken label fails before anyone is asked.
    await assert.rejects(client.sessions.create({ cwd: app, label: 'in-app' }), e =>
      isAgentdError(e, 'session_label_taken'),
    );
    assert.equal(asked.length, 2);

    const lib = await folder('lib');
    answers.push('allow_forever');
    assert.equal((await admin.sessions.create({ cwd: lib })).cwd, lib);
    assert.equal(asked.length, 3);
    assert.ok((await daemon.grants()).includes(lib));
    // Trusted now, subfolders included, so nobody is asked again.
    const nested = await folder('lib/nested');
    assert.equal((await client.sessions.create({ cwd: lib })).cwd, lib);
    assert.equal((await client.sessions.create({ cwd: nested })).cwd, nested);
    assert.equal(asked.length, 3);

    control.close();
    await listening;
  });
});
