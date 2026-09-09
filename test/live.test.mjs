import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentdClient, isAgentdError, probeHealth } from '../dist/index.js';

const url = process.env.AGENTD_TEST_URL;

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
