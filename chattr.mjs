#!/usr/bin/env node
// chattr: durable peer channel for Claude/Codex sessions. Contract: ./SPEC.md.
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STALE_AFTER_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const TURN_STATUS = { start: 'idle', stop: 'idle', interrupt: 'idle', prompt: 'working', tool: 'working', stop_failure: 'error', blocked: 'blocked' };
const RANK = ['queued', 'injected', 'stale', 'expired', 'superseded', 'acked'];
const BOOLEAN_FLAGS = new Set(['json', 'text', 'repo', 'all', 'coverage']);

export class BusError extends Error {
  constructor(exit, code, message, detail = {}) {
    super(message);
    this.exit = exit;
    this.code = code;
    this.detail = detail;
  }
}

export function open(file = process.env.CHATTR_DB || path.join(homedir(), '.agent-bridge', 'bridge.db')) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      tx(db, () => db.exec(readFileSync(path.join(HERE, 'schema.sql'), 'utf8')));
      return db;
    } catch (error) {
      if (attempt > 50 || !/locked|busy/i.test(error.message)) throw error;
    }
  }
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function repoOf(cwd) {
  const git = spawnSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (git.status !== 0) return null;
  try {
    return realpathSync(path.resolve(cwd, git.stdout.trim()));
  } catch {
    return null;
  }
}

// `lstart` is rendered in the reader's zone and locale, so pin both: sessions with different
// environments must agree on one process's start time.
export function readPidStart(pid) {
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  return ps.status === 0 && ps.stdout.trim() ? ps.stdout.trim() : null;
}

