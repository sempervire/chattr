// Codex adapter (proven against codex-cli 0.154.0; see the PR for the fixture runs).
import { writeFileSync } from 'node:fs';

const EVENTS = { SessionStart: 'start', UserPromptSubmit: 'prompt', PostToolUse: 'tool', Stop: 'stop', PermissionRequest: 'blocked', Interrupt: 'interrupt' };
const ASKS = /^request_user_input(_async)?$/;

export function normalize(input, hint) {
  const native = input.hook_event_name || hint;
  let event = EVENTS[native];
  if (native === 'PreToolUse') event = ASKS.test(input.tool_name ?? '') ? 'blocked' : null;
  // Subagent threads carry agent_id; they are not peers.
  if (!event || !input.session_id || input.agent_id) return null;
  return { event, native, id: input.session_id, source: input.source, cwd: input.cwd, quiet: false };
}

// Codex hooks get session_id in the payload; CODEX_THREAD_ID is not in the hook env (WAKE.md).
export function wakeEndpoint(env, id) {
  return { kind: 'codex-queue', thread: id };
}

export function surface(env, tty) {
  if (tty) return env.ITERM_SESSION_ID ? 'iterm' : 'unknown';
  return 'app';
}

export function bootstrap() {}

// Codex's Stop output schema has no hookSpecificOutput: a continue is decision "block" with
// the text as reason, and Codex re-prompts with it. Interrupt output accepts only systemMessage.
export function render({ native, context, notify }) {
  if (notify?.tty) {
    try { writeFileSync(`/dev/${notify.tty}`, ''); } catch {}
  }
  if (!context || native === 'Interrupt') return null;
  if (native === 'Stop') return { decision: 'block', reason: context };
  return { hookSpecificOutput: { hookEventName: native, additionalContext: context } };
}
