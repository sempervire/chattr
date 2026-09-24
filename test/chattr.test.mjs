import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claim, join, main, markContinued, open, readPidStart, release, turn } from '../chattr.mjs';

const CLI = fileURLToPath(new URL('../chattr.mjs', import.meta.url));
const REPO_CWD = path.dirname(CLI);
const PID_START = readPidStart(process.pid);

function bus() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chattr-test-'));
  const file = path.join(dir, 'bridge.db');
  const db = open(file);
  const as = (id) => async (...argv) => {
    const { code, output } = await main(argv, { CHATTR_DB: file, ...(id ? { CHATTR_SESSION: id } : {}) });
    return { code, ...output };
  };
  const enroll = (id, opts = {}) => join(db, { id, kind: 'claude', pid: process.pid, pidStart: PID_START, cwd: REPO_CWD, ...opts });
  return { dir, file, db, as, enroll };
}

async function trio() {
  const b = bus();
  for (const id of ['A', 'B', 'C']) b.enroll(id);
  return { ...b, A: b.as('A'), B: b.as('B'), C: b.as('C') };
}

const stateOf = async (who, uuid) => (await who('status', uuid)).summary;

test('stop acks only earlier batches of the same incarnation, with or without a new batch', async () => {
  const { db, A, B } = await trio();
  const m1 = (await A('send', 'B', 'one')).message.uuid;
  assert.equal(turn(db, 'B', 'start').messages[0].uuid, m1);
  const m2 = (await A('send', 'B', 'two')).message.uuid;
  const stop = turn(db, 'B', 'stop');
  assert.equal(stop.acked, 1);
  assert.deepEqual(stop.messages.map((m) => m.uuid), [m2]);
  assert.equal(await stateOf(B, m1), 'acked');
  assert.equal(await stateOf(B, m2), 'injected');
  const quiet = turn(db, 'B', 'stop');
  assert.deepEqual([quiet.acked, quiet.batch], [1, null]);
  assert.equal(await stateOf(B, m2), 'acked');
});

test('a delivery injected at start is not injected again at prompt', async () => {
  const { db, A } = await trio();
  await A('send', 'B', 'hello');
  assert.equal(turn(db, 'B', 'start').messages.length, 1);
  const prompt = turn(db, 'B', 'prompt');
  assert.deepEqual([prompt.batch, prompt.messages.length], [null, 0]);
});

test('resume re-injects once with attempts+1, then the next stop acks; compact keeps the incarnation', async () => {
  const { db, A, B, enroll } = await trio();
  const uuid = (await A('send', 'B', 'survive')).message.uuid;
  turn(db, 'B', 'start');
  const before = db.prepare("SELECT incarnation FROM sessions WHERE id = 'B'").get().incarnation;
  assert.equal(enroll('B', { source: 'compact' }).incarnation, before);
  assert.equal(turn(db, 'B', 'prompt').messages.length, 0);
  assert.notEqual(enroll('B', { source: 'resume' }).incarnation, before);
  assert.equal(turn(db, 'B', 'start').messages.length, 1);
  assert.equal(turn(db, 'B', 'prompt').messages.length, 0);
  assert.equal((await B('status', uuid)).recipients[0].attempts, 2);
  turn(db, 'B', 'stop');
  assert.equal(await stateOf(B, uuid), 'acked');
});

test('attempts > 3 marks the delivery stale and stops injecting it', async () => {
  const { db, A, enroll } = await trio();
  const uuid = (await A('send', 'B', 'never read')).message.uuid;
  for (let i = 0; i < 3; i++) {
    assert.equal(turn(db, 'B', 'start').messages.length, 1);
    enroll('B', { source: 'resume' });
  }
  assert.equal(turn(db, 'B', 'start').messages.length, 0);
  const status = await A('status', uuid);
  assert.deepEqual([status.summary, status.recipients[0].attempts], ['stale', 4]);
});

