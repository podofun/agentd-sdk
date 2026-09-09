import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWsUrl } from '../dist/url.js';

test('defaults to the local daemon', () => {
  assert.equal(resolveWsUrl().href, 'ws://127.0.0.1:7777/ws');
});

test('maps http(s) to ws(s) and appends /ws once', () => {
  assert.equal(resolveWsUrl('http://agentd:7777').href, 'ws://agentd:7777/ws');
  assert.equal(resolveWsUrl('https://example.com/agentd').href, 'wss://example.com/agentd/ws');
  assert.equal(resolveWsUrl('https://example.com/agentd/').href, 'wss://example.com/agentd/ws');
  assert.equal(resolveWsUrl('ws://example.com/ws').href, 'ws://example.com/ws');
  assert.equal(resolveWsUrl('wss://example.com/proxy/ws').href, 'wss://example.com/proxy/ws');
});

test('rejects unsupported schemes, credentials and fragments', () => {
  assert.throws(() => resolveWsUrl('file:///tmp/x'), TypeError);
  assert.throws(() => resolveWsUrl('http://user:pw@host'), TypeError);
  assert.throws(() => resolveWsUrl('http://host/#frag'), TypeError);
  assert.throws(() => resolveWsUrl('not a url'), TypeError);
});
