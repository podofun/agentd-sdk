# Contributing

Thanks for helping with the SDK. Install the dependencies, then run the linter and the tests:

```bash
npm ci
npm run lint
npm test
```

`npm test` needs no agent.d install. It also checks that the public types still compile for code that uses them.

## Testing against a real daemon

Some tests start a real agent.d daemon. They run when you point `AGENTD_BIN` at an `agentd` binary:

```bash
AGENTD_BIN=/path/to/agentd npm test
```

These tests start their own daemon on a free port, with its own settings, and leave your own daemon and its data alone. They need no model provider or API key. To include the session folder tests, set `AGENTD_CWD_BIN` to the same binary.

To run a smaller check against a daemon you already have running, set `AGENTD_TEST_URL` and `AGENTD_TEST_TOKEN` instead.

Every push and pull request runs the linter and the tests on Linux, macOS and Windows.

## Releasing

Set the new `version` in `package.json`, then publish:

```bash
npm publish --access public --tag alpha   # pre-releases
npm publish --access public               # stable releases
```
