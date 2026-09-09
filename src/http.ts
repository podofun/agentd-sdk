import { validateTimeout } from './connection.js';
import { resolveHttpUrl } from './url.js';

export interface ProbeOptions {
  signal?: AbortSignal;
  /** How long to wait for the probe, in milliseconds. Defaults to 5 seconds. */
  timeoutMs?: number;
}

async function probe(base: string | undefined, path: string, options: ProbeOptions): Promise<boolean> {
  const timeout = validateTimeout(options.timeoutMs ?? 5_000, 'timeoutMs');
  const url = resolveHttpUrl(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  const signals = [AbortSignal.timeout(timeout)];
  if (options.signal) signals.push(options.signal);
  const response = await fetch(url, { signal: AbortSignal.any(signals), redirect: 'manual' });
  await response.body?.cancel();
  if (response.ok) return true;
  if (response.status === 503) return false;
  throw new Error(`Daemon ${path} probe failed (HTTP ${response.status})`);
}

/** Is the daemon process up? True even while it is shutting down gracefully. No token needed. */
export function probeHealth(url?: string, options: ProbeOptions = {}): Promise<boolean> {
  return probe(url, '/health', options);
}

/** Will the daemon accept new work right now? False while it drains before shutdown. Use this for readiness checks. */
export function probeReady(url?: string, options: ProbeOptions = {}): Promise<boolean> {
  return probe(url, '/ready', options);
}
