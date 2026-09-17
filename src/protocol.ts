/**
 * The shapes that travel over the wire between you and agent.d 0.10.0-alpha.
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
  | 'session_not_found'
  | 'session_busy'
  | 'session_label_taken'
  | 'session_store'
  | 'sessions_unavailable'
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
 * What you send to run a runner. Give it a `prompt`, a `messages` history you manage yourself,
 * or a `session_id` so the daemon manages the history for you. `messages` and `session_id` are exclusive.
 * The daemon is strict about keys here, so unknown fields fail the call with `bad_params`.
 */
export interface RunParams extends CallerIdentity {
  name: string;
  /** The user's message. Required unless you pass history; goes after the history if you pass both. Always required with `session_id`. */
  prompt?: string;
  /** Prior conversation, up to 256 messages, when you keep history on your side. Cannot be combined with `session_id`. */
  messages?: Message[];
  /** A session from `sessions.create`. The daemon loads its turns as history and stores this exchange afterwards. */
  session_id?: string;
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
  /** Echoes the session this run was appended to. Absent for runs without one. */
  session_id?: string;
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

// ---- sessions ----

/**
 * `sessions.create`. The session is owned by the interface your token belongs to, and by `user`
 * when you pass one: from then on only calls carrying that same `user` can see it.
 */
export interface NewSessionParams extends CallerIdentity {
  /** Your own id for the session: a chat id, a ticket number. Unique per interface; reuse fails with `session_label_taken`. */
  label?: string;
  /** Which runner this session is for. Informational only; any runner can run against any session. */
  runner?: string;
}

/** `sessions.list`. */
export interface ListSessionsParams extends CallerIdentity {
  /** Defaults to 50 on the daemon, caps at 500. */
  limit?: number;
}

/** Everything about a session except its turns. */
export interface SessionMeta {
  /** Daemon-minted uuid. This is what `RunParams.session_id` takes. */
  id: string;
  /** `interface:<name>` of the token that created it, or `service:<name>` for sessions Lua services create. */
  owner: string;
  label?: string;
  /** The end user the creating call vouched for. Only calls carrying the same `user` can see the session. */
  user?: string;
  runner?: string;
  /** Unix seconds. */
  created_at: number;
  updated_at: number;
  /** Turns currently stored, after any compaction. */
  turn_count: number;
  /** Next sequence number the daemon will assign; never reused after a compaction. */
  next_seq: number;
  /** How many times old turns were folded into a summary. */
  compactions: number;
}

export interface Session extends SessionMeta {
  /** The stored conversation, oldest first. After a compaction the first turn is a `[Conversation summary]`. */
  turns: Message[];
}

/** Look a session up by the daemon's `id` or by the `label` you gave it, as the given caller. */
export type SessionRef = CallerIdentity & ({ id: string; label?: never } | { label: string; id?: never });

export interface DeleteResult {
  /** False when there was nothing to delete. */
  deleted: boolean;
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
