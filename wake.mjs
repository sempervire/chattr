// chattr wake <session>: nudge an idle session to run `chattr inbox` (agent-policy/WAKE.md).
// A wake never carries a message body; a failed wake leaves the message queued.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';
import { main, open } from './chattr.mjs';

const COALESCE_MS = 30_000;
const TEXT = 'chattr inbox';

function sendUds(socketPath) {
  const id = randomUUID();
  // `from` must vary per wake, or Claude drops the second one as a duplicate (WAKE.md).
  const frame = { type: 'user', message: { content: TEXT }, priority: 'next', from: `chattr-${id.slice(0, 8)}`, msg_id: id };
  return new Promise((resolve) => {
    const socket = connect(socketPath, () => socket.end(`${JSON.stringify(frame)}\n`));
    socket.on('close', (hadError) => resolve(!hadError));
    socket.on('error', () => {});
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
  });
}

function codexQueue(thread, env) {
  const run = spawnSync(env.CHATTR_CODEX_BIN || 'codex', ['queue', '--thread', thread, '--message', TEXT], { encoding: 'utf8', timeout: 20_000, env });
  return run.status === 0;
}

/** Wake one session. Resolves {woke, via, reason}; an unreachable endpoint is a result, not a throw. */
export async function wakeSession(db, id, env = process.env, now = Date.now()) {
  const { code, output } = await main(['status', id], env);
  if (code !== 0) return { code, woke: false, reason: output.error.code };
  const { status, last_wake_at: lastWake, wake_endpoint: endpoint, pid } = output.session;
  const via = endpoint?.kind ?? 'pull';
  if (status !== 'idle') return { woke: false, via, reason: `status_${status}` };
  if (lastWake && now - lastWake < COALESCE_MS) return { woke: false, via, reason: 'coalesced' };
  let woke;
  if (via === 'uds') {
    // The socket is named for its owning pid; a stale endpoint must never reach another process.
    const owner = Number(path.basename(endpoint.path, '.sock'));
    if (owner && owner !== pid) return { woke: false, via, reason: 'endpoint_pid_mismatch' };
    woke = await sendUds(endpoint.path);
  } else if (via === 'codex-queue') {
    woke = codexQueue(endpoint.thread, env);
  } else {
    return { woke: false, via, reason: 'pull_only' };
  }
  if (woke) db.prepare('UPDATE sessions SET last_wake_at = ? WHERE id = ?').run(now, id);
  return { woke, via, reason: woke ? null : 'endpoint_failed' };
}

/**
 * Wake idle recipients of the sender's never-injected directed messages; a broadcast is passive and
 * never wakes. The hook calls this after every tool call and stop, outside any sandbox: a sandboxed
 * Codex sender cannot reach `~/.codex/queue_1.sqlite` or a Claude socket itself.
 */
export async function wakeRecipients(db, senderId, env = process.env) {
  const rows = db.prepare(`SELECT DISTINCT d.session_id AS id FROM deliveries d JOIN messages m ON m.uuid = d.message_uuid
    WHERE m.from_id = ? AND m.type != 'broadcast' AND d.batch IS NULL AND d.acked_at IS NULL AND d.stale_at IS NULL`).all(senderId);
  const results = [];
  for (const { id } of rows) results.push({ id, ...(await wakeSession(db, id, env)) });
  return results;
}

export default async function wake(args, env = process.env) {
  const id = args.find((arg) => !arg.startsWith('--'));
  if (!id) {
    console.log(JSON.stringify({ ok: false, error: { code: 'usage', message: 'chattr wake <session>' } }));
    return 2;
  }
  const db = open(env.CHATTR_DB || undefined);
  try {
    const { code, ...result } = await wakeSession(db, id, env);
    if (code) {
      console.log(JSON.stringify({ ok: false, error: { code: result.reason, message: `no session ${id}` } }));
      return code;
    }
    console.log(JSON.stringify({ ok: true, session: id, ...result }));
    return 0;
  } finally {
    db.close();
  }
}