test('who marks pid reuse and dead pids gone without deleting rows', async () => {
  const { A, enroll } = await trio();
  enroll('reused', { pidStart: 'Thu Jan  1 00:00:00 1970' });
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  enroll('dead', { pid: Number(dead) });
  const live = (await A('who')).sessions.map((s) => s.id);
  assert.deepEqual(live, ['A', 'B', 'C']);
  const all = Object.fromEntries((await A('who', '--all')).sessions.map((s) => [s.id, s.status]));
  assert.deepEqual([all.reused, all.dead], ['gone', 'gone']);
  const coverage = (await A('who', '--coverage')).coverage;
  assert.deepEqual(Object.keys(coverage.processes), ['claude', 'codex']);
  assert.equal(coverage.enrolled.claude, 1); // A, B and C share this process's pid: one enrolled process
});

test('stale last_seen with a live pid is unknown, not absent', async () => {
  const { db, A } = await trio();
  db.prepare("UPDATE sessions SET last_seen = 0 WHERE id = 'C'").run();
  assert.equal((await A('who')).sessions.find((s) => s.id === 'C').status, 'unknown');
});

test('duplicate ack is a no-op', async () => {
  const { A, B } = await trio();
  const uuid = (await A('send', 'B', 'x')).message.uuid;
  assert.deepEqual((await B('ack', uuid, 'nope')).acked, [uuid]);
  const again = await B('ack', uuid);
  assert.deepEqual([again.acked, again.already], [[], [uuid]]);
  assert.equal(await stateOf(B, uuid), 'acked');
});

test('expired and superseded messages are not injected; only the sender may change them', async () => {
  const { db, A, B } = await trio();
  const gone = (await A('send', 'B', 'old news')).message.uuid;
  const old = (await A('send', 'B', 'v1')).message.uuid;
  const next = (await A('send', 'B', 'v2')).message.uuid;
  assert.equal((await B('expire', gone)).code, 4);
  assert.equal((await A('expire', gone)).code, 0);
  assert.equal((await A('supersede', old, next)).message.superseded_by, next);
  assert.deepEqual(turn(db, 'B', 'start').messages.map((m) => m.body), ['v2']);
  assert.equal(await stateOf(A, gone), 'expired');
  assert.equal(await stateOf(A, old), 'superseded');
  assert.deepEqual((await B('inbox')).messages.map((m) => m.body), ['v2']);
});

test('reply correlates to its consult, stores status, acks the consult and reaches the asker', async () => {
  const { db, A, B, C } = await trio();
  const consult = (await A('consult', 'B', 'thoughts?')).message.uuid;
  assert.equal((await C('reply', '--to', consult, 'not mine')).code, 4);
  const reply = await B('reply', '--to', consult, '--status', 'interrupted', 'ran out of time');
  assert.deepEqual([reply.message.type, reply.message.reply_to, reply.recipients], ['reply', consult, ['A']]);
  const status = await A('status', consult);
  assert.deepEqual([status.summary, status.recipients[0].state], ['interrupted', 'acked']);
  assert.equal(turn(db, 'A', 'prompt').messages[0].uuid, reply.message.uuid);
  assert.equal((await B('reply', '--to', consult, '--status', 'maybe', 'x')).code, 2);
});

test('multi-recipient status lists every recipient and summarizes the least advanced', async () => {
  const { db, A } = await trio();
  const cast = await A('broadcast', 'all hands');
  assert.deepEqual(cast.recipients.sort(), ['B', 'C']);
  turn(db, 'B', 'start');
  turn(db, 'B', 'stop');
  let status = await A('status', cast.message.uuid);
  assert.deepEqual(status.recipients.map((r) => r.state), ['acked', 'queued']);
  assert.equal(status.summary, 'queued');
  turn(db, 'C', 'prompt');
  status = await A('status', cast.message.uuid);
  assert.equal(status.summary, 'injected');
});

test('broadcast and kind: exclude the sender and other repos; null repo is addressed-only', async () => {
  const { A, enroll, as, dir } = await trio();
  enroll('X', { kind: 'codex' });
  enroll('elsewhere', { cwd: dir });
  assert.deepEqual((await A('broadcast', 'hi')).recipients.sort(), ['B', 'C', 'X']);
  assert.deepEqual((await A('send', 'kind:codex', 'hey')).recipients, ['X']);
  assert.equal((await A('send', 'kind:qwen', 'hey')).code, 4);
  const outsider = as('elsewhere');
  assert.equal((await outsider('broadcast', 'hi')).error.code, 'repo_required');
  assert.equal((await outsider('send', 'kind:claude', 'hi')).code, 4);
  assert.equal((await outsider('send', 'A', 'direct is fine')).code, 0);
});

