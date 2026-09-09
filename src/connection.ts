import WebSocket from 'ws';
import { AgentdError } from './errors.js';
import { LIMITS, type ErrorFrame, type RunnerDelta } from './protocol.js';

export interface ConnectionOptions {
  url: URL;
  token?: string;
  connectTimeoutMs: number;
  timeoutMs: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Wait this long for a reply instead of the client default. */
  timeoutMs?: number;
}

export interface InternalRequestOptions extends RequestOptions {
  /** Set for runner requests so that giving up locally also tells the daemon to stop the run. */
  runner?: boolean;
  /** Called for each streaming delta that belongs to this request. Keep it quick and synchronous. */
  onDelta?: (delta: RunnerDelta) => void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  runner: boolean;
  onDelta?: (delta: RunnerDelta) => void;
}

const MAX_TIMEOUT = 2_147_483_647;

export function validateTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT) {
    throw new RangeError(`${label} must be an integer between 1 and ${MAX_TIMEOUT} milliseconds`);
  }
  return value;
}

/** Promises should reject with an Error. Abort reasons and thrown values can be anything, so normalise them. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function frameText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDelta(value: unknown): value is RunnerDelta {
  if (!isObject(value)) return false;
  switch (value.type) {
    case 'text_delta':
      return typeof value.text === 'string';
    case 'tool_call':
      return typeof value.name === 'string';
    case 'turn_end':
      return true;
    default:
      return false;
  }
}

function isErrorFrame(frame: Record<string, unknown>): frame is Record<string, unknown> & ErrorFrame {
  return frame.ok === false && typeof frame.error === 'string' && typeof frame.code === 'string';
}

/**
 * The socket underneath `AgentdClient`.
 *
 * Owns one WebSocket, hands every request a fresh id, and matches replies back to their
 * callers. Ids never get reused, because the daemon drops the connection if it sees a
 * duplicate while the first request is still running.
 */
export class Connection {
  private readonly options: ConnectionOptions;
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private rejectConnect?: (error: Error) => void;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(options: ConnectionOptions) {
    validateTimeout(options.connectTimeoutMs, 'connectTimeoutMs');
    validateTimeout(options.timeoutMs, 'timeoutMs');
    if (options.token !== undefined && (!options.token.trim() || /[\r\n]/.test(options.token))) {
      throw new TypeError('Invalid bearer token');
    }
    this.options = options;
  }

  /** Open the socket. Safe to call repeatedly; concurrent callers share the same handshake. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Connection is closed'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      this.rejectConnect = reject;
      const socket = new WebSocket(this.options.url, {
        headers: this.options.token === undefined ? {} : { Authorization: `Bearer ${this.options.token}` },
        handshakeTimeout: this.options.connectTimeoutMs,
        followRedirects: false,
        maxPayload: LIMITS.maxMessageBytes,
        perMessageDeflate: false,
      });
      this.socket = socket;
      const mine = () => this.socket === socket;
      socket.on('open', () => {
        this.rejectConnect = undefined;
        resolve();
      });
      socket.on('message', data => {
        if (mine()) this.receive(frameText(data));
      });
      socket.on('error', () => {
        if (mine()) this.disconnect(new Error('WebSocket connection failed'));
      });
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        if (mine()) this.disconnect(new Error(`WebSocket handshake rejected (HTTP ${response.statusCode})`));
      });
      socket.on('close', code => {
        if (mine()) this.disconnect(new Error(`WebSocket closed before response (code ${code})`));
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** Hang up for good. Every pending request rejects and the connection cannot be reopened. */
  close(): void {
    this.closed = true;
    this.disconnect(new Error('Connection is closed'));
  }

  async request<T>(method: string, params: unknown, options: InternalRequestOptions = {}): Promise<T> {
    if (typeof method !== 'string' || !method) throw new TypeError('An RPC method name is required');
    const timeout = validateTimeout(options.timeoutMs ?? this.options.timeoutMs, 'timeoutMs');
    options.signal?.throwIfAborted();
    const encodedParams = JSON.stringify(params ?? null);
    if (encodedParams === undefined) throw new TypeError('Params must be JSON serializable');
    // Check the size before we even connect. We do not know the id yet, so allow for a
    // 16-digit one plus the envelope punctuation; that is a safe over-estimate.
    if (
      Buffer.byteLength(encodedParams) + Buffer.byteLength(JSON.stringify(method)) + 40 >
      LIMITS.maxMessageBytes
    ) {
      throw new RangeError(`Request exceeds the daemon's ${LIMITS.maxMessageBytes} byte message limit`);
    }

    await this.awaitConnection(options.signal);
    options.signal?.throwIfAborted();
    if (this.closed) throw new Error('Connection is closed');
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not connected');
    if (this.pending.size >= LIMITS.maxInFlight) {
      throw new Error(`Client already has ${LIMITS.maxInFlight} in-flight requests`);
    }

    const id = this.nextId++;
    const frame = `{"id":${id},"method":${JSON.stringify(method)},"params":${encodedParams}}`;
    const runner = options.runner === true;

    return new Promise<T>((resolve, reject) => {
      const abort = () => this.settle(id, options.signal!.reason);
      const timer = setTimeout(
        () => this.settle(id, new Error(`Request timed out after ${timeout} ms`)),
        timeout,
      );
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        cleanup,
        runner,
        onDelta: options.onDelta,
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      socket.send(frame, error => {
        if (error && this.socket === socket) this.disconnect(new Error('WebSocket send failed'));
      });
    });
  }

  private async awaitConnection(signal?: AbortSignal): Promise<void> {
    if (!signal) return this.connect();
    let abort = () => {};
    try {
      await Promise.race([
        this.connect(),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(toError(signal.reason));
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private disconnect(error: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    this.rejectConnect?.(error);
    this.rejectConnect = undefined;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    socket?.terminate();
  }

  /** Give up on one request from our side. If it was a runner, also ask the daemon to stop it. */
  private settle(id: number, reason: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    pending.reject(toError(reason));
    if (pending.runner && this.socket?.readyState === WebSocket.OPEN) {
      // Fire and forget. The daemon acks with a frame we will ignore as an unknown id, and
      // cancels do not count toward the 32 in-flight limit, so no bookkeeping needed.
      this.socket.send(
        JSON.stringify({ id: this.nextId++, method: 'runners.cancel', params: { id } }),
        () => {},
      );
    }
  }

  private receive(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.disconnect(new Error('Invalid JSON from daemon'));
      return;
    }
    if (!isObject(frame) || !Number.isSafeInteger(frame.id)) {
      this.disconnect(new Error('Invalid frame from daemon: missing id'));
      return;
    }
    const id = frame.id as number;
    const pending = this.pending.get(id);

    if (frame.event === 'runner.delta') {
      if (!isDelta(frame.delta)) {
        this.disconnect(new Error('Invalid runner delta from daemon'));
        return;
      }
      if (!pending) return;
      try {
        pending.onDelta?.(frame.delta);
      } catch (error) {
        this.settle(id, error);
      }
      return;
    }

    const success = frame.ok === true && Object.hasOwn(frame, 'result');
    if (!success && !isErrorFrame(frame)) {
      this.disconnect(new Error('Invalid response envelope from daemon'));
      return;
    }
    // A reply for an id we no longer track is normal: either we gave up on it already,
    // or it is the ack for a cancel we sent. Either way there is nobody to tell.
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (success) pending.resolve(frame.result);
    else pending.reject(new AgentdError(frame as unknown as ErrorFrame));
  }
}
