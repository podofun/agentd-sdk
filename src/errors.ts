import type { ErrorCode, ErrorFrame } from './protocol.js';

/**
 * The daemon said no, and told us why.
 *
 * `code` is the part to branch on; `tip` is the daemon's own hint about what to do next.
 * Network trouble, timeouts, and aborts are ordinary `Error`s, not this class.
 */
export class AgentdError extends Error {
  readonly code: ErrorCode;
  readonly tip?: string;
  readonly trace: string[];
  readonly providerStatus?: number;
  readonly retryAfterMs?: number;
  /** How long the action ran before it failed. Only actions report this. */
  readonly durationMs?: number;

  constructor(frame: ErrorFrame) {
    super(frame.error);
    this.name = 'AgentdError';
    this.code = frame.code;
    this.tip = frame.tip;
    this.trace = frame.trace ?? [];
    this.providerStatus = frame.provider_status;
    this.retryAfterMs = frame.retry_after_ms;
    this.durationMs = frame.result?.duration_ms;
  }
}

export function isAgentdError(value: unknown, code?: ErrorCode): value is AgentdError {
  return value instanceof AgentdError && (code === undefined || value.code === code);
}
