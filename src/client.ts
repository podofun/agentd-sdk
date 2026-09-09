import { Connection, toError, validateTimeout, type RequestOptions } from './connection.js';
import type {
  ActionResult,
  CallerIdentity,
  RunParams,
  RunnerComposition,
  RunnerDelta,
  RunnerOutcome,
  RunnerSummary,
  ServiceStatus,
  SkillDef,
  SkillSummary,
} from './protocol.js';
import { resolveWsUrl } from './url.js';

export interface ClientOptions {
  /** Where the daemon lives. A plain base URL like `http://agentd:7777` is enough; we add `/ws` for you. Defaults to the local daemon. */
  url?: string;
  /** The public token the daemon wrote at startup. Leave it out only if the daemon runs with `--no-auth`. */
  token?: string;
  /** How long to wait for the WebSocket handshake before giving up, in milliseconds. Defaults to 30 seconds. */
  connectTimeoutMs?: number;
  /** How long to wait for a reply once connected, in milliseconds. Defaults to 11 minutes, which comfortably covers the daemon's longest allowed run. */
  timeoutMs?: number;
}

export type CallOptions = RequestOptions & CallerIdentity;

/**
 * What you get back from `runners.stream`. Loop over it to receive deltas as they arrive,
 * then await `result` for the finished answer. If you break out of the loop early, we cancel the run for you.
 */
export interface RunnerStream extends AsyncIterable<RunnerDelta> {
  readonly result: Promise<RunnerOutcome>;
}

/** The daemon refuses any key it does not recognise, and `undefined` still serialises as a key. Strip those before sending. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Your handle on a running agent.d daemon.
 *
 * One client holds one WebSocket and shares it across every call you make, so feel free to fire
 * requests concurrently. The socket opens on your first request; call `connect()` if you would
 * rather fail fast at startup.
 */
export class AgentdClient {
  private readonly connection: Connection;

  constructor(options: ClientOptions = {}) {
    this.connection = new Connection({
      url: resolveWsUrl(options.url),
      token: options.token,
      connectTimeoutMs: validateTimeout(options.connectTimeoutMs ?? 30_000, 'connectTimeoutMs'),
      timeoutMs: validateTimeout(options.timeoutMs ?? 660_000, 'timeoutMs'),
    });
  }

  /** Connect right away instead of waiting for the first request. Handy for surfacing bad URLs or tokens at startup. */
  connect(): Promise<void> {
    return this.connection.connect();
  }

  /** Hang up. Anything still in flight rejects. Make a new client if you need to talk to the daemon again. */
  close(): void {
    this.connection.close();
  }

  /** Ask the daemon if it is alive. Resolves to the string `"ok"`. */
  health(options?: RequestOptions): Promise<'ok'> {
    return this.request('health', {}, options);
  }

  /** Escape hatch: send any protocol method by name and get the raw `result` back. Reach for the typed namespaces first. */
  request<T = unknown>(method: string, params: unknown = {}, options?: RequestOptions): Promise<T> {
    return this.connection.request<T>(method, params, options);
  }

  readonly tools = {
    /** Every action the daemon knows about, as `tool.action` names. */
    list: (options?: RequestOptions): Promise<string[]> => this.request('tools.list', {}, options),
  };

  readonly actions = {
    /** Run one action and get its return value plus how long the handler took. Pass `session` and `user` to tell Lua who is asking. */
    call: <T = unknown>(
      name: string,
      args?: unknown,
      options: CallOptions = {},
    ): Promise<ActionResult<T>> => {
      const { session, user, ...request } = options;
      return this.request('actions.call', compact({ name, args, session, user }), request);
    },
  };

  readonly runners = {
    /** Every runner the daemon has registered, with its model, skills, and allowed actions. */
    list: (options?: RequestOptions): Promise<RunnerSummary[]> => this.request('runners.list', {}, options),
    /** Everything the daemon knows about one runner, including the fully assembled system prompt. */
    inspect: (name: string, options?: RequestOptions): Promise<RunnerComposition> =>
      this.request('runners.inspect', { name }, options),
    /** Run a runner and wait for the whole answer. Aborting or timing out asks the daemon to stop the run too. */
    run: (params: RunParams, options?: RequestOptions): Promise<RunnerOutcome> =>
      this.connection.request('runners.run', compact({ ...params, stream: false }), {
        ...options,
        runner: true,
      }),
    /** Run a runner and watch the answer arrive. Iterate for deltas, then await `.result` for the finished outcome. */
    stream: (params: RunParams, options: RequestOptions = {}): RunnerStream =>
      this.openStream(params, options),
  };

  readonly skills = {
    /** Every skill the daemon has loaded. */
    list: (options?: RequestOptions): Promise<SkillSummary[]> => this.request('skills.list', {}, options),
    /** The full definition of one skill, including its system prompt body. */
    inspect: (name: string, options?: RequestOptions): Promise<SkillDef> =>
      this.request('skills.inspect', { name }, options),
  };

  readonly services = {
    /** Background services and whether each is running, stopped, or crashed. */
    list: (options?: RequestOptions): Promise<ServiceStatus[]> => this.request('services.list', {}, options),
  };

  private openStream(params: RunParams, options: RequestOptions): RunnerStream {
    const controller = new AbortController();
    const forward = () => controller.abort(options.signal!.reason);
    if (options.signal?.aborted) forward();
    else options.signal?.addEventListener('abort', forward, { once: true });

    const buffer: RunnerDelta[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };

    const result = this.connection
      .request<RunnerOutcome>('runners.run', compact({ ...params, stream: true }), {
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        runner: true,
        onDelta: delta => {
          buffer.push(delta);
          notify();
        },
      })
      .catch((error: unknown) => {
        failure = toError(error);
        throw error;
      })
      .finally(() => {
        options.signal?.removeEventListener('abort', forward);
        done = true;
        notify();
      });
    // Someone who only iterates never touches `result`, so swallow the rejection here.
    // The iterator rethrows the same error, so nothing is lost.
    result.catch(() => {});

    const iterator: AsyncIterator<RunnerDelta> = {
      async next() {
        while (true) {
          if (buffer.length) return { value: buffer.shift()!, done: false };
          if (done) {
            if (failure !== undefined) throw failure;
            return { value: undefined, done: true };
          }
          await new Promise<void>(resolve => {
            wake = resolve;
          });
        }
      },
      return() {
        if (!done) controller.abort(new DOMException('Runner stream closed by consumer', 'AbortError'));
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return { result, [Symbol.asyncIterator]: () => iterator };
  }
}
