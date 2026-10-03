// Fixture runs of `chattr hook` per CLI event. Each test has its own CHATTR_DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { join, main, open, readPidStart } from '../../chattr.mjs';
import { wakeSession } from '../../wake.mjs';
import { agentPid, formatBatch } from '../index.mjs';

const CLI = fileURLToPath(new URL('../../chattr.mjs', import.meta.url));
const REPO = path.dirname(CLI);
const PID_START = readPidStart(process.pid);

function bus() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chattr-hook-'));
  const file = path.join(dir, 'bridge.db');
  const db = open(file);
  const env = { PATH: process.env.PATH, HOME: dir, CHATTR_DB: file, CHATTR_AGENT_PID: String(process.pid) };
  const run = (kind, payload, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', payload.hook_event_name, '--agent', kind], { input: JSON.stringify({ cwd: REPO, ...payload }), encoding: 'utf8', env: { ...env, ...extraEnv } });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    assert.ok(lines.length <= 1, `one outcome per event, got ${lines.length}`);
    return lines.length ? JSON.parse(lines[0]) : null;
  };
  const enroll = (id, kind = 'claude', opts = {}) => join(db, { id, kind, pid: process.pid, pidStart: PID_START, cwd: REPO, ...opts });
  const send = async (from, to, body, type = 'send') => (await main([type, to, body], { CHATTR_DB: file, CHATTR_SESSION: from })).output.message.uuid;
  const session = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  const delivery = (uuid, id) => db.prepare('SELECT * FROM deliveries WHERE message_uuid = ? AND session_id = ?').get(uuid, id);
  return { dir, file, db, env, run, enroll, send, session, delivery };
}

const stop = (id, extra = {}) => ({ hook_event_name: 'Stop', session_id: id, ...extra });
const prompt = (id) => ({ hook_event_name: 'UserPromptSubmit', session_id: id, prompt: 'hi' });

test('Claude Stop: one additionalContext outcome, batch continued, status stays working, next stop acks', async () => {
  const b = bus();
  b.enroll('A');
  b.enroll('P');
  const uuid = await b.send('P', 'A', 'hello A');
  const out = b.run('claude', stop('A'));
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`\\[msg ${uuid}\\] from P:\\nhello A`));
  assert.equal(out.decision, undefined);
  assert.equal(b.session('A').status, 'working');
  const d = b.delivery(uuid, 'A');
  assert.ok(d.batch);
  assert.equal(b.db.prepare('SELECT continued FROM batches WHERE id = ?').get(d.batch).continued, 1);
  assert.equal(b.run('claude', stop('A')), null);
  assert.ok(b.delivery(uuid, 'A').acked_at);
  assert.equal(b.session('A').status, 'idle');
});

test('Codex Stop: decision block with the batch as reason; Interrupt marks idle with no output', async () => {
  const b = bus();
  b.enroll('T', 'codex');
  b.enroll('P');
  await b.send('P', 'T', 'hello T');
  const out = b.run('codex', stop('T', { stop_hook_active: false, turn_id: 'x' }));
  assert.deepEqual(Object.keys(out).sort(), ['decision', 'reason']);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /hello T/);
  assert.equal(b.run('codex', { hook_event_name: 'Interrupt', session_id: 'T', turn_id: 'x' }), null);
  assert.equal(b.session('T').status, 'idle');
});

test('continuation cap: two continues since the human prompt, a generated prompt does not reset, the third stays pending', async () => {
  const b = bus();
  b.enroll('A', 'codex');
  b.enroll('P');
  await b.send('P', 'A', 'one');
  assert.equal(b.run('codex', stop('A')).decision, 'block');
  b.run('codex', prompt('A')); // Codex re-prompts on block: generated, keeps the count
  await b.send('P', 'A', 'two');
  assert.equal(b.run('codex', stop('A')).decision, 'block');
  const third = await b.send('P', 'A', 'three');
  assert.equal(b.run('codex', stop('A')), null);
  assert.equal(b.session('A').status, 'idle');
  assert.equal(b.delivery(third, 'A').batch, null);
  // A human prompt after the real stop resets the count and delivers what waited.
  const out = b.run('codex', prompt('A'));
  assert.match(out.hookSpecificOutput.additionalContext, /three/);
  await b.send('P', 'A', 'four');
  assert.equal(b.run('codex', stop('A')).decision, 'block');
});

