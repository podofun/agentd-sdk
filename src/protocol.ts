/**
 * The shapes that travel over the wire between you and agent.d, as of the 0.10 alpha protocol.
 * A few fields need a newer daemon than the first 0.10 alpha; their comments say so.
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
  | 'session_folder_not_allowed'
  | 'session_folder_denied'
  | 'runner_turn_limit'
  | 'approval_forbidden'
  | 'classifier_not_configured'
  | 'invalid'
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

/** Any value JSON can carry. Used where the daemon passes data through without a fixed shape. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A chunk of the assistant's answer, in order. */
export interface TextDelta {
  type: 'text_delta';
  text: string;
}

/** The model asked for a tool. Sent as soon as the name is known, before the call runs. */
export interface ToolCallDelta {
  type: 'tool_call';
  /** The action's registered name, such as `git.status`. */
  name: string;
}

/**
 * A tool call finished. Any secret the run read is replaced by `<secret name>` in both
 * `input` and `output`, so this is safe to show to the person watching the run.
 */
export interface ToolResultDelta {
  type: 'tool_result';
  name: string;
  /** The arguments the model passed. */
  input: JsonValue;
  /** What the action returned. Absent when the call failed or returned nothing. */
  output?: JsonValue;
  /** Why the call failed. Only present on failure. */
  error?: string;
}

/** One model turn ended. The runner may start another after running tools. */
export interface TurnEndDelta {
  type: 'turn_end';
}

/** One streaming update from `runners.stream`. Switch on `type`. */
export type RunnerDelta = TextDelta | ToolCallDelta | ToolResultDelta | TurnEndDelta;

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

/**
 * Who answers the questions a run raises when it reaches for something it was not granted.
 * `human` sends them to an approver on `/control`, `classifier` lets the runner named in
 * `[approval].classifier` decide (falling back to a human when unsure), and `nobody` refuses
 * without asking. From strictest to loosest: `nobody`, `human`, `classifier`.
 */
export type ApprovalSetting = 'human' | 'classifier' | 'nobody';

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
  /**
   * How long the daemon lets the whole run take, in milliseconds, 1 to 600000. A run without `session_id`
   * defaults to two minutes. A session run has no deadline unless you set one, and no turn limit either.
   */
  timeout_ms?: number;
  /**
   * Who answers this run's questions. You may always pick something stricter than the runner and session
   * allow. Something looser fails with `approval_forbidden` unless you connected with the admin token.
   */
  approval?: ApprovalSetting;
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
  /** Who answers questions for runs in this session. `classifier` fails with `classifier_not_configured` when the daemon has none. */
  approval?: ApprovalSetting;
  /**
   * The absolute folder this session's runs work in. Needs a daemon with session folders; on an older one
   * `sessions.create` rejects rather than quietly ignoring it. Only the daemon token or an admin connection may set it,
   * and the daemon asks an approver once before trusting a folder it does not know. A refusal fails with
   * `session_folder_denied`; a folder that is not allowed at all fails with `session_folder_not_allowed`.
   */
  cwd?: string;
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
  /** Tokens every run in this session has used so far. Sessions older than this field count from zero. */
  usage: Usage;
  /** Who answers questions for runs in this session, when it was set. */
  approval?: ApprovalSetting;
  /** The real, absolute folder this session's runs work in, when one was chosen and trusted. */
  cwd?: string;
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

// ---- /control: approvals ----

/** An approver's answer to an `ApprovalRequest`. */
export type Verdict = 'allow_once' | 'allow_forever' | 'deny';

/** Who made the call that needs approving, as the daemon saw it. */
export interface Caller {
  runner: string | null;
  /** `ws` for the daemon token, or the name of the interface whose token the client used. */
  interface: string | null;
  service: string | null;
  /** The connection's `ws-<n>` id, or the `session` the client passed. */
  session: string | null;
  user: string | null;
  /** Shared by everything one top-level request set off. */
  execution?: string;
  run_id?: string;
  /** The chat session the run belongs to. */
  session_id?: string;
  /** Who answers this run's questions. */
  approval?: ApprovalSetting;
}

interface ApprovalRequestBase {
  /** Echo this back as `requestId` in `approvals.resolve`. */
  id: number;
  /** A sentence explaining why the daemon is asking. */
  reason: string;
  caller: Caller;
  /** Every permission the call needs. */
  requires: string[];
  /** The ones not granted yet. `allow_forever` adds these to `grants.toml`. */
  missing: string[];
  /** The run that asks, when the call belongs to one. */
  run_id?: string;
  /** The chat session of that run, when it has one. */
  session_id?: string;
  /** Show this before letting someone pick `allow_forever`, for example when the program is an interpreter. */
  warning?: string;
}

/** A tool or runner wants to do something it was not granted, or an action marked `confirm` is about to run. */
export interface ActionApprovalRequest extends ApprovalRequestBase {
  /**
   * `missing_grant`: the tool lacks permissions. `confirm`: the action always asks.
   * `runner_action`: the runner called an action outside its `allowed_actions`.
   */
  kind: 'missing_grant' | 'confirm' | 'runner_action';
  /** The action, as `tool.action`. */
  action: string;
  tool: string | null;
  /** What the call does: its arguments, or a command's `argv` and `cwd`. Secrets appear as `<secret name>`. */
  detail?: JsonValue;
}

/** A client asked to start a chat session in a folder the user has not trusted yet. `allow_forever` trusts it for good. */
export interface FolderApprovalRequest extends ApprovalRequestBase {
  kind: 'folder';
  /** The folder's real, absolute path. */
  action: string;
  tool: null;
  detail: { folder: string };
}

/** A question the daemon pushes to every connected approver. Switch on `kind`. */
export type ApprovalRequest = ActionApprovalRequest | FolderApprovalRequest;

export type ApprovalKind = ApprovalRequest['kind'];

export interface SubscribeResult {
  subscribed: true;
}

export interface ResolveResult {
  /** The request id the verdict was delivered for. */
  resolved: number;
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