test('tool events carry a one-line notice for a pending broadcast and never inject', async () => {
  const { db, A } = await trio();
  await A('send', 'B', 'plain');
  assert.equal(turn(db, 'B', 'tool').notice, null);
  await A('broadcast', 'heads up');
  const tool = turn(db, 'B', 'tool');
  assert.match(tool.notice, /1 broadcast/);
  assert.equal(tool.batch, null);
  const stop = turn(db, 'B', 'stop');
  markContinued(db, stop.batch);
  assert.equal(db.prepare('SELECT continued FROM batches WHERE id = ?').get(stop.batch).continued, 1);
  assert.equal((await A('status', 'B')).session.status, 'working');
});

test('inbox pages with --after in created_at, uuid order; state shows peers, broadcasts, unacked', async () => {
  const { A, B } = await trio();
  const sent = [];
  for (const body of ['1', '2', '3']) sent.push((await A('send', 'B', body)).message.uuid);
  await A('broadcast', 'b');
  const page = await B('inbox', '--after', sent[0], '--limit', '2');
  assert.deepEqual(page.messages.map((m) => m.body), ['2', '3']);
  const state = await B('state');
  assert.deepEqual(state.peers.map((p) => p.id), ['A', 'C']);
  assert.deepEqual([state.broadcasts.length, state.unacked.length], [1, 4]);
});

test('a stop holding only broadcasts injects nothing; they ride with a directed message or the next prompt', async () => {
  const { db, A } = await trio();
  await A('broadcast', 'taking the thing');
  const quiet = turn(db, 'B', 'stop');
  assert.deepEqual([quiet.batch, quiet.messages.length], [null, 0]);
  assert.match(turn(db, 'B', 'tool').notice, /next prompt/);
  await A('send', 'B', 'direct');
  assert.deepEqual(turn(db, 'B', 'stop').messages.map((m) => m.body), ['taking the thing', 'direct']);
  assert.deepEqual(turn(db, 'C', 'prompt').messages.map((m) => m.body), ['taking the thing']);
});

const broadcastCount = (db) => db.prepare("SELECT count(*) AS n FROM messages WHERE type = 'broadcast'").get().n;

test('claim is first-wins and announces once; a conflict names the owner; a repeat is a no-op', async () => {
  const { db, A, B } = await trio();
  const won = await A('claim', 'issue:115', 'claims table,', 'branch feat/115-claims');
  assert.equal(won.code, 0);
  assert.deepEqual([won.claim.resource, won.claim.session_id, won.claim.note, won.already], ['issue:115', 'A', 'claims table, branch feat/115-claims', false]);
  assert.deepEqual([won.message.type, won.recipients.sort()], ['broadcast', ['B', 'C']]);
  assert.match(won.message.body, /^claim issue:115: claims table/);
  const lost = await B('claim', 'Issue:115');
  assert.deepEqual([lost.code, lost.error.code, lost.claim.session_id], [4, 'claimed', 'A']);
  const again = await A('claim', 'issue:115', 'a different note');
  assert.deepEqual([again.code, again.already, again.message, again.claim.id], [0, true, null, won.claim.id]);
  assert.equal(broadcastCount(db), 1);
  assert.equal((await A('claim', '115')).code, 2);
  assert.equal((await A('claim')).code, 2);
});

test('release is owner-only, announces once, is repeat-safe and frees the resource', async () => {
  const { db, A, B } = await trio();
  await A('claim', 'resource:preview-db');
  const thief = await B('release', 'resource:preview-db');
  assert.deepEqual([thief.code, thief.error.code, thief.claim.session_id], [4, 'not_owner', 'A']);
  const done = await A('release', 'resource:preview-db', 'migration applied');
  assert.deepEqual([done.code, done.already, done.claim.release_reason, done.message.type], [0, false, 'released', 'broadcast']);
  assert.match(done.message.body, /^release resource:preview-db: migration applied/);
  assert.ok(done.claim.released_at);
  const again = await A('release', 'resource:preview-db');
  assert.deepEqual([again.code, again.already, again.message], [0, true, null]);
  assert.equal(broadcastCount(db), 2);
  assert.equal((await B('claim', 'resource:preview-db')).code, 0);
  assert.equal((await A('release', 'resource:preview-db')).already, true);
  assert.equal((await A('state')).claims[0].session_id, 'B');
  assert.equal((await A('release', 'issue:404')).error.code, 'unknown_claim');
});