test('notify: BEL sequence on a real stop with a tty; suppressed on continue, without a tty, and with background tasks', async () => {
  const b = bus();
  b.enroll('A', 'claude', { tty: 'ttys999' });
  b.enroll('N', 'claude', { tty: null });
  b.enroll('P');
  assert.deepEqual(b.run('claude', stop('A')), { terminalSequence: '\u0007' });
  assert.equal(b.run('claude', stop('A', { background_tasks: [{ id: 1 }] })), null);
  assert.equal(b.run('claude', stop('N')), null);
  await b.send('P', 'A', 'x');
  const cont = b.run('claude', stop('A'));
  assert.equal(cont.terminalSequence, undefined);
  assert.deepEqual(b.run('claude', { hook_event_name: 'Notification', session_id: 'A', notification_type: 'permission_prompt' }), { terminalSequence: '\u0007' });
  assert.equal(b.session('A').status, 'blocked');
  assert.equal(b.run('claude', { hook_event_name: 'Notification', session_id: 'A', notification_type: 'idle_prompt' }), null);
  assert.deepEqual(b.run('claude', { hook_event_name: 'StopFailure', session_id: 'A' }), { terminalSequence: '\u0007' });
  assert.equal(b.session('A').status, 'error');
});

test('without --agent the CLI is read from the payload: turn_id or a rollout transcript is Codex, else Claude', async () => {
  const b = bus();
  const raw = (payload) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', payload.hook_event_name], { input: JSON.stringify({ cwd: REPO, ...payload }), encoding: 'utf8', env: b.env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  raw({ hook_event_name: 'SessionStart', session_id: 'X', source: 'startup', transcript_path: '/h/.codex/sessions/2026/10/03/rollout-2026-10-03T11-57-21-x.jsonl' });
  raw({ hook_event_name: 'SessionStart', session_id: 'Y', source: 'startup', transcript_path: '/h/.claude/projects/p/y.jsonl' });
  assert.deepEqual([b.session('X').kind, b.session('Y').kind], ['codex', 'claude']);
  b.enroll('P');
  await b.send('P', 'X', 'hello X');
  assert.equal(raw(stop('X', { turn_id: 't' })).decision, 'block');
});

test('SessionStart points at the peer rules shipped with chattr, for Claude and Codex', () => {
  const b = bus();
  for (const kind of ['claude', 'codex']) {
    const out = b.run(kind, { hook_event_name: 'SessionStart', session_id: `R-${kind}`, source: 'startup' });
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`${REPO}/docs/AGENT-RULES\\.md`));
  }
  assert.ok(readFileSync(path.join(REPO, 'docs', 'AGENT-RULES.md'), 'utf8').includes('chattr claim'));
});

test('subagent events are ignored: no join, no delivery, no output', async () => {
  const b = bus();
  b.enroll('P');
  await b.send('P', 'P', 'self');
  for (const kind of ['claude', 'codex']) {
    assert.equal(b.run(kind, { hook_event_name: 'UserPromptSubmit', session_id: 'sub', agent_id: 'a1', prompt: 'x' }), null);
    assert.equal(b.run(kind, { hook_event_name: 'PostToolUse', session_id: 'P', agent_id: 'a1', tool_name: 'Bash' }), null);
  }
  assert.equal(b.session('sub'), undefined);
});

