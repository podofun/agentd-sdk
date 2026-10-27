// Compile-time checks for the public types. `npm test` runs `tsc` on this file; nothing here executes.
import type {
  AgentdClient,
  AgentdControl,
  ApprovalRequestsOptions,
  ApprovalRequest,
  ApprovalSetting,
  ErrorCode,
  JsonValue,
  NewSessionParams,
  RunParams,
  RunnerDelta,
  SessionMeta,
  Verdict,
} from '../../dist/index.js';

const never = (value: never): never => value;

export function describeDelta(delta: RunnerDelta): string {
  switch (delta.type) {
    case 'text_delta':
      return delta.text;
    case 'tool_call':
      return delta.name;
    case 'tool_result': {
      const input: JsonValue = delta.input;
      const output: JsonValue | undefined = delta.output;
      const error: string | undefined = delta.error;
      return `${delta.name} ${JSON.stringify(input)} ${JSON.stringify(output)} ${error}`;
    }
    case 'turn_end':
      return '';
    default:
      return never(delta);
  }
}

export function describeRequest(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'folder': {
      const folder: string = request.detail.folder;
      const tool: null = request.tool;
      return `${folder} ${tool}`;
    }
    case 'missing_grant':
    case 'confirm':
    case 'runner_action': {
      const tool: string | null = request.tool;
      const detail: JsonValue | undefined = request.detail;
      return `${request.action} ${tool} ${JSON.stringify(detail)} ${request.caller.interface}`;
    }
    default:
      return never(request);
  }
}

export async function useSessions(client: AgentdClient): Promise<number> {
  const params: NewSessionParams = { label: 'x', approval: 'nobody', cwd: '/work/app' };
  const meta: SessionMeta = await client.sessions.create(params);
  const renamed: SessionMeta = await client.sessions.rename(meta.id, null, { user: 'u' });
  const set: SessionMeta = await client.sessions.setApproval(renamed.id, 'human');
  const cleared: SessionMeta = await client.sessions.setApproval(set.id, null);
  const approval: ApprovalSetting | undefined = cleared.approval;
  const cwd: string | undefined = cleared.cwd;
  void approval;
  void cwd;
  return cleared.usage.input_tokens + cleared.usage.cache_creation_input_tokens;
}

export async function answer(control: AgentdControl): Promise<void> {
  const options: ApprovalRequestsOptions = { signal: AbortSignal.timeout(60_000) };
  for await (const request of control.approvals.requests(options)) {
    const verdict: Verdict = request.kind === 'folder' ? 'deny' : 'allow_once';
    const { resolved }: { resolved: number } = await control.approvals.resolve(request.id, verdict);
    void resolved;
  }
}

export const run: RunParams = { name: 'r', prompt: 'hi', approval: 'classifier', session_id: 's' };
export const codes: ErrorCode[] = [
  'approval_forbidden',
  'classifier_not_configured',
  'runner_turn_limit',
  'session_folder_not_allowed',
  'session_folder_denied',
];

// @ts-expect-error approval settings are a closed set
export const badRun: RunParams = { name: 'r', prompt: 'hi', approval: 'anyone' };

export async function badCalls(client: AgentdClient, control: AgentdControl): Promise<void> {
  // @ts-expect-error verdicts are a closed set
  await control.approvals.resolve(1, 'maybe');
  // @ts-expect-error rename needs a label or null, not undefined
  await client.sessions.rename('id');
}