test('a claim and its announcement commit together or not at all', async () => {
  const { db, A } = await trio();
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'boom'); END");
  await assert.rejects(A('claim', 'issue:1'), /boom/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM claims').get().n, 0);
  db.exec('DROP TRIGGER boom');
  await A('claim', 'issue:1');
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'boom'); END");
  await assert.rejects(A('release', 'issue:1'), /boom/);
  assert.equal(db.prepare('SELECT released_at FROM claims').get().released_at, null);
});

test('state lists every active claim in the repo, whatever the broadcast window holds', async () => {
  const { A, enroll, as, dir } = await trio();
  await A('claim', 'issue:1', 'old work');
  for (let n = 0; n < 12; n++) await A('broadcast', `noise ${n}`);
  enroll('late');
  const seen = await as('late')('state');
  assert.equal(seen.broadcasts.length, 10);
  assert.deepEqual(seen.claims.map((c) => [c.resource, c.session_id, c.mine, c.owner_status, c.stale]), [['issue:1', 'A', false, 'idle', false]]);
  assert.equal((await A('state')).claims[0].mine, true);
  enroll('elsewhere', { cwd: dir });
  assert.equal((await as('elsewhere')('claim', 'issue:1')).error.code, 'repo_required');
  assert.deepEqual((await as('elsewhere')('state')).claims, []);
});

test('a gone owner loses its claim with a recorded reason; an unknown or idle owner keeps it', async () => {
  const { db, A, B, C } = await trio();
  await B('claim', 'issue:1');
  await C('claim', 'issue:2');
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  db.prepare("UPDATE sessions SET pid = ?, pid_start = NULL WHERE id = 'B'").run(Number(dead));
  db.prepare("UPDATE sessions SET last_seen = 0 WHERE id = 'C'").run();
  assert.deepEqual((await A('state')).claims.map((c) => [c.resource, c.owner_status]), [['issue:2', 'unknown']]);
  assert.equal(db.prepare("SELECT release_reason FROM claims WHERE resource = 'issue:1'").get().release_reason, 'owner_gone');
  assert.equal((await A('claim', 'issue:2')).code, 4);
  assert.equal((await A('claim', 'issue:1')).code, 0);
});

test('a stale incarnation can neither claim nor release; a resumed owner holds a flagged claim until it re-claims', async () => {
  const { db, A, B, enroll } = await trio();
  const before = db.prepare("SELECT * FROM sessions WHERE id = 'A'").get();
  await A('claim', 'issue:1');
  enroll('A', { source: 'resume' });
  assert.equal((await B('state')).claims[0].stale, true);
  assert.equal((await B('claim', 'issue:1')).code, 4);
  assert.throws(() => release(db, before, 'issue:1'), { code: 'stale_incarnation' });
  assert.throws(() => claim(db, before, 'issue:2'), { code: 'stale_incarnation' });
  const back = await A('claim', 'issue:1');
  assert.deepEqual([back.code, back.already, back.message], [0, true, null]);
  assert.equal((await B('state')).claims[0].stale, false);
});

test('an owner that re-joins from another repo still sees and can release its claim', async () => {
  const { A, B, enroll, dir } = await trio();
  await A('claim', 'issue:3');
  const other = path.join(dir, 'other-repo');
  spawnSync('git', ['init', '-q', other]);
  enroll('A', { source: 'compact', cwd: other });
  assert.deepEqual((await A('state')).claims.map((c) => [c.resource, c.mine]), [['issue:3', true]]);
  assert.equal((await B('claim', 'issue:3')).code, 4);
  const freed = await A('release', 'issue:3');
  assert.deepEqual([freed.code, freed.already, freed.recipients.sort()], [0, false, ['B', 'C']]);
  assert.equal((await B('claim', 'issue:3')).code, 0);
});

