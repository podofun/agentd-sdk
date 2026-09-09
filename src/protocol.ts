/**
 * The shapes that travel over the wire between you and agent.d 0.8.3-alpha.
 *
 * These mirror the daemon's Rust structs field for field, snake_case included, so what you
 * see here is exactly what the daemon sends and expects. Treat this file as the protocol reference.
 */

/**
 * Every error code the daemon can send today. The `string & {}` at the end means a newer daemon
 * can introduce a code without breaking your build, while autocomplete still offers the known ones.
 */
export type ErrorCode =
  | 'invalid_envelope'
  | 'unknown_method'
  | 'bad_params'
  | 'busy'
  | 'cancelled'
  | 'slow_consumer'
  | 'timeout'
  | 'not_found'
  | 'denied'
  | 'needs_confirmation'
  | 'lua_error'
  | 'invocation_failed'
  | 'runner_not_found'
  | 'unknown_skill'
  | 'no_provider'
  | 'provider_misconfigured'
  | 'provider_upstream'
  | 'compose_failed'
  | 'serialize_failed'
  | (string & {});

export interface RequestFrame {
  id: number;
  method: string;
  params?: unknown;
}

export interface SuccessFrame<T = unknown> {
  id: number;
  ok: true;
  result: T;
}

export interface ErrorFrame {
  id: number;
  ok: false;
  code: ErrorCode;
  error: string;
  tip?: string;
  /** Where a Lua script blew up, innermost frame first. Only present when the failure came from a script. */
  trace?: string[];
  /** The HTTP status the AI provider answered with, when that is what went wrong. */
  provider_status?: number;
  /** How long the provider asked us to wait, in milliseconds. Only present if it sent a numeric Retry-After. */
  retry_after_ms?: number;
  /** Even a failed action tells you how long it ran. Look for `result.duration_ms`. */
  result?: { duration_ms?: number };
}

export type ResponseFrame<T = unknown> = SuccessFrame<T> | ErrorFrame;

export type RunnerDelta =
  { type: 'text_delta'; text: string } | { type: 'tool_call'; name: string } | { type: 'turn_end' };

export interface DeltaFrame {
  event: 'runner.delta';
  id: number;
  delta: RunnerDelta;
}

export type ServerFrame = ResponseFrame | DeltaFrame;

// ---- actions.call ----

export interface CallerIdentity {
  /** Who this request is on behalf of. Overrides the connection's automatic `ws-<n>` session id, which is useful when you bridge chats from elsewhere. */
  session?: string;
  /** An end-user id you vouch for. The daemon passes it through to Lua without checking it. */
  user?: string;
}

export interface ActionCallParams extends CallerIdentity {
  /** The action to run, as `tool.action`. */
  name: string;
  /** Whatever the handler expects. Any JSON value works; leave it out and the handler sees `null`. */
  args?: unknown;
}

export interface ActionResult<T = unknown> {
  result: T;
  duration_ms: number;
}

// ---- runners ----

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Must be a JSON object, even if empty. The daemon rejects anything else. */
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  /** Tool calls the assistant asked for in this turn. Only assistant messages may carry these. */
  tool_calls?: ToolCall[];
  /** For `tool` messages: which tool call this answers. Every call needs exactly one answer before the conversation moves on. */
  tool_call_id?: string;
}

/**
 * What you send to run a runner. Give it a `prompt`, a `messages` history, or both.
 * The daemon is strict about keys here, so unknown fields fail the call with `bad_params`.
 */
export interface RunParams extends CallerIdentity {
  name: string;
  /** The user's message. Required unless you pass history; goes after the history if you pass both. */
  prompt?: string;
  /** Prior conversation, up to 256 messages. The daemon keeps no history of its own, so send it every time. */
  messages?: Message[];
  /** Extra instructions tacked onto the runner's own system prompt for this call. */
  system?: string;
  /** Use a different model just this once. The runner still needs a grant for that model's provider. */
  model?: string;
  /** Cap on output tokens, 1 to 32768. Not every provider honours it. */
  max_tokens?: number;
  /** How long the daemon lets the whole run take, in milliseconds. 1 to 600000; defaults to two minutes. */
  timeout_ms?: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface RunnerOutcome {
  text: string;
  provider: string;
  model: string | null;
  stop_reason: string | null;
  /** Token counts for the run. Missing if any model turn failed to report usage, rather than padded with zeros. */
  usage?: Usage;
}

export interface RunnerSummary {
  name: string;
  model: string | null;
  skills: string[];
  allowed_actions: string[];
}

export interface RunnerComposition extends RunnerSummary {
  /** The complete system prompt the model will see, with skills folded in. */
  system: string;
}

export interface CancelResult {
  /** True if the daemon delivered the cancel. False if the run had already finished, never existed, or was already being cancelled. */
  cancelled: boolean;
}

// ---- skills / services ----

export interface SkillSummary {
  name: string;
  description: string | null;
  actions: string[];
}

export interface SkillDef extends SkillSummary {
  /** The Markdown body that becomes part of the system prompt. Can be empty. */
  system: string;
  /** Which file the skill came from, for your own debugging. Null when it was defined inline in Lua. */
  source: string | null;
}

export type ServiceState = 'pending' | 'running' | 'stopped' | 'crashed';

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  last_error: string | null;
}

/** Hard limits the daemon enforces. The client checks the first two before sending so you get a clear error instead of a dropped socket. */
export const LIMITS = {
  /** Largest message either side may send, in bytes. */
  maxMessageBytes: 1_100_000,
  /** How many requests one connection may have waiting at once. */
  maxInFlight: 32,
  /** Longest `timeout_ms` a run may ask for. */
  maxRunTimeoutMs: 600_000,
} as const;
