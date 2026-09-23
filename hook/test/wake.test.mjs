// `chattr wake` against a fake Claude socket and a fake `codex` binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { join, main, open, readPidStart, turn } from '../../chattr.mjs';
import { wakeSession } from '../../wake.mjs';

const CLI = fileURLToPath(new URL('../../chattr.mjs', import.meta.url));
const PID_START = readPidStart(process.pid);

function setup() {
  const dir = mkdtempSync(path.join('/tmp', 'abw-'));
  const file = path.join(dir, 'bridge.db');
  const db = open(file);
  const env = { PATH: process.env.PATH, CHATTR_DB: file };
  const enroll = (id, wakeEndpoint, kind = 'claude') => join(db, { id, kind, pid: process.pid, pidStart: PID_START, cwd: dir, wakeEndpoint });
  return { dir, file, db, env, enroll };
}

async function socketAt(sockPath) {
  const frames = [];
  const server = createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => frames.push(JSON.parse(buf)));
  });
  await new Promise((r) => server.listen(sockPath, r));
  return { frames, close: () => server.close() };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('uds wake sends `chattr inbox` with a fresh from per wake, coalesces within 30 s, and records last_wake_at', async () => {
  const s = setup();
  const sock = await socketAt(path.join(s.dir, `${process.pid}.sock`));
  s.enroll('A', { kind: 'uds', path: path.join(s.dir, `${process.pid}.sock`) });
  const first = await wakeSession(s.db, 'A', s.env, 1_000_000);
  assert.deepEqual(first, { woke: true, via: 'uds', reason: null });
  assert.deepEqual(await wakeSession(s.db, 'A', s.env, 1_010_000), { woke: false, via: 'uds', reason: 'coalesced' });
  assert.equal((await wakeSession(s.db, 'A', s.env, 1_040_000)).woke, true);
  await settle();
  sock.close();
  assert.equal(sock.frames.length, 2);
  for (const f of sock.frames) {
    assert.deepEqual(f.message, { content: 'chattr inbox' });
    assert.match(f.from, /^chattr-[0-9a-f]{8}$/);
  }
  assert.notEqual(sock.frames[0].from, sock.frames[1].from);
  assert.equal(s.db.prepare('SELECT last_wake_at FROM sessions WHERE id = ?').get('A').last_wake_at, 1_040_000);
});

test('wake refuses a session that is not idle, a socket owned by another pid, and a pull-only endpoint', async () => {
  const s = setup();
  s.enroll('W', { kind: 'uds', path: path.join(s.dir, `${process.pid}.sock`) });
  turn(s.db, 'W', 'prompt');
  assert.deepEqual(await wakeSession(s.db, 'W', s.env), { woke: false, via: 'uds', reason: 'status_working' });
  s.enroll('X', { kind: 'uds', path: path.join(s.dir, '1.sock') });
  assert.equal((await wakeSession(s.db, 'X', s.env)).reason, 'endpoint_pid_mismatch');
  s.enroll('Y', { kind: 'pull' });
  assert.equal((await wakeSession(s.db, 'Y', s.env)).reason, 'pull_only');
  s.enroll('Z', { kind: 'uds', path: path.join(s.dir, `${process.pid}.sock`) });
  assert.deepEqual(await wakeSession(s.db, 'Z', s.env), { woke: false, via: 'uds', reason: 'endpoint_failed' });
  assert.equal(s.db.prepare('SELECT last_wake_at FROM sessions WHERE id = ?').get('Z').last_wake_at, null);
});

test('codex-queue wake runs `codex queue --thread <uuid>` and never sends a body; a failed queue is not a wake', async () => {
  const s = setup();
  const log = path.join(s.dir, 'codex.log');
  const bin = path.join(s.dir, 'codex');
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\nexit \${FAKE_EXIT:-0}\n`);
  chmodSync(bin, 0o755);
  s.enroll('T', { kind: 'codex-queue', thread: 'thread-uuid' }, 'codex');
  assert.equal((await wakeSession(s.db, 'T', { ...s.env, CHATTR_CODEX_BIN: bin })).woke, true);
  assert.equal(readFileSync(log, 'utf8'), 'queue --thread thread-uuid --message chattr inbox\n');
  s.enroll('U', { kind: 'codex-queue', thread: 'u' }, 'codex');
  assert.equal((await wakeSession(s.db, 'U', { ...s.env, CHATTR_CODEX_BIN: bin, FAKE_EXIT: '1' })).reason, 'endpoint_failed');
});

test('the CLI exits 4 for an unknown session and 2 without one', () => {
  const s = setup();
  const run = (...args) => spawnSync(process.execPath, [CLI, 'wake', ...args], { encoding: 'utf8', env: s.env });
  assert.equal(run('ghost').status, 4);
  assert.equal(run().status, 2);
});

test("the sender's hook wakes an idle recipient of a never-injected message", async () => {
  const s = setup();
  const sockPath = path.join(s.dir, `${process.pid}.sock`);
  const sock = await socketAt(sockPath);
  s.enroll('R', { kind: 'uds', path: sockPath });
  s.enroll('S');
  await main(['send', 'R', 'wake up'], { CHATTR_DB: s.file, CHATTR_SESSION: 'S' });
  const r = spawnSync(process.execPath, [CLI, 'hook', 'PostToolUse', '--agent', 'claude'], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'S', tool_name: 'Bash', cwd: s.dir }), encoding: 'utf8', env: s.env,
  });
  assert.equal(r.status, 0, r.stderr);
  await settle();
  sock.close();
  assert.equal(sock.frames.length, 1);
  assert.equal(sock.frames[0].message.content, 'chattr inbox');
});

test("the sender's hook does not wake an idle recipient of a broadcast", async () => {
  const s = setup();
  spawnSync('git', ['init', '-q', s.dir]);
  const sockPath = path.join(s.dir, `${process.pid}.sock`);
  const sock = await socketAt(sockPath);
  s.enroll('R', { kind: 'uds', path: sockPath });
  s.enroll('S');
  const sent = await main(['broadcast', 'taking issue 115'], { CHATTR_DB: s.file, CHATTR_SESSION: 'S' });
  assert.deepEqual(sent.output.recipients, ['R']);
  const r = spawnSync(process.execPath, [CLI, 'hook', 'PostToolUse', '--agent', 'claude'], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'S', tool_name: 'Bash', cwd: s.dir }), encoding: 'utf8', env: s.env,
  });
  assert.equal(r.status, 0, r.stderr);
  await settle();
  sock.close();
  assert.equal(sock.frames.length, 0);
});
