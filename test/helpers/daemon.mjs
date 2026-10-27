import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeReady } from '../../dist/index.js';

export const DAEMON_TOKEN = 'live-daemon-token';
export const ADMIN_TOKEN = 'live-admin-token';
export const BOT_TOKEN = 'live-bot-token';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/**
 * Start a real agentd in a throwaway home: its own config, init.lua, grants.toml, trace file and XDG
 * folders, so it never touches the user's own daemon, keyring or memory database.
 *
 * `config` is appended to an otherwise empty config.toml. Secrets come from `AGENTD_SECRET_<KEY>`.
 * `port` picks the first port to try; tests use it to check the retry.
 */
export async function startDaemon(
  t,
  bin,
  { init, grants = '', config = '', secrets = {}, port: requestedPort },
) {
  const home = await mkdtemp(join(tmpdir(), 'agentd-sdk-live-'));
  const dirs = Object.fromEntries(
    ['config', 'data', 'state', 'cache', 'work'].map(name => [name, join(home, name)]),
  );
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const files = {
    config: join(dirs.config, 'config.toml'),
    init: join(dirs.config, 'init.lua'),
    grants: join(dirs.config, 'grants.toml'),
    trace: join(home, 'trace.jsonl'),
  };
  await writeFile(files.config, config);
  await writeFile(files.init, init);
  await writeFile(files.grants, grants);

  // Keep the parent's environment so the binary runs anywhere, minus anything agentd would pick up.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTD_')),
  );
  const env = {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
  };
  for (const [key, value] of Object.entries(secrets)) env[`AGENTD_SECRET_${key.toUpperCase()}`] = value;

  let current;
  t.after(async () => {
    await current?.stop();
    await rm(home, { recursive: true, force: true });
  });

  // The free port can be taken between our check and the daemon's bind, so try once more on a new one.
  let attempts = 0;
  let url;
  while (true) {
    attempts++;
    const port = attempts === 1 && requestedPort ? requestedPort : await freePort();
    url = `http://127.0.0.1:${port}`;
    current = launch(bin, files, dirs.work, env, port);
    const outcome = await current.ready(url);
    if (outcome === 'ready') break;
    if (outcome === 'port taken' && attempts === 1) continue;
    throw new Error(`agentd did not start (${outcome}):\n${current.output()}`);
  }
  return {
    url,
    attempts,
    home,
    work: dirs.work,
    output: current.output,
    trace: () => readFile(files.trace, 'utf8').catch(() => ''),
    grants: () => readFile(files.grants, 'utf8'),
  };
}

/** Spawn one daemon process on `port` and report whether it became ready, lost the port, or failed. */
function launch(bin, files, cwd, env, port) {
  const child = spawn(
    bin,
    [
      '-c',
      files.config,
      '-i',
      files.init,
      '-g',
      files.grants,
      '--trace',
      files.trace,
      '-a',
      `127.0.0.1:${port}`,
      '--token',
      DAEMON_TOKEN,
      '--admin-token',
      ADMIN_TOKEN,
      '--approval-timeout',
      '5000',
      '--secrets',
      'env',
      '--log',
      'warn',
    ],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  const exited = once(child, 'exit');
  return {
    output: () => output,
    async ready(url) {
      const deadline = Date.now() + 15_000;
      while (true) {
        if (child.exitCode !== null) {
          await exited;
          return /address already in use/i.test(output) ? 'port taken' : `exit code ${child.exitCode}`;
        }
        if (await probeReady(url, { timeoutMs: 500 }).catch(() => false)) return 'ready';
        if (Date.now() > deadline) return 'not ready after 15 seconds';
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}
