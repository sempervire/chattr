import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { open, join as chattrJoin, readPidStart } from '../../chattr.mjs'

const SCRIPT = fileURLToPath(new URL('../worktree-guard.mjs', import.meta.url))
const CHATTR_BIN = fileURLToPath(new URL('../../chattr.mjs', import.meta.url))
const PID_START = readPidStart(process.pid)

// `chattr who --coverage` counts real `claude`/`codex` root processes via
// `ps` (chattr/SPEC.md section 3, `coverage()`), which this machine always
// has some of while these tests run inside a live session. A fake `ps` ahead
// of the real one on PATH makes that count something the test controls
// instead of something the test environment dictates. Only the aggregate
// `-Ao pid=,ppid=,comm=` scan is faked; a per-pid `-p` lookup (readPidStart,
// used for liveness/pid_start checks) delegates to the real `/bin/ps`, or
// every enrolled test session would look "gone".
const FAKE_PS = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args.includes('-ww')) {
  // chattr's host-args scan: no fake root is an app-server or sandbox host
} else if (args.includes('-p')) {
  try {
    process.stdout.write(execFileSync('/bin/ps', args, { encoding: 'utf8' }))
  } catch {
    process.exitCode = 1
  }
} else {
  process.stdout.write(process.env.FAKE_PS_LINES || '')
}
`

// Likewise a fake `lsof`, so coverage's cwd scoping (`who --coverage --cwd`) reads
// the working directories the test assigns, as "p<pid>\nn<cwd>" lines. Unset, it
// reports nothing: every fake process has an unreadable cwd and still counts.
const FAKE_LSOF = `#!/usr/bin/env node
process.stdout.write(process.env.FAKE_LSOF_LINES || '')
`

function run({ stdin, env }) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: stdin === undefined ? '' : stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('worktree-guard', () => {
  let root, binDir, workDir
  let dbCounter = 0

  test.before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-guard-')))
    binDir = join(root, 'bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'ps'), FAKE_PS)
    chmodSync(join(binDir, 'ps'), 0o755)
    writeFileSync(join(binDir, 'lsof'), FAKE_LSOF)
    chmodSync(join(binDir, 'lsof'), 0o755)
    workDir = join(root, 'work')
    mkdirSync(workDir)
  })
  test.after(() => rmSync(root, { recursive: true, force: true }))

  // A fresh DB file per call, never shared across tests: `chattr` sessions
  // persist in the file, and reusing one across tests makes an earlier test's
  // enrollment leak into a later test's coverage/rival count.
  const freshDbFile = () => join(root, `bridge-${dbCounter++}.db`)

  // A getter, not a value computed at describe-body time: `binDir` is still
  // undefined when this describe callback runs (test.before has not fired
  // yet), so capturing `${binDir}/...` here would bake in "undefined".
  const realChattrEnv = (dbFile, extra = {}) => ({
    PATH: `${binDir}:${process.env.PATH}`,
    CHATTR_BIN,
    CHATTR_DB: dbFile,
    FAKE_PS_LINES: '',
    ...extra,
  })

  test('denies when the hook payload cannot be parsed, even with the escape hatch unset', () => {
    const result = run({ stdin: '{ not json', env: realChattrEnv(freshDbFile()) })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /could not read the hook payload/)
  })

  test('allows immediately when CLAUDE_ALLOW_SHARED_CWD is set, without consulting chattr', () => {
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile(), {
        CLAUDE_ALLOW_SHARED_CWD: '1',
        CHATTR_BIN: join(root, 'no-such-binary'),
      }),
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })

  test('allows an edit whose target resolves outside this session\'s cwd, without consulting chattr', () => {
    const outsideDir = join(root, 'elsewhere')
    mkdirSync(outsideDir, { recursive: true })
    const result = run({
      stdin: JSON.stringify({
        cwd: workDir,
        session_id: 'me',
        tool_input: { file_path: join(outsideDir, 'file.txt') },
      }),
      env: realChattrEnv(freshDbFile(), { CHATTR_BIN: join(root, 'no-such-binary') }),
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })

  test('fails closed when chattr itself is unreachable', () => {
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile(), { CHATTR_BIN: join(root, 'no-such-binary') }),
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /could not enumerate live sessions via chattr/)
  })

  test('denies on short coverage, with no rival enrolled at all', () => {
    // Two live claude processes "exist" (per the fake ps), zero enrolled: the
    // real chattr.mjs computes coverage.complete = false against this DB.
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile(), { FAKE_PS_LINES: '1001 1 claude\n1002 1 claude\n' }),
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /incomplete peer coverage/)
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /2 live claude\/codex processes not enrolled/)
  })

  test('allows when the only unenrolled processes run in another directory', () => {
    // Three codex processes elsewhere (the ChatGPT app's, in the main checkout)
    // cannot be the same-cwd rival the guard looks for.
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile(), {
        FAKE_PS_LINES: '2001 1 codex\n2002 1 codex\n2003 1 codex\n',
        FAKE_LSOF_LINES: `p2001\nn${elsewhere}\np2002\nn${elsewhere}\np2003\nn${elsewhere}\n`,
      }),
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })

  test('denies when an unenrolled process runs in this directory, or its cwd is unreadable', () => {
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile(), {
        FAKE_PS_LINES: '2001 1 codex\n2002 1 codex\n',
        FAKE_LSOF_LINES: `p2001\nn${workDir}\n`, // 2002: no cwd reported
      }),
    })
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /2 live claude\/codex processes not enrolled/)
  })

  test('allows when who --repo is empty AND coverage is complete', () => {
    // No fake ps processes, nothing enrolled: 0 >= 0 on both kinds is complete
    // (chattr.mjs's own `coverage()`), and there is nothing to rule out.
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile()),
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })

  test('denies when a rival shares this exact cwd, even with complete coverage', () => {
    const dbFile = freshDbFile()
    const db = open(dbFile)
    chattrJoin(db, { id: 'other', kind: 'claude', pid: process.pid, pidStart: PID_START, cwd: workDir })
    db.close()
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(dbFile, { FAKE_PS_LINES: '1001 1 claude\n' }), // one process, one enrolled -> complete
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /another session is live/)
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /"other"/)
  })
})
