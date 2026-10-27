import {
  Connection,
  toError,
  validateTimeout,
  validateWaitTimeout,
  type RequestOptions,
} from './connection.js';
import type { ApprovalRequest, ResolveResult, SubscribeResult, Verdict } from './protocol.js';
import { resolveControlUrl } from './url.js';

export interface ControlOptions {
  /** Where the daemon lives, the same base URL you give `AgentdClient`. We add `/control` for you. Defaults to the local daemon. */
  url?: string;
  /** The daemon's admin token, never the public one. Leave it out only if the daemon runs with `--no-auth`. */
  adminToken?: string;
  /** How long to wait for the WebSocket handshake, in milliseconds. Defaults to 30 seconds. */
  connectTimeoutMs?: number;
  /** How long to wait for a reply to `subscribe` or `resolve`, in milliseconds. Defaults to 30 seconds; `0` waits as long as it takes. */
  timeoutMs?: number;
}

export interface ApprovalRequestsOptions {
  /** Stop listening when this aborts. The loop ends quietly. */
  signal?: AbortSignal;
}

interface Listener {
  push: (request: ApprovalRequest) => void;
  end: (error?: Error) => void;
}

const KNOWN_KINDS = new Set(['missing_grant', 'confirm', 'runner_action', 'folder']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * Read an `approval.request` push. Returns undefined for a kind this SDK does not know yet, so a newer
 * daemon cannot break you; nobody answers it, and the daemon refuses it when its approval timeout runs out.
 */
function parseApprovalRequest(frame: Record<string, unknown>): ApprovalRequest | undefined {
  const req = frame.req;
  const valid =
    isObject(req) &&
    Number.isSafeInteger(req.id) &&
    typeof req.kind === 'string' &&
    typeof req.action === 'string' &&
    typeof req.reason === 'string' &&
    isStringArray(req.requires) &&
    isStringArray(req.missing) &&
    isObject(req.caller);
  if (!valid) throw new Error('Invalid approval request from daemon');
  if (!KNOWN_KINDS.has(req.kind as string)) return undefined;
  if (req.kind === 'folder' && !(isObject(req.detail) && typeof req.detail.folder === 'string')) {
    throw new Error('Invalid folder approval request from daemon');
  }
  return req as unknown as ApprovalRequest;
}

/**
 * Your handle on the daemon's approval plane, `/control`.
 *
 * When a run reaches for something it was not granted and its approval setting is `human`, the daemon
 * asks every connected approver. Connecting with the admin token is what makes you one: there is no
 * separate sign-up step. Listen with `approvals.requests()`, then answer each with `approvals.resolve`.
 * A question nobody answers is refused once the daemon's approval timeout runs out.
 */
export class AgentdControl {
  readonly #connection: Connection;
  readonly #listeners = new Set<Listener>();
  #closed = false;
  /** Settles once the daemon has acknowledged a subscription on the current socket. Reset when it drops. */
  #subscribed?: Promise<void>;

  constructor(options: ControlOptions = {}) {
    this.#connection = new Connection({
      url: resolveControlUrl(options.url),
      token: options.adminToken,
      connectTimeoutMs: validateTimeout(options.connectTimeoutMs ?? 30_000, 'connectTimeoutMs'),
      timeoutMs: validateWaitTimeout(options.timeoutMs ?? 30_000, 'timeoutMs'),
      onEvent: (event, frame) => {
        if (event !== 'approval.request') return;
        const request = parseApprovalRequest(frame);
        if (request) for (const listener of this.#listeners) listener.push(request);
      },
      onDisconnect: error => {
        this.#subscribed = undefined;
        for (const listener of [...this.#listeners]) listener.end(this.#closed ? undefined : error);
      },
    });
  }

  /**
   * Connect now and wait until the daemon has acknowledged the subscription, so every question asked after
   * this resolves reaches you. Handy for failing fast on a bad URL or token. Safe to call repeatedly.
   */
  connect(): Promise<void> {
    if (!this.#subscribed) {
      const subscribed = this.#connection
        .connect()
        .then(() => this.#connection.request('approvals.subscribe', {}))
        .then(() => {});
      subscribed.catch(() => {
        if (this.#subscribed === subscribed) this.#subscribed = undefined;
      });
      this.#subscribed = subscribed;
    }
    return this.#subscribed;
  }

  /** Hang up. Every `requests()` loop ends quietly and pending calls reject. */
  close(): void {
    this.#closed = true;
    this.#connection.close();
    for (const listener of [...this.#listeners]) listener.end();
  }

  readonly approvals = {
    /** Confirm you are subscribed. Connecting already subscribes you, so this is only an acknowledgement. */
    subscribe: (options?: RequestOptions): Promise<SubscribeResult> =>
      this.#connection.request('approvals.subscribe', {}, options),
    /**
     * Answer one approval request. `allow_once` lets this one call through, `allow_forever` also writes
     * the grant (or the trusted folder) to `grants.toml`, and `deny` refuses it. Resolving an id that is
     * no longer pending is harmless.
     */
    resolve: (requestId: number, verdict: Verdict, options?: RequestOptions): Promise<ResolveResult> =>
      this.#connection.request('approvals.resolve', { request_id: requestId, verdict }, options),
    /**
     * Every approval request the daemon sends from now on, as they arrive. Connects and subscribes if needed. The loop
     * ends when you break out, abort the signal or close the control client, and throws if the
     * connection drops.
     */
    requests: (options: ApprovalRequestsOptions = {}): AsyncIterable<ApprovalRequest> => ({
      [Symbol.asyncIterator]: () => this.#listen(options),
    }),
  };

  #listen(options: ApprovalRequestsOptions): AsyncIterator<ApprovalRequest> {
    const buffer: ApprovalRequest[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const stop = () => listener.end();
    const listener: Listener = {
      push: request => {
        buffer.push(request);
        notify();
      },
      end: error => {
        if (done) return;
        done = true;
        failure = error;
        this.#listeners.delete(listener);
        options.signal?.removeEventListener('abort', stop);
        notify();
      },
    };

    if (this.#closed) done = true;
    else if (options.signal?.aborted) done = true;
    else {
      this.#listeners.add(listener);
      options.signal?.addEventListener('abort', stop, { once: true });
      this.connect().catch((error: unknown) => listener.end(toError(error)));
    }

    return {
      next: async () => {
        while (true) {
          if (buffer.length) return { value: buffer.shift()!, done: false };
          if (done) {
            if (failure !== undefined) {
              const error = failure;
              failure = undefined;
              throw error;
            }
            return { value: undefined, done: true };
          }
          await new Promise<void>(resolve => {
            wake = resolve;
          });
        }
      },
      return: () => {
        listener.end();
        buffer.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