test("a reader in another time zone or locale does not judge a live owner gone", async () => {
  const { db, file, B, enroll } = await trio();
  await B('claim', 'issue:2');
  const legacy = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim();
  enroll('C', { pidStart: legacy });
  assert.deepEqual((await B('who')).sessions.map((s) => s.id), ['A', 'B', 'C'], 'a row joined before the pin survives the upgrade');
  enroll('C');
  const far = spawnSync(process.execPath, [CLI, 'state'], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Tokyo', LC_ALL: 'de_DE.UTF-8', CHATTR_DB: file, CHATTR_SESSION: 'A' } });
  const seen = JSON.parse(far.stdout);
  assert.deepEqual(seen.claims.map((c) => c.resource), ['issue:2']);
  assert.deepEqual(seen.peers.map((p) => p.id), ['B', 'C']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE status = 'gone'").get().n, 0);
});

test('a session marked gone cannot claim until it re-joins', async () => {
  const { db, A, B, enroll } = await trio();
  await A('claim', 'issue:1');
  await A('leave');
  const refused = await A('claim', 'issue:9');
  assert.deepEqual([refused.code, refused.error.code], [3, 'session_gone']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM claims WHERE resource = 'issue:9'").get().n, 0);
  assert.equal(broadcastCount(db), 1);
  enroll('A', { source: 'resume' });
  assert.equal((await A('claim', 'issue:9')).code, 0);
  assert.equal((await B('claim', 'issue:9')).code, 4);
});

test('a claim note keeps words that look like flags, and a stdin note is trimmed', async () => {
  const { A } = await trio();
  const won = await A('claim', 'issue:5', 'fix', '--force', 'handling,', 'use', '--json', 'output', '--trailing', '--json');
  assert.deepEqual([won.code, won.claim.note], [0, 'fix --force handling, use --json output --trailing']);
});

test('8 concurrent claims on one resource yield one owner and one announcement', async () => {
  const { db, file, enroll } = bus();
  for (let i = 0; i < 8; i++) enroll(`w${i}`);
  const worker = `
    const { main } = await import(${JSON.stringify(CLI)});
    const r = await main(['claim', 'issue:115'], { CHATTR_DB: ${JSON.stringify(file)}, CHATTR_SESSION: process.argv[1] });
    process.exit(r.code);`;
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    spawn(process.execPath, ['--input-type=module', '-e', worker, `w${i}`], { stdio: 'inherit' }).on('exit', resolve);
  })));
  assert.deepEqual(codes.sort(), [0, 4, 4, 4, 4, 4, 4, 4]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM claims WHERE released_at IS NULL').get().n, 1);
  assert.equal(broadcastCount(db), 1);
});

test('exit codes: 2 usage, 3 not enrolled, 4 unknown recipient; hook and wake dispatch', async () => {
  const { as, A } = await trio();
  assert.equal((await as(null)('inbox')).code, 3);
  assert.equal((await as('stranger')('send', 'A', 'x')).code, 3);
  assert.equal((await A('send', 'nobody', 'x')).code, 4);
  assert.equal((await A('frobnicate')).code, 2);
  assert.equal((await A('send', 'B')).code, 2);
  assert.equal((await A('hook', 'stop')).code, 2);
  assert.equal((await A('wake')).code, 2);
});

test('the CLI binary joins from CODEX_THREAD_ID, prints JSON or text, and propagates exit codes', () => {
  const { file } = bus();
  const env = { ...process.env, CHATTR_DB: file, CODEX_THREAD_ID: 'thread-1' };
  delete env.CHATTR_SESSION;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, cwd: REPO_CWD, encoding: 'utf8' });
  const joined = run('join', '--kind', 'codex', '--pid', String(process.pid));
  assert.equal(joined.status, 0);
  assert.equal(JSON.parse(joined.stdout).session.id, 'thread-1');
  assert.match(run('who', '--text').stdout, /id=thread-1 kind=codex/);
  assert.equal(run('send', 'ghost', 'x').status, 4);
});

