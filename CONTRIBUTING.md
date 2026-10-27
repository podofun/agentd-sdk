# Contributing

```bash
npm ci
npm run lint
npm test
```

Tests run against a mock daemon; no agent.d binaries are needed. `npm test` also type-checks `test/types/protocol.ts` against the built declarations, so a change to the public types that breaks callers fails there.

To exercise a real daemon, point `AGENTD_BIN` at an `agentd` binary before `npm test`. The live tests start it on a free port in a throwaway home, with its own `config.toml`, `init.lua`, `grants.toml`, trace file and XDG folders, so your own daemon and its data are never touched. No model provider is needed: a small fake OpenAI-compatible endpoint stands in for one, which is how streaming, tool results and cancellation get covered end to end. Set `AGENTD_CWD_BIN` as well to test session folders against a daemon that supports them.

```bash
AGENTD_BIN=/path/to/agentd AGENTD_CWD_BIN=/path/to/agentd npm test
```

You can also run the smaller check against a daemon you manage yourself by setting `AGENTD_TEST_URL` and `AGENTD_TEST_TOKEN`.

CI runs lint, tests, and a pack dry run on Linux, macOS, and Windows for every push and pull request.

## Releasing

Bump `version` in `package.json`, then:

```bash
npm publish --access public --tag alpha   # pre-releases
npm publish --access public               # stable
```
