// A thin, shared wrapper for calling the REAL `chattr` binary from a
// scenario -- used for the harness's own bookkeeping (joining a synthetic
// sender, reading `status`), never as a stand-in for what a real Claude/Codex
// session does. One definition so every scenario's error message and env
// wiring (CHATTR_DB) matches.

import { spawn, spawnSync } from 'node:child_process';
import { CHATTR_BIN } from './paths.mjs';

/** Runs `chattr <args>` against the sandbox's CHATTR_DB and returns the parsed JSON. Throws on a non-zero exit. */
export function chattr(sandbox, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [CHATTR_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHATTR_DB: sandbox.dbFile, ...extraEnv },
  });
  if (result.status !== 0) throw new Error(`chattr ${args.join(' ')} exited ${result.status}: ${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout);
}

/**
 * Same as `chattr`, but asynchronous (`spawn`, not `spawnSync`) so two
 * calls issued together (`Promise.all`) genuinely overlap as two OS
 * processes hitting the same sqlite file at once -- used by the
 * simultaneous-cross-consult scenario to exercise `BEGIN IMMEDIATE` +
 * busy-retry (chattr.mjs's `open()`) for real, not just sequentially.
 */
export function chattrAsync(sandbox, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHATTR_BIN, ...args], { env: { ...process.env, CHATTR_DB: sandbox.dbFile, ...extraEnv } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`chattr ${args.join(' ')} exited ${code}: ${stderr}${stdout}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`chattr ${args.join(' ')}: unparseable output: ${stdout} (${error.message})`));
      }
    });
  });
}

/** Same as `chattr`, but returns `null` on a non-zero exit instead of throwing -- for polling loops. */
export function tryChattr(sandbox, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [CHATTR_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHATTR_DB: sandbox.dbFile, ...extraEnv },
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Joins a synthetic (non-CLI) sender session -- for scenarios that only need
 * an identity to call send/consult/broadcast/reply from, not a live process.
 * Pair with `leaveSynthetic` (usually in a `finally`): every scenario shares
 * one CHATTR_DB for the whole run (run.mjs), and this harness's own pid
 * stays alive for that entire run, so a synthetic session left joined would
 * otherwise inflate `who --coverage`'s enrolled counts for every scenario
 * that runs after it -- proven while building this harness (it broke
 * guard-deny-incomplete-coverage.e2e.mjs's fake-process-count assumption).
 */
export function joinSynthetic(sandbox, id, { kind = 'claude', cwd = sandbox.root } = {}) {
  chattr(sandbox, ['join', '--kind', kind, '--session', id, '--cwd', cwd, '--pid', String(process.pid)]);
  return id;
}

/** Marks a synthetic session `gone` (see `joinSynthetic`). Never throws -- cleanup must not mask a real assertion failure. */
export function leaveSynthetic(sandbox, id) {
  try {
    chattr(sandbox, ['leave'], { CHATTR_SESSION: id });
  } catch {
    // best-effort
  }
}

/**
 * Guarantees a REAL CLI session's process is dead, using the exact pid
 * chattr itself recorded (`sessions.pid`, set by `agentPid()` at join)
 * rather than a process-tree walk -- `lib/pty.mjs`'s `PtySession.kill()`
 * signals `script` and its pgrep-discovered children, which is usually
 * enough but proved NOT reliably enough while building this harness: a
 * killed session's real `claude` process was still observed alive (per a
 * fresh `pidAlive()` check) by the very next scenario in a full-suite run,
 * even though the same code path killed it cleanly in isolation. Polls
 * `status` for `gone` (the only thing that actually matters: does chattr
 * itself now consider it dead), escalating to a direct `SIGKILL` of the
 * recorded pid if it is still alive partway through.
 */
export async function ensureSessionGone(sandbox, sessionId, { timeoutMs = 8000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let escalated = false;
  for (;;) {
    const out = tryChattr(sandbox, ['status', sessionId]);
    const status = out?.ok ? out.session?.status : null;
    if (status === 'gone' || status == null) return true;
    if (!escalated) {
      escalated = true; // first sighting that it's still alive: kill the exact recorded pid directly.
      const pid = out.session?.pid;
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Polls `chattr status <id>` until `predicate(session)` is true or the timeout elapses. Returns the last session seen (or null). */
export async function waitForSessionStatus(sandbox, id, predicate, { timeoutMs = 15000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const out = tryChattr(sandbox, ['status', id]);
    if (out?.ok && out.session) {
      last = out.session;
      if (predicate(out.session)) return last;
    }
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Polls `chattr status <uuid>` (a message) until `predicate(recipient)` is true for its first recipient, or the timeout elapses. */
export async function waitForMessageState(sandbox, uuid, predicate, { timeoutMs = 15000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const out = tryChattr(sandbox, ['status', uuid]);
    if (out?.ok && out.recipients?.[0]) {
      last = out.recipients[0];
      if (predicate(last)) return last;
    }
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
