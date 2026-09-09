# Contributing

```bash
npm ci
npm run lint
npm test
```

Tests run against a mock daemon; no agent.d binaries are needed. To also exercise a real daemon, set `AGENTD_TEST_URL` and `AGENTD_TEST_TOKEN` before `npm test`.

CI runs lint, tests, and a pack dry run on Linux, macOS, and Windows for every push and pull request.

## Releasing

Bump `version` in `package.json`, then:

```bash
npm publish --access public --tag alpha   # pre-releases
npm publish --access public               # stable
```