test('8 concurrent processes x 50 sends lose and duplicate nothing', async () => {
  const { db, file, enroll } = bus();
  enroll('sink');
  for (let i = 0; i < 8; i++) enroll(`w${i}`);
  const worker = `
    const { main } = await import(${JSON.stringify(CLI)});
    for (let n = 0; n < 50; n++) {
      const r = await main(['send', 'sink', 'msg-' + n], { CHATTR_DB: ${JSON.stringify(file)}, CHATTR_SESSION: process.argv[1] });
      if (r.code !== 0) { console.error(JSON.stringify(r)); process.exit(1); }
    }`;
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    spawn(process.execPath, ['--input-type=module', '-e', worker, `w${i}`], { stdio: 'inherit' }).on('exit', resolve);
  })));
  assert.deepEqual(codes, Array(8).fill(0));
  const counts = db.prepare(`SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(DISTINCT uuid) FROM messages) AS uuids,
    (SELECT count(*) FROM deliveries WHERE session_id = 'sink') AS deliveries`).get();
  assert.deepEqual({ ...counts }, { messages: 400, uuids: 400, deliveries: 400 });
});

// A fake `ps`/`lsof` ahead of the real ones on PATH (as in hooks/test) so coverage counts processes
// the test controls. `ps -p` still reaches /bin/ps, or enrolled sessions look gone. Each proc is
// {pid, ppid = 1, comm = 'codex', args, cwd}: `comm` answers the root scan, `args` (when set) the
// `-ww` host scan, which `argsFail` makes exit nonzero. `log` records every ps call's arguments.
function fakeCoverage(prefix) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'ps'), `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_PS_LOG) appendFileSync(process.env.FAKE_PS_LOG, args.join(' ') + '\\n');
if (args.includes('-ww')) { if (process.env.FAKE_PS_ARGS_FAIL) process.exitCode = 1; else process.stdout.write(process.env.FAKE_PS_ARGS_LINES || ''); }
else if (args.includes('-p')) { try { process.stdout.write(execFileSync('/bin/ps', args, { encoding: 'utf8' })); } catch { process.exitCode = 1; } }
else process.stdout.write(process.env.FAKE_PS_LINES || '');
`);
  writeFileSync(path.join(bin, 'lsof'), "#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_LSOF_LINES || '');\n");
  for (const f of ['ps', 'lsof']) chmodSync(path.join(bin, f), 0o755);
  const file = path.join(root, 'bridge.db');
  const db = open(file);
  const enroll = (id, kind, cwd = root) => join(db, { id, kind, pid: process.pid, pidStart: PID_START, cwd });
  const cover = (procs, scope = [], { argsFail = false, log = null } = {}) => JSON.parse(spawnSync(process.execPath, [CLI, 'who', '--coverage', ...scope], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CHATTR_DB: file,
      FAKE_PS_LINES: procs.map((p) => `${p.pid} ${p.ppid ?? 1} ${p.comm ?? 'codex'}`).join('\n'),
      FAKE_PS_ARGS_LINES: procs.filter((p) => p.args).map((p) => `${p.pid} ${p.args}`).join('\n'),
      FAKE_LSOF_LINES: procs.filter((p) => p.cwd).map((p) => `p${p.pid}\nn${p.cwd}\n`).join(''),
      ...(argsFail ? { FAKE_PS_ARGS_FAIL: '1' } : {}),
      ...(log ? { FAKE_PS_LOG: log } : {}),
    },
  }).stdout).coverage;
  return { root, enroll, cover };
}
const me = process.pid;
const unenrolledPids = (coverage) => coverage.unenrolled.map((u) => u.pid).sort((a, b) => a - b);