/** A row joined before the pin holds local time; one that cannot be compared is not evidence of pid reuse. */
function sameStart(stored, current) {
  if (stored === current) return true;
  const [then, now] = [Date.parse(stored), Date.parse(`${current} UTC`)];
  return Number.isNaN(then) || Number.isNaN(now) || then === now;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function liveStatus(db, row, now = Date.now()) {
  if (row.status === 'gone') return 'gone';
  const current = pidAlive(row.pid) ? readPidStart(row.pid) : null;
  if (!pidAlive(row.pid) || (row.pid_start && current && !sameStart(row.pid_start, current))) {
    db.prepare("UPDATE sessions SET status = 'gone' WHERE id = ? AND incarnation = ?").run(row.id, row.incarnation);
    return 'gone';
  }
  return now - row.last_seen > STALE_AFTER_MS ? 'unknown' : row.status;
}

function sessionOut(row, status = row.status) {
  return { ...row, status, wake_endpoint: row.wake_endpoint ? JSON.parse(row.wake_endpoint) : null };
}

function liveSessions(db, where = '1', ...params) {
  return db.prepare(`SELECT * FROM sessions WHERE ${where} ORDER BY joined_at, id`).all(...params)
    .map((row) => sessionOut(row, liveStatus(db, row)))
    .filter((row) => row.status !== 'gone');
}

const getSession = (db, id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
const getMessage = (db, uuid) => db.prepare('SELECT * FROM messages WHERE uuid = ?').get(uuid);

export function join(db, { id, kind, source = 'startup', pid = process.ppid, pidStart, tty = null, surface = 'unknown', cwd = process.cwd(), wakeEndpoint = null }) {
  if (!id) throw new BusError(3, 'not_enrolled', 'no session id');
  if (!kind) throw new BusError(2, 'usage', 'join needs --kind');
  const now = Date.now();
  const fields = {
    pid, pid_start: pidStart === undefined ? readPidStart(pid) : pidStart, tty, surface, cwd,
    repo: repoOf(cwd), wake_endpoint: wakeEndpoint == null ? null : JSON.stringify(wakeEndpoint),
  };
  return tx(db, () => {
    const existing = getSession(db, id);
    const incarnation = existing && source === 'compact' ? existing.incarnation : randomUUID();
    db.prepare(`INSERT INTO sessions (id, kind, incarnation, pid, pid_start, tty, surface, cwd, repo, status, last_seen, wake_endpoint, joined_at)
      VALUES (:id, :kind, :incarnation, :pid, :pid_start, :tty, :surface, :cwd, :repo, 'idle', :now, :wake_endpoint, :now)
      ON CONFLICT (id) DO UPDATE SET kind = :kind, incarnation = :incarnation, pid = :pid, pid_start = :pid_start, tty = :tty,
        surface = :surface, cwd = :cwd, repo = :repo, status = 'idle', last_seen = :now, wake_endpoint = :wake_endpoint`)
      .run({ id, kind, incarnation, now, ...fields });
    return sessionOut(getSession(db, id));
  });
}

const PENDING = `FROM deliveries d JOIN messages m ON m.uuid = d.message_uuid
  WHERE d.session_id = :sid AND d.acked_at IS NULL AND d.stale_at IS NULL
    AND m.superseded_by IS NULL AND (m.expires_at IS NULL OR m.expires_at > :now)`;

export function turn(db, sessionId, event) {
  if (!(event in TURN_STATUS)) throw new BusError(2, 'usage', `unknown event ${event}`);
  return tx(db, () => {
    const session = getSession(db, sessionId);
    if (!session) throw new BusError(3, 'not_enrolled', `session ${sessionId} has not joined`);
    const now = Date.now();
    const inc = session.incarnation;
    db.prepare('UPDATE sessions SET status = ?, last_seen = ? WHERE id = ?').run(TURN_STATUS[event], now, sessionId);
    const result = { status: TURN_STATUS[event], batch: null, messages: [], acked: 0, notice: null };
    if (event === 'stop') {
      result.acked = Number(db.prepare('UPDATE deliveries SET acked_at = ? WHERE session_id = ? AND incarnation = ? AND batch IS NOT NULL AND acked_at IS NULL')
        .run(now, sessionId, inc).changes);
      db.prepare('UPDATE batches SET acked_at = ? WHERE session_id = ? AND incarnation = ? AND acked_at IS NULL').run(now, sessionId, inc);
    }
    const notYetHere = '(d.batch IS NULL OR d.incarnation IS NOT :inc)';
    if (event === 'tool') {
      const { n } = db.prepare(`SELECT count(*) AS n ${PENDING} AND m.type = 'broadcast' AND ${notYetHere}`).get({ sid: sessionId, now, inc });
      if (n) result.notice = `chattr: ${n} broadcast(s) pending; they arrive with your next prompt, or sooner with a directed message.`;
    }
    if (!['start', 'prompt', 'stop'].includes(event)) return result;
    const candidates = db.prepare(`SELECT m.*, d.batch AS d_batch, d.attempts AS d_attempts ${PENDING} AND ${notYetHere} ORDER BY m.created_at, m.uuid`)
      .all({ sid: sessionId, now, inc });
    const inject = [];
    for (const row of candidates) {
      if (row.d_batch !== null && row.d_attempts >= MAX_ATTEMPTS) {
        db.prepare('UPDATE deliveries SET attempts = attempts + 1, stale_at = ? WHERE message_uuid = ? AND session_id = ?').run(now, row.uuid, sessionId);
      } else inject.push(row);
    }
    // A broadcast never continues a turn on its own: at stop it waits for a directed message or the next prompt.
    if (!inject.length || (event === 'stop' && inject.every((row) => row.type === 'broadcast'))) return result;
    result.batch = Number(db.prepare('INSERT INTO batches (session_id, incarnation, event, created_at) VALUES (?, ?, ?, ?)').run(sessionId, inc, event, now).lastInsertRowid);
    const stamp = db.prepare('UPDATE deliveries SET batch = ?, incarnation = ?, attempts = attempts + 1, last_injected_at = ? WHERE message_uuid = ? AND session_id = ?');
    for (const row of inject) stamp.run(result.batch, inc, now, row.uuid, sessionId);
    result.messages = inject.map(({ d_batch, d_attempts, ...message }) => message);
    return result;
  });
}

export function markContinued(db, batchId) {
  tx(db, () => {
    const batch = db.prepare('SELECT session_id FROM batches WHERE id = ?').get(batchId);
    if (!batch) throw new BusError(4, 'unknown_batch', `batch ${batchId} not found`);
    db.prepare('UPDATE batches SET continued = 1 WHERE id = ?').run(batchId);
    db.prepare("UPDATE sessions SET status = 'working' WHERE id = ?").run(batch.session_id);
  });
}

function deliveryState(row, now = Date.now()) {
  if (row.acked_at) return 'acked';
  if (row.stale_at) return 'stale';
  if (row.superseded_by) return 'superseded';
  if (row.expires_at !== null && row.expires_at <= now) return 'expired';
  return row.batch !== null ? 'injected' : 'queued';
}

function messageStatus(db, message) {
  const recipients = db.prepare(`SELECT d.*, m.superseded_by, m.expires_at FROM deliveries d JOIN messages m ON m.uuid = d.message_uuid
    WHERE d.message_uuid = ? ORDER BY d.session_id`).all(message.uuid)
    .map((row) => ({ session_id: row.session_id, state: deliveryState(row), attempts: row.attempts, batch: row.batch, acked_at: row.acked_at }));
  const least = recipients.map((r) => r.state).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] ?? deliveryState({ ...message, batch: null });
  const summary = message.type === 'consult' && message.reply_status ? message.reply_status : least;
  return { message, recipients, summary };
}

function resolveRecipients(db, sender, to) {
  if (to !== 'broadcast' && !to.startsWith('kind:')) {
    if (!getSession(db, to)) throw new BusError(4, 'unknown_recipient', `no session ${to}`);
    return [to];
  }
  if (!sender.repo) throw new BusError(4, 'repo_required', `${to} needs the sender to be in a git repo`);
  const kind = to.startsWith('kind:') ? to.slice(5) : null;
  const ids = liveSessions(db, 'repo = ? AND id != ?', sender.repo, sender.id)
    .filter((s) => !kind || s.kind === kind).map((s) => s.id);
  if (kind && !ids.length) throw new BusError(4, 'unknown_recipient', `no live ${kind} session in this repo`);
  return ids;
}

/** Inserts one message and its deliveries. The caller holds the transaction. */
function insertMessage(db, sender, { type, to, body, recipients, replyTo = null }) {
  const uuid = randomUUID();
  // Strictly increasing created_at keeps send order under (created_at, uuid) ordering.
  const { next } = db.prepare('SELECT max(?, coalesce(max(created_at) + 1, 0)) AS next FROM messages').get(Date.now());
  db.prepare('INSERT INTO messages (uuid, from_id, to_spec, repo, type, reply_to, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuid, sender.id, to, sender.repo, type, replyTo, body, next);
  const deliver = db.prepare('INSERT INTO deliveries (message_uuid, session_id) VALUES (?, ?)');
  for (const id of recipients) deliver.run(uuid, id);
  db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(Date.now(), sender.id);
  return { message: getMessage(db, uuid), recipients };
}

export function post(db, sender, { type, to, body, replyTo = null, replyStatus = null }) {
  if (!body) throw new BusError(2, 'usage', 'empty body');
  const recipients = resolveRecipients(db, sender, to);
  return tx(db, () => {
    if (replyTo) {
      const consult = getMessage(db, replyTo);
      const held = consult?.type === 'consult' && db.prepare('SELECT 1 FROM deliveries WHERE message_uuid = ? AND session_id = ?').get(replyTo, sender.id);
      if (!held) throw new BusError(4, 'unknown_consult', `no consult ${replyTo} addressed to this session`);
      db.prepare('UPDATE messages SET reply_status = ? WHERE uuid = ?').run(replyStatus, replyTo);
      db.prepare('UPDATE deliveries SET acked_at = coalesce(acked_at, ?) WHERE message_uuid = ? AND session_id = ?').run(Date.now(), replyTo, sender.id);
    }
    return insertMessage(db, sender, { type, to, body, recipients, replyTo });
  });
}

const RESOURCE = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._/-]*$/;
const getClaim = (db, id) => db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
const activeClaim = (db, repo, resource) => db.prepare('SELECT * FROM claims WHERE repo = ? AND resource = ? AND released_at IS NULL').get(repo, resource);

/** The caller's repo and normalized resource. A stale incarnation owns nothing, so it may not write claims. */
function claimScope(db, session, resource) {
  const name = String(resource ?? '').trim().toLowerCase();
  if (!RESOURCE.test(name)) throw new BusError(2, 'usage', 'a resource is <kind>:<name>, e.g. issue:115, pr:108, resource:preview-db');
  if (!session.repo) throw new BusError(4, 'repo_required', 'claims need the caller to be in a git repo');
  if (getSession(db, session.id)?.incarnation !== session.incarnation) throw new BusError(4, 'stale_incarnation', `session ${session.id} has a newer incarnation`);
  return name;
}

/**
 * Every active claim in the repo, after releasing those whose owner is confirmed gone. Idle,
 * unknown and elapsed time never free a claim. `stale` marks a claim its owner made in an earlier
 * incarnation and has not re-claimed. The caller holds the transaction.
 */
function activeClaims(db, repo, me = null) {
  const out = [];
  // `me` also matches by owner: a re-join rewrites the session's repo, and its claims must stay visible to it.
  for (const row of db.prepare('SELECT * FROM claims WHERE (repo IS ? OR session_id IS ?) AND released_at IS NULL ORDER BY claimed_at, id').all(repo, me)) {
    const owner = getSession(db, row.session_id);
    const status = owner ? liveStatus(db, owner) : 'gone';
    if (status === 'gone') db.prepare("UPDATE claims SET released_at = ?, release_reason = 'owner_gone' WHERE id = ?").run(Date.now(), row.id);
    else out.push({ ...row, owner_status: status, stale: owner.incarnation !== row.incarnation, mine: row.session_id === me });
  }
  return out;
}

/** First claim wins. The claim row and its announcement commit together; a conflict throws with the owner's claim. */
export function claim(db, session, resource, note = '') {
  const name = claimScope(db, session, resource);
  const recipients = resolveRecipients(db, session, 'broadcast');
  return tx(db, () => {
    // Its claim would be reaped as owner_gone at the next read while it believed it owned the work.
    if (liveStatus(db, getSession(db, session.id)) === 'gone') throw new BusError(3, 'session_gone', `session ${session.id} is marked gone; it re-joins at its next hook event`);
    const held = activeClaims(db, session.repo).find((c) => c.resource === name);
    if (held && held.session_id !== session.id) throw new BusError(4, 'claimed', `${name} is claimed by ${held.session_id}`, { claim: held });
    if (held) {
      db.prepare('UPDATE claims SET incarnation = ? WHERE id = ?').run(session.incarnation, held.id);
      return { claim: getClaim(db, held.id), already: true, message: null, recipients: [] };
    }
    const id = randomUUID();
    db.prepare('INSERT INTO claims (id, repo, resource, session_id, incarnation, note, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, session.repo, name, session.id, session.incarnation, note || null, Date.now());
    const said = insertMessage(db, session, { type: 'broadcast', to: 'broadcast', body: `claim ${name}${note ? `: ${note}` : ''}`, recipients });
    return { claim: getClaim(db, id), already: false, ...said };
  });
}

/** Releases the caller's own claim, with its announcement, in one transaction. Never touches another owner's claim. */
export function release(db, session, resource, note = '') {
  const name = claimScope(db, session, resource);
  // The claim's repo, not the session's current one: a re-join may have moved the session since.
  const ownActive = () => db.prepare('SELECT * FROM claims WHERE resource = ? AND session_id = ? AND released_at IS NULL ORDER BY (repo IS ?) DESC LIMIT 1').get(name, session.id, session.repo);
  const sender = { ...session, repo: ownActive()?.repo ?? session.repo };
  const recipients = resolveRecipients(db, sender, 'broadcast');
  return tx(db, () => {
    const own = ownActive();
    const held = own ?? activeClaim(db, session.repo, name);
    if (own) {
      db.prepare("UPDATE claims SET released_at = ?, release_reason = 'released' WHERE id = ?").run(Date.now(), own.id);
      const said = insertMessage(db, sender, { type: 'broadcast', to: 'broadcast', body: `release ${name}${note ? `: ${note}` : ''}`, recipients });
      return { claim: getClaim(db, own.id), already: false, ...said };
    }
    const mine = db.prepare('SELECT * FROM claims WHERE resource = ? AND session_id = ? ORDER BY released_at DESC LIMIT 1').get(name, session.id);
    if (mine) return { claim: mine, already: true, message: null, recipients: [] };
    if (held) throw new BusError(4, 'not_owner', `${name} is claimed by ${held.session_id}`, { claim: held });
    throw new BusError(4, 'unknown_claim', `no claim on ${name}`);
  });
}

function ownMessage(db, sender, uuid) {
  const message = getMessage(db, uuid);
  if (!message || message.from_id !== sender.id) throw new BusError(4, 'unknown_message', `no message ${uuid} sent by this session`);
  return message;
}

function pending(db, sessionId, { after = null, limit = 50 } = {}) {
  const now = Date.now();
  let cursor = '';
  const params = { sid: sessionId, now, limit };
  if (after) {
    const anchor = getMessage(db, after);
    if (!anchor) throw new BusError(2, 'usage', `unknown --after ${after}`);
    cursor = 'AND (m.created_at > :ac OR (m.created_at = :ac AND m.uuid > :au))';
    Object.assign(params, { ac: anchor.created_at, au: anchor.uuid });
  }
  return db.prepare(`SELECT m.*, d.batch, d.acked_at, d.stale_at ${PENDING} ${cursor} ORDER BY m.created_at, m.uuid LIMIT :limit`).all(params)
    .map(({ batch, acked_at, stale_at, ...m }) => ({ ...m, state: deliveryState({ ...m, batch, acked_at, stale_at }) }));
}

/** Working directory of each pid lsof can read; a pid it cannot read is absent. */
function cwdsOf(pids) {
  const cwds = new Map();
  if (!pids.length) return cwds;
  const lsof = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], { encoding: 'utf8' });
  let pid = null;
  for (const line of (lsof.stdout || '').split('\n')) {
    if (line[0] === 'p') pid = line.slice(1);
    else if (line[0] === 'n' && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

const sameDir = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
// `a` is `b` or below it, compared by path segment on realpaths: /a/bc is not under /a/b.
const underDir = (a, b) => {
  try {
    const rel = path.relative(realpathSync(b), realpathSync(a));
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch { return false; }
};

// The first argument after the executable that is not a `-c <key=value>` pair is the subcommand.
// Only an exact `app-server` subcommand -- never a prompt or other argument that merely mentions
// it -- classifies the root as an app-server host.
function isAppServerArgs(args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let i = 1; // tokens[0] is the executable
  while (tokens[i] === '-c') i += 2;
  return tokens[i] === 'app-server';
}

// Root ps only reports comm (`codex`), not the arguments that tell an app-server host (the VS Code
// OpenAI extension and the ChatGPT app both host conversations inside one) from an ordinary Codex
// CLI root. `-ww` avoids a truncated command line -- and so a missed `app-server` -- on a narrow
// terminal. A pid this second call doesn't answer, or whose subcommand isn't positively
// `app-server`, still counts: fail closed, favoring a counted session over a hidden one.
function appServerHosts(pids) {
  const hosts = new Set();
  if (!pids.length) return hosts;
  const want = new Set(pids);
  const ps = spawnSync('ps', ['-ww', '-Ao', 'pid=,args='], { encoding: 'utf8' });
  if (ps.status !== 0) return hosts;
  for (const line of (ps.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m || !want.has(m[1])) continue;
    if (isAppServerArgs(m[2])) hosts.add(m[1]);
  }
  return hosts;
}

// `cwd` counts only processes and sessions whose cwd is that directory: the guard's
// rival test is same-cwd, so a process elsewhere cannot be the rival it misses.
// `under` counts those at or below a directory. A process whose cwd cannot be read
// still counts (fail closed). `unenrolled` lists each counted root process whose pid
// matches no live session's pid. A codex root identified as an app-server host is not
// process-counted at all: it hosts conversations rather than being one itself, so only
// enrollment (never process presence) can make a conversation inside it visible.
function coverage(db, { cwd = null, under = null } = {}) {
  const inScope = cwd ? (dir) => sameDir(dir, cwd) : under ? (dir) => underDir(dir, under) : null;
  const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  const procs = ps.stdout.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, comm]) => ({ pid, ppid, name: path.basename(comm) }));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const processes = { claude: 0, codex: 0 };
  let roots = procs.filter((p) => p.name in processes && byPid.get(p.ppid)?.name !== p.name);
  const hosts = appServerHosts(roots.filter((p) => p.name === 'codex').map((p) => p.pid));
  roots = roots.filter((p) => !hosts.has(p.pid));
  const cwds = cwdsOf(roots.map((p) => p.pid));
  if (inScope) roots = roots.filter((p) => !cwds.has(p.pid) || inScope(cwds.get(p.pid)));
  for (const p of roots) processes[p.name]++;
  const enrolled = { claude: 0, codex: 0 };
  const live = liveSessions(db);
  for (const s of live) if (s.kind in enrolled && (!inScope || inScope(s.cwd))) enrolled[s.kind]++;
  const livePids = new Set(live.map((s) => String(s.pid)));
  const unenrolled = roots.filter((p) => !livePids.has(p.pid)).map((p) => ({ pid: Number(p.pid), kind: p.name, cwd: cwds.get(p.pid) ?? null }));
  return { processes, enrolled, unenrolled, complete: ps.status === 0 && enrolled.claude >= processes.claude && enrolled.codex >= processes.codex };
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (BOOLEAN_FLAGS.has(arg.slice(2))) flags[arg.slice(2)] = true;
    else if (i + 1 < argv.length) flags[arg.slice(2)] = argv[++i];
    else throw new BusError(2, 'usage', `${arg} needs a value`);
  }
  return { flags, positional };
}

