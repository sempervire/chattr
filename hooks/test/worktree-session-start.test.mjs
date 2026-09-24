import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { open, join as chattrJoin, readPidStart } from '../../chattr.mjs'

const SCRIPT = fileURLToPath(new URL('../worktree-session-start.mjs', import.meta.url))
const CHATTR_BIN = fileURLToPath(new URL('../../chattr.mjs', import.meta.url))
const PID_START = readPidStart(process.pid)

// See worktree-guard.test.mjs: a fake `ps` ahead of the real one on PATH lets
// coverage() count something the test controls, not this machine's real
// claude/codex processes. A per-pid `-p` lookup still delegates to the real
// `/bin/ps`, or every enrolled test session would look "gone".
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

describe('worktree-session-start', () => {
  let root, binDir, workDir, otherDir
  let dbCounter = 0

  test.before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-session-start-')))
    binDir = join(root, 'bin')
    mkdirSync(binDir)
    writeFileSync(join(binDir, 'ps'), FAKE_PS)
    chmodSync(join(binDir, 'ps'), 0o755)
    writeFileSync(join(binDir, 'lsof'), FAKE_LSOF)
    chmodSync(join(binDir, 'lsof'), 0o755)
    workDir = join(root, 'work')
    mkdirSync(workDir)
    otherDir = join(root, 'work-other-worktree')
    mkdirSync(otherDir)
  })
  test.after(() => rmSync(root, { recursive: true, force: true }))

  // A fresh DB file per call, never shared across tests: `chattr` sessions
  // persist in the file, and reusing one across tests makes an earlier test's
  // enrollment leak into a later test's coverage/rival count.
  const freshDbFile = () => join(root, `bridge-${dbCounter++}.db`)

  const realChattrEnv = (dbFile, extra = {}) => ({
    PATH: `${binDir}:${process.env.PATH}`,
    CHATTR_BIN,
    CHATTR_DB: dbFile,
    FAKE_PS_LINES: '',
    ...extra,
  })

  test('says nothing when who --repo is empty and coverage is complete', () => {
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile()),
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })

  test('prints "peers: unknown (N unenrolled)" when coverage is short, even with no known rival', () => {
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile(), { FAKE_PS_LINES: '2001 1 claude\n2002 1 codex\n' }),
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.match(out.hookSpecificOutput.additionalContext, /peers: unknown \(2 unenrolled\)/)
  })

  test('warns on a rival sharing this exact cwd, and coverage is complete once it is enrolled', () => {
    const dbFile = freshDbFile()
    const db = open(dbFile)
    chattrJoin(db, { id: 'other', kind: 'claude', pid: process.pid, pidStart: PID_START, cwd: workDir })
    db.close()
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(dbFile, { FAKE_PS_LINES: '3001 1 claude\n' }), // one process, one enrolled -> complete
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.match(out.hookSpecificOutput.additionalContext, /WARNING: another session is already live/)
    assert.match(out.hookSpecificOutput.additionalContext, /"other"/)
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /peers: unknown/)
  })

  test('lists a same-repo peer in a different worktree without the rival warning, and points at chattr claim', () => {
    const dbFile = freshDbFile()
    const db = open(dbFile)
    chattrJoin(db, { id: 'peer', kind: 'codex', pid: process.pid, pidStart: PID_START, cwd: otherDir })
    db.close()
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      // "peer" (codex) runs in the other worktree, so coverage scoped to workDir is complete.
      env: realChattrEnv(dbFile, { FAKE_PS_LINES: '4002 1 codex\n', FAKE_LSOF_LINES: `p4002\nn${otherDir}\n` }),
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /WARNING: another session is already live/)
    assert.match(out.hookSpecificOutput.additionalContext, /Other live sessions/)
    assert.match(out.hookSpecificOutput.additionalContext, /chattr claim issue:<N>/)
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /peers: unknown/)
  })

  test('a failed chattr lookup is reported as unknown, never as "no peers"', () => {
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(freshDbFile(), { CHATTR_BIN: join(root, 'no-such-binary') }),
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.match(out.hookSpecificOutput.additionalContext, /unknown/)
    assert.match(out.hookSpecificOutput.additionalContext, /Could not enumerate live sessions via chattr/)
  })

  test('CLAUDE_ALLOW_SHARED_CWD silences the rival warning but still lists it as a same-repo peer', () => {
    const dbFile = freshDbFile()
    const db = open(dbFile)
    chattrJoin(db, { id: 'other', kind: 'claude', pid: process.pid, pidStart: PID_START, cwd: workDir })
    db.close()
    const result = run({
      stdin: JSON.stringify({ cwd: workDir, session_id: 'me' }),
      env: realChattrEnv(dbFile, {
        FAKE_PS_LINES: '5001 1 claude\n',
        CLAUDE_ALLOW_SHARED_CWD: '1',
      }),
    })
    assert.equal(result.status, 0)
    const out = JSON.parse(result.stdout)
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /WARNING: another session is already live/)
    assert.match(out.hookSpecificOutput.additionalContext, /Other live sessions/)
  })
})