test('who --coverage --under counts processes at or below a directory and lists unenrolled ones', () => {
  const { root, enroll, cover } = fakeCoverage('chattr-under-');
  const [work, docs, sibling, outside] = ['work', 'work/docs', 'workx', 'outside'].map((d) => path.join(root, d));
  for (const d of [docs, sibling, outside]) mkdirSync(d, { recursive: true });
  enroll('A', 'claude', work);
  const procs = [{ pid: me, comm: 'claude', cwd: docs }, { pid: 900001, cwd: docs }, { pid: 900002, cwd: sibling }, { pid: 900003, cwd: outside }, { pid: 900004 }];

  // Nested subdir and unreadable cwd count; the sibling-prefix dir and the outside dir do not.
  const all = cover(procs, ['--under', work]);
  assert.deepEqual([all.processes, all.enrolled, all.complete], [{ claude: 1, codex: 2 }, { claude: 1, codex: 0 }, false]);
  assert.deepEqual(all.unenrolled, [{ pid: 900001, kind: 'codex', cwd: docs }, { pid: 900004, kind: 'codex', cwd: null }]);

  const enrolledOnly = cover(procs.slice(0, 1), ['--under', work]);
  assert.deepEqual([enrolledOnly.complete, enrolledOnly.unenrolled], [true, []]);
  assert.deepEqual(cover(procs.slice(2, 4), ['--under', work]).processes, { claude: 0, codex: 0 });

  // --cwd stays exact: the subdir processes fall out, the unreadable one still counts.
  assert.deepEqual(cover(procs, ['--cwd', work]).processes, { claude: 0, codex: 1 });
});

// Issue #27: a persistent `codex … app-server` host -- the VS Code extension or the ChatGPT app --
// was counted as an unenrolled Codex session, so coverage never went complete.
test('who --coverage excludes app-server hosts but still counts CLI roots, prompts that mention app-server, and roots missing from the args scan', () => {
  const { enroll, cover } = fakeCoverage('chattr-appserver-');
  enroll('A', 'codex');
  // me: enrolled CLI root. 910001: ordinary unenrolled CLI root (counts). 910002: a real app-server
  // host, `-c key=value` pairs before the subcommand exactly like the ChatGPT app (must not count).
  // 910003: CLI root whose prompt merely mentions "app-server" (still counts). 910004: a root the
  // args scan doesn't answer at all (fail closed -- still counts).
  const coverage = cover([
    { pid: me, args: '/usr/local/bin/codex' },
    { pid: 910001, args: '/usr/local/bin/codex' },
    { pid: 910002, args: '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --port 0' },
    { pid: 910003, args: '/usr/local/bin/codex fix the app-server bug' },
    { pid: 910004 },
  ]);
  assert.equal(coverage.processes.codex, 4);
  assert.deepEqual(unenrolledPids(coverage), [910001, 910003, 910004]);
});

// Issue #27 verification repro: conversations enrolled inside an app-server host share the host's
// pid, and counted as enrolled they offset an unrelated unenrolled CLI root, so coverage said
// complete. Also `codex sandbox [OPTIONS] -- cmd` roots (the ChatGPT app's tool sandboxes) are
// hosts, a prompt that starts with "sandbox" is not, and a codex child of a host is not a root either
// (hosts spawn helpers such as `codex exec` or `codex mcp-server`).
test('who --coverage does not count host-enrolled sessions, excludes sandbox hosts, and does not count their codex children', () => {
  const { enroll, cover } = fakeCoverage('chattr-hosts-');
  // Two conversations enrolled at the app-server host's pid (this process stands in for the host).
  enroll('H1', 'codex');
  enroll('H2', 'codex');
  const procs = [
    { pid: me, args: '/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://' },
    { pid: 920001, args: '/usr/local/bin/codex' },
    { pid: 920002, args: '/Applications/ChatGPT.app/Contents/Resources/codex sandbox -c shell_environment_policy.inherit="all" -c permissions.node_repl={filesystem = {":root" = "read"}} -- /bin/node kernel.js' },
    { pid: 920003, args: '/usr/local/bin/codex sandbox mode is broken' },
    { pid: 920004, ppid: 920002, args: '/usr/local/bin/codex exec hi' },
  ];
  // The live repro alone: host + one unenrolled CLI root. Before the fix, enrolled 2 >= processes 1.
  const repro = cover(procs.slice(0, 2));
  assert.deepEqual([repro.processes.codex, repro.enrolled.codex, repro.complete], [1, 0, false]);
  const coverage = cover(procs);
  assert.deepEqual([coverage.processes.codex, coverage.enrolled.codex, coverage.complete], [2, 0, false]);
  assert.deepEqual(unenrolledPids(coverage), [920001, 920003]);
});