test('start joins with the bootstrap and injects; compact keeps the incarnation; resume issues a new one', async () => {
  const b = bus();
  const envFile = path.join(b.dir, 'env.sh');
  b.run('claude', { hook_event_name: 'SessionStart', session_id: 'C', source: 'startup' }, { CLAUDE_ENV_FILE: envFile, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock' });
  assert.equal(readFileSync(envFile, 'utf8'), 'export CHATTR_SESSION=C\n');
  const first = b.session('C');
  assert.deepEqual(JSON.parse(first.wake_endpoint), { kind: 'uds', path: '/tmp/cc-socks/1.sock' });
  b.enroll('P');
  await b.send('P', 'C', 'at start');
  const out = b.run('claude', { hook_event_name: 'SessionStart', session_id: 'C', source: 'compact' });
  assert.match(out.hookSpecificOutput.additionalContext, /at start/);
  assert.equal(b.session('C').incarnation, first.incarnation);
  b.run('claude', { hook_event_name: 'SessionStart', session_id: 'C', source: 'resume' });
  assert.notEqual(b.session('C').incarnation, first.incarnation);
});

test('Codex enrols at its first prompt with a codex-queue endpoint and gets prompt-time delivery', async () => {
  const b = bus();
  const out = b.run('codex', prompt('01a0-thread'));
  assert.equal(out, null);
  const row = b.session('01a0-thread');
  assert.equal(row.kind, 'codex');
  assert.equal(row.status, 'working');
  assert.deepEqual(JSON.parse(row.wake_endpoint), { kind: 'codex-queue', thread: '01a0-thread' });
  b.enroll('P');
  await b.send('P', '01a0-thread', 'for codex', 'consult');
  const next = b.run('codex', prompt('01a0-thread'));
  assert.equal(next.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(next.hookSpecificOutput.additionalContext, /\[consult [0-9a-f-]+\] from P \(answer: chattr reply --to/);
});

test('tool events carry the broadcast notice and never inject', async () => {
  const b = bus();
  b.enroll('A');
  b.enroll('P');
  await main(['broadcast', 'heads up'], { CHATTR_DB: b.file, CHATTR_SESSION: 'P' });
  const out = b.run('claude', { hook_event_name: 'PostToolUse', session_id: 'A', tool_name: 'Bash' });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /1 broadcast\(s\) pending/);
  assert.equal(b.db.prepare('SELECT count(*) AS n FROM batches').get().n, 0);
});

test('a Stop holding only broadcasts ends the turn: no continuation, the broadcast stays queued', async () => {
  const b = bus();
  b.enroll('A');
  b.enroll('P');
  const uuid = await b.send('P', 'broadcast', 'taking issue 115', 'broadcast');
  assert.equal(b.run('claude', stop('A')), null);
  assert.equal(b.session('A').status, 'idle');
  assert.equal(b.delivery(uuid, 'A').batch, null);
  assert.match(b.run('claude', prompt('A')).hookSpecificOutput.additionalContext, /taking issue 115/);
});

test('a malformed payload or unknown agent never wedges the session', () => {
  const b = bus();
  const r = spawnSync(process.execPath, [CLI, 'hook', 'Stop', '--agent', 'claude'], { input: 'not json', encoding: 'utf8', env: b.env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(spawnSync(process.execPath, [CLI, 'hook', 'Stop', '--agent', 'qwen'], { input: '{}', encoding: 'utf8', env: b.env }).status, 2);
});

test('claude --bg: the recorded pid is the socket-owning worker, not the supervisor, so wake passes the pid check', async () => {
  const b = bus();
  // The hook's ancestor (CHATTR_AGENT_PID, this test process) stands in for the supervisor; a child is the worker.
  const worker = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const sock = path.join(b.dir, `${worker.pid}.sock`);
    b.run('claude', { hook_event_name: 'SessionStart', session_id: 'BG', source: 'startup' }, { CLAUDE_CODE_MESSAGING_SOCKET: sock });
    const row = b.session('BG');
    assert.equal(row.pid, worker.pid);
    assert.equal(row.pid_start, readPidStart(worker.pid));
    // No listener on the socket: the wake gets past the pid check and fails at the endpoint.
    const woke = await wakeSession(b.db, 'BG', { PATH: process.env.PATH, CHATTR_DB: b.file });
    assert.equal(woke.reason, 'endpoint_failed');
  } finally {
    worker.kill();
  }
  // A socket named for a dead pid falls back to the ancestor walk, and wake still refuses the mismatch.
  const dead = path.join(b.dir, '2147483646.sock');
  b.run('claude', { hook_event_name: 'SessionStart', session_id: 'STALE', source: 'startup' }, { CLAUDE_CODE_MESSAGING_SOCKET: dead });
  assert.equal(b.session('STALE').pid, agentPid('claude', process.pid));
  const refused = await wakeSession(b.db, 'STALE', { PATH: process.env.PATH, CHATTR_DB: b.file });
  assert.equal(refused.reason, 'endpoint_pid_mismatch');
});

test('formatBatch: a broadcast-only batch says to end the turn silently; a consult batch does not', () => {
  const msg = (type) => ({ type, uuid: `u-${type}`, from_id: 'peer', body: 'b' });
  assert.match(formatBatch({ batch: 1, messages: [msg('broadcast')] }), /end the turn silently/);
  assert.doesNotMatch(formatBatch({ batch: 2, messages: [msg('broadcast'), msg('consult')] }), /silently/);
});
