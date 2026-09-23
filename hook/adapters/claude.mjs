// Claude Code adapter (proven against 2.1.274; see the PR for the fixture runs).
import { appendFileSync } from 'node:fs';

const EVENTS = { SessionStart: 'start', UserPromptSubmit: 'prompt', PostToolUse: 'tool', Stop: 'stop', StopFailure: 'stop_failure' };
const ATTENTION = new Set(['permission_prompt', 'elicitation_dialog']);

export function normalize(input, hint) {
  const native = input.hook_event_name || hint;
  let event = EVENTS[native];
  if (native === 'PreToolUse') event = input.tool_name === 'AskUserQuestion' ? 'blocked' : null;
  if (native === 'Notification') event = ATTENTION.has(input.notification_type) ? 'blocked' : null;
  // Native subagents (Agent tool) carry agent_id; they are not peers.
  if (!event || !input.session_id || input.agent_id) return null;
  const quiet = (input.background_tasks ?? []).length > 0 || (input.session_crons ?? []).length > 0;
  return { event, native, id: input.session_id, source: input.source, cwd: input.cwd, quiet };
}

export function wakeEndpoint(env) {
  return env.CLAUDE_CODE_MESSAGING_SOCKET ? { kind: 'uds', path: env.CLAUDE_CODE_MESSAGING_SOCKET } : { kind: 'pull' };
}

export function surface(env, tty) {
  if (tty) return env.ITERM_SESSION_ID ? 'iterm' : 'unknown';
  return String(env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('sdk') ? 'headless' : 'app';
}

// SPEC.md section 2: every later Bash call in the session sees CHATTR_SESSION.
export function bootstrap(id, env) {
  if (env.CLAUDE_ENV_FILE) appendFileSync(env.CLAUDE_ENV_FILE, `export CHATTR_SESSION=${id}\n`);
}

// Claude continues a Stop on non-error additionalContext; it writes terminalSequence itself.
export function render({ native, context, notify }) {
  const out = {};
  if (context) out.hookSpecificOutput = { hookEventName: native, additionalContext: context };
  if (notify?.tty) out.terminalSequence = '';
  return Object.keys(out).length ? out : null;
}