// `/clear` or `/new` leaves two live rows at one CLI pid: they are one enrolled process, not two.
test('who --coverage counts enrolled sessions by distinct pid', () => {
  const { enroll, cover } = fakeCoverage('chattr-dup-');
  enroll('D1', 'codex');
  enroll('D2', 'codex');
  const coverage = cover([{ pid: me, args: '/usr/local/bin/codex' }, { pid: 930001, args: '/usr/local/bin/codex' }]);
  assert.deepEqual([coverage.processes.codex, coverage.enrolled.codex, coverage.complete], [2, 1, false]);
});

// Without the args scan no host is known, so sessions at a host pid could offset an unenrolled root
// (here the host's own process is out of --cwd scope while its sessions are in it): fail closed.
test('who --coverage is incomplete when the host args scan fails', () => {
  const { root, enroll, cover } = fakeCoverage('chattr-argsfail-');
  const [work, other] = ['work', 'other'].map((d) => path.join(root, d));
  for (const d of [work, other]) mkdirSync(d);
  enroll('H1', 'codex', work);
  enroll('H2', 'codex', work);
  const procs = [{ pid: me, cwd: other, args: '/Applications/ChatGPT.app/Contents/Resources/codex app-server' }, { pid: 930002, cwd: work, args: '/usr/local/bin/codex' }];
  assert.equal(cover(procs, ['--cwd', work]).complete, false);
  assert.equal(cover(procs, ['--cwd', work], { argsFail: true }).complete, false);
});

test('who --coverage host classification: spaced executable paths, spaced -c values, sandbox-like prompts', () => {
  const { cover } = fakeCoverage('chattr-classify-');
  const appSupport = '/Users/x/Library/Application Support/Codex/bin/codex';
  const coverage = cover([
    { pid: 940001, comm: appSupport, args: `${appSupport} app-server --listen stdio://` },
    { pid: 940002, args: '/usr/local/bin/codex -c x={a = 1, b = "c d"} -c y="e f" app-server' },
    { pid: 940003, args: '/usr/local/bin/codex sandbox - why does it fail?' },
    { pid: 940004, args: '/usr/local/bin/codex sandbox --help output is wrong' },
    { pid: 940005, args: '/Applications/ChatGPT.app/Contents/Resources/codex sandbox -c permissions.node_repl={filesystem = {":root" = "read"}, network = {enabled = false}} -- /bin/node kernel.js --session-id x' },
    { pid: 940006, args: '/usr/local/bin/codex sandbox -- /bin/sh -c true' },
    { pid: 940007, args: '/usr/local/bin/codex --config a=b app-server' },
    { pid: 940008, args: '/usr/local/bin/codex -p work app-server' },
    { pid: 940009, args: '/usr/local/bin/codex -m o3 fix app-server' },
    { pid: 940010, args: '/usr/local/bin/codex --profile=work --no-alt-screen -c=k={a = 1} app-server' },
  ]);
  assert.deepEqual(unenrolledPids(coverage), [940003, 940004, 940009]);
});

test('who --coverage returns complete:false, not an error, when ps cannot be spawned', () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'chattr-nops-'));
  const out = spawnSync(process.execPath, [CLI, 'who', '--coverage'], {
    encoding: 'utf8', env: { ...process.env, PATH: empty, CHATTR_DB: path.join(empty, 'bridge.db') },
  });
  assert.equal(JSON.parse(out.stdout).coverage.complete, false);
});

// The args scan is scoped to the codex roots (like `cwdsOf`'s lsof), and skipped when there are none.
test('who --coverage scans args only for codex roots', () => {
  const { root, cover } = fakeCoverage('chattr-scoped-');
  const log = path.join(root, 'ps.log');
  cover([{ pid: me, comm: 'claude' }, { pid: 950001 }, { pid: 950002, ppid: 950001 }], [], { log });
  cover([{ pid: me, comm: 'claude' }], [], { log });
  const scans = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('-ww'));
  assert.deepEqual(scans, ['-ww -o pid=,args= -p 950001']);
});