function readBody(parts) {
  return parts.length === 1 && parts[0] === '-' ? readFileSync(0, 'utf8') : parts.join(' ');
}

const USAGE = 'chattr <join|leave|who|status|send|broadcast|consult|reply|claim|release|inbox|ack|expire|supersede|wake|state|hook> [--json|--text]';

export async function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  if (cmd === 'hook' || cmd === 'wake') {
    const mod = await import(pathToFileURL(path.join(HERE, cmd === 'hook' ? 'hook/index.mjs' : 'wake.mjs')).href);
    return { code: (await mod.default(rest)) ?? 0, output: null };
  }
  // A claim note is free text: words like `--force` in it are not flags. Only a trailing format flag is one.
  const { flags, positional } = cmd === 'claim' || cmd === 'release'
    ? { flags: {}, positional: ['--json', '--text'].includes(rest.at(-1)) ? rest.slice(0, -1) : rest }
    : parseArgs(rest);
  const db = open(env.CHATTR_DB || undefined);
  try {
    const me = flags.session && cmd === 'join' ? flags.session : env.CHATTR_SESSION || env.CODEX_THREAD_ID;
    const caller = () => {
      const row = me && getSession(db, me);
      if (!row) throw new BusError(3, 'not_enrolled', me ? `session ${me} has not joined` : 'CHATTR_SESSION is not set');
      return row;
    };
    const need = (n) => { if (positional.length < n) throw new BusError(2, 'usage', USAGE); };
    switch (cmd) {
      case 'join': {
        const wakeEndpoint = flags['wake-endpoint'] ? JSON.parse(flags['wake-endpoint']) : null;
        return ok({ session: join(db, { id: me, kind: flags.kind, source: flags.source, pid: flags.pid ? Number(flags.pid) : undefined, tty: flags.tty, surface: flags.surface, cwd: flags.cwd, wakeEndpoint }) });
      }
      case 'leave': {
        const row = caller();
        db.prepare("UPDATE sessions SET status = 'gone', last_seen = ? WHERE id = ?").run(Date.now(), row.id);
        return ok({ session: sessionOut(getSession(db, row.id)) });
      }
      case 'who': {
        if (flags.cwd && flags.under) throw new BusError(2, 'usage', '--cwd and --under are exclusive');
        const repo = flags.repo ? (me && getSession(db, me)?.repo) || repoOf(process.cwd()) : null;
        const rows = db.prepare('SELECT * FROM sessions ORDER BY joined_at, id').all()
          .map((row) => sessionOut(row, liveStatus(db, row)))
          .filter((s) => (flags.all || s.status !== 'gone') && (!flags.repo || s.repo === repo));
        return ok({ sessions: rows, ...(flags.coverage ? { coverage: coverage(db, { cwd: flags.cwd, under: flags.under }) } : {}) });
      }
      case 'status': {
        need(1);
        const message = getMessage(db, positional[0]);
        if (message) return ok(messageStatus(db, message));
        const row = getSession(db, positional[0]);
        if (!row) throw new BusError(4, 'unknown', `no message or session ${positional[0]}`);
        return ok({ session: sessionOut(row, liveStatus(db, row)) });
      }
      case 'send':
      case 'consult':
        need(2);
        return ok(post(db, caller(), { type: cmd === 'send' ? 'msg' : 'consult', to: positional[0], body: readBody(positional.slice(1)) }));
      case 'broadcast':
        need(1);
        return ok(post(db, caller(), { type: 'broadcast', to: 'broadcast', body: readBody(positional) }));
      case 'reply': {
        need(1);
        const status = flags.status ?? 'answered';
        if (!flags.to || !['answered', 'interrupted', 'unknown'].includes(status)) throw new BusError(2, 'usage', 'reply --to <uuid> [--status answered|interrupted|unknown] <body>');
        const consult = getMessage(db, flags.to);
        return ok(post(db, caller(), { type: 'reply', to: consult?.from_id ?? flags.to, body: readBody(positional), replyTo: flags.to, replyStatus: status }));
      }
      case 'claim':
      case 'release':
        need(1);
        return ok((cmd === 'claim' ? claim : release)(db, caller(), positional[0], readBody(positional.slice(1)).trim()));
      case 'inbox':
        return ok({ messages: pending(db, caller().id, { after: flags.after, limit: Number(flags.limit ?? 50) }) });
      case 'ack': {
        need(1);
        const row = caller();
        const out = { acked: [], already: [], unknown: [] };
        tx(db, () => {
          for (const uuid of positional) {
            const d = db.prepare('SELECT acked_at FROM deliveries WHERE message_uuid = ? AND session_id = ?').get(uuid, row.id);
            if (!d) out.unknown.push(uuid);
            else if (d.acked_at) out.already.push(uuid);
            else {
              db.prepare('UPDATE deliveries SET acked_at = ? WHERE message_uuid = ? AND session_id = ?').run(Date.now(), uuid, row.id);
              out.acked.push(uuid);
            }
          }
        });
        return ok(out);
      }
      case 'expire': {
        need(1);
        const message = ownMessage(db, caller(), positional[0]);
        db.prepare('UPDATE messages SET expires_at = coalesce(expires_at, ?) WHERE uuid = ?').run(Date.now(), message.uuid);
        return ok({ message: getMessage(db, message.uuid) });
      }
      case 'supersede': {
        need(2);
        const row = caller();
        const [old, next] = [ownMessage(db, row, positional[0]), ownMessage(db, row, positional[1])];
        db.prepare('UPDATE messages SET superseded_by = ? WHERE uuid = ?').run(next.uuid, old.uuid);
        return ok({ message: getMessage(db, old.uuid) });
      }
      case 'state': {
        const row = caller();
        const now = Date.now();
        return ok({
          session: sessionOut(row, liveStatus(db, row)),
          peers: row.repo ? liveSessions(db, 'repo = ? AND id != ?', row.repo, row.id) : [],
          broadcasts: db.prepare(`SELECT * FROM messages WHERE type = 'broadcast' AND repo IS ? AND superseded_by IS NULL
            AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC, uuid DESC LIMIT 10`).all(row.repo, now),
          unacked: pending(db, row.id),
          claims: row.repo ? tx(db, () => activeClaims(db, row.repo, row.id)) : [],
        });
      }
      default:
        throw new BusError(2, 'usage', USAGE);
    }
  } catch (error) {
    if (!(error instanceof BusError)) throw error;
    return { code: error.exit, output: { ok: false, error: { code: error.code, message: error.message }, ...error.detail } };
  } finally {
    db.close();
  }
}

function ok(payload) {
  return { code: 0, output: { ok: true, ...payload } };
}

function toText(value, prefix = '') {
  if (Array.isArray(value)) return value.map((item) => toText(item, prefix)).join('\n');
  if (value && typeof value === 'object') {
    const scalars = Object.entries(value).filter(([, v]) => v === null || typeof v !== 'object');
    const nested = Object.entries(value).filter(([, v]) => v !== null && typeof v === 'object');
    return [scalars.map(([k, v]) => `${k}=${v}`).join(' '), ...nested.map(([k, v]) => `${prefix}${k}:\n${toText(v, `${prefix}  `)}`)]
      .filter(Boolean).map((line) => (line.startsWith(prefix) ? line : prefix + line)).join('\n');
  }
  return `${prefix}${value}`;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  // No top-level await: hook/ and wake.mjs import this module, and a pending top-level await would deadlock that cycle.
  main(argv).catch((error) => ({ code: 1, output: { ok: false, error: { code: 'internal', message: error.message } } })).then(({ code, output }) => {
    if (output) process.stdout.write(`${argv.includes('--text') ? toText(output) : JSON.stringify(output)}\n`);
    process.exitCode = code;
  });
}
