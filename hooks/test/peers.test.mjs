import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canonical,
  isInside,
  listRepoSessions,
  coverageComplete,
  unenrolledCount,
  findRepoRivals,
  findRepoPeers,
  describePeers,
} from '../lib/peers.mjs'

describe('canonical', () => {
  let root
  test.before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'peers-canonical-')))
  })
  test.after(() => rmSync(root, { recursive: true, force: true }))

  test('resolves symlinks for an existing path', () => {
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    symlinkSync(real, link)
    assert.equal(canonical(link), real)
  })

  test('a not-yet-existing path still resolves symlinked ancestors', () => {
    const real = join(root, 'real2')
    mkdirSync(real)
    const link = join(root, 'link2')
    symlinkSync(real, link)
    assert.equal(canonical(join(link, 'not-created-yet.txt')), join(real, 'not-created-yet.txt'))
  })
})

describe('isInside', () => {
  test('a path is inside itself and inside its ancestor, never inside a sibling', () => {
    assert.equal(isInside('/repo', '/repo'), true)
    assert.equal(isInside('/repo/sub/file.js', '/repo'), true)
    assert.equal(isInside('/repository', '/repo'), false)
  })
})

describe('listRepoSessions', () => {
  // The one true shape, `chattr/SPEC.md` section 9: `who --repo --coverage`
  // responds `{ok:true, sessions:[...], coverage:{...}}`. No other shape is
  // guessed at any more.
  test('reads sessions and coverage from the SPEC.md response shape', () => {
    const run = () =>
      JSON.stringify({
        ok: true,
        sessions: [{ id: 's1', kind: 'claude', cwd: '/repo', status: 'idle' }],
        coverage: { processes: { claude: 1, codex: 0 }, enrolled: { claude: 1, codex: 0 }, complete: true },
      })
    const { sessions, coverage } = listRepoSessions({ cwd: '/repo', run })
    assert.deepEqual(sessions, [{ id: 's1', kind: 'claude', cwd: '/repo', status: 'idle' }])
    assert.equal(coverage.complete, true)
  })

  test('coverage is null when the response has none', () => {
    const run = () => JSON.stringify({ ok: true, sessions: [] })
    const { coverage } = listRepoSessions({ cwd: '/repo', run })
    assert.equal(coverage, null)
  })

  test('throws, never returns empty, when the command fails to spawn at all', () => {
    const run = () => {
      throw new Error('command not found')
    }
    assert.throws(() => listRepoSessions({ cwd: '/repo', run }), /chattr who --repo failed/)
  })

  test('a non-zero exit surfaces the {ok:false, error} body from stdout, not just the exit code', () => {
    const run = () => {
      const err = new Error('Command failed')
      err.status = 3
      err.stdout = JSON.stringify({ ok: false, error: { code: 'not_enrolled', message: 'CHATTR_SESSION is not set' } })
      throw err
    }
    assert.throws(() => listRepoSessions({ cwd: '/repo', run }), /CHATTR_SESSION is not set/)
  })

  test('throws when the output is not valid JSON', () => {
    const run = () => 'not json'
    assert.throws(() => listRepoSessions({ cwd: '/repo', run }), /unparseable JSON/)
  })

  test('throws on {ok:false} even with a zero exit', () => {
    const run = () => JSON.stringify({ ok: false, error: { code: 'internal', message: 'boom' } })
    assert.throws(() => listRepoSessions({ cwd: '/repo', run }), /boom/)
  })

  test('throws when ok:true but sessions is missing or not an array', () => {
    const run = () => JSON.stringify({ ok: true })
    assert.throws(() => listRepoSessions({ cwd: '/repo', run }), /no sessions array/)
  })

  test('a session with status "unknown" is passed through, never dropped', () => {
    const run = () => JSON.stringify({ ok: true, sessions: [{ id: 's4', cwd: '/repo', status: 'unknown' }] })
    const { sessions } = listRepoSessions({ cwd: '/repo', run })
    assert.equal(sessions[0].status, 'unknown')
  })
})

describe('coverageComplete', () => {
  test('true only when coverage exists and says complete', () => {
    assert.equal(coverageComplete({ complete: true }), true)
    assert.equal(coverageComplete({ complete: false }), false)
    assert.equal(coverageComplete(null), false)
    assert.equal(coverageComplete(undefined), false)
  })
})

describe('unenrolledCount', () => {
  test('reports unclaimed roots even when enrollment counts offset them', () => {
    const coverage = { processes: { claude: 1, codex: 0 }, enrolled: { claude: 1, codex: 0 }, unenrolled: [{ pid: 970001, kind: 'claude', cwd: '/work' }], complete: false }
    assert.equal(unenrolledCount(coverage), 1)
  })

  test('sums the shortfall across both kinds', () => {
    const coverage = { processes: { claude: 3, codex: 2 }, enrolled: { claude: 1, codex: 2 }, complete: false }
    assert.equal(unenrolledCount(coverage), 2)
  })

  test('never negative when enrolled exceeds processes (a race, not a shortfall)', () => {
    const coverage = { processes: { claude: 1, codex: 0 }, enrolled: { claude: 2, codex: 0 }, complete: true }
    assert.equal(unenrolledCount(coverage), 0)
  })

  test('null when there is no coverage to read', () => {
    assert.equal(unenrolledCount(null), null)
  })
})

describe('findRepoRivals', () => {
  const sessions = [
    { id: 'me', kind: 'claude', cwd: '/repo', status: 'working' },
    { id: 'other', kind: 'claude', cwd: '/repo', status: 'idle' },
    { id: 'elsewhere', kind: 'codex', cwd: '/repo/.claude/worktrees/a', status: 'working' },
  ]

  test('a rival shares this exact cwd and is not this session', () => {
    const rivals = findRepoRivals({ cwd: '/repo', sessionId: 'me', sessions })
    assert.deepEqual(rivals.map((r) => r.id), ['other'])
  })

  test('a different worktree is not a rival', () => {
    const rivals = findRepoRivals({ cwd: '/repo/.claude/worktrees/a', sessionId: 'me', sessions })
    assert.deepEqual(rivals.map((r) => r.id), ['elsewhere'])
  })
})

describe('findRepoPeers', () => {
  test('every other session in the repo counts as a peer, regardless of cwd', () => {
    const sessions = [
      { id: 'me', cwd: '/repo' },
      { id: 'other', cwd: '/repo' },
      { id: 'elsewhere', cwd: '/repo/.claude/worktrees/a' },
    ]
    const peers = findRepoPeers({ sessionId: 'me', sessions })
    assert.deepEqual(
      peers.map((p) => p.id).sort(),
      ['elsewhere', 'other']
    )
  })
})

describe('describePeers', () => {
  test('names each peer by id, kind, status and cwd, including an unknown status', () => {
    const text = describePeers([
      { id: 'sess-1', kind: 'codex', status: 'working', cwd: '/repo' },
      { id: 'sess-2', kind: 'claude', status: 'unknown', cwd: null },
    ])
    assert.match(text, /sess-1/)
    assert.match(text, /codex/)
    assert.match(text, /working/)
    assert.match(text, /sess-2/)
    assert.match(text, /unknown/)
  })
})
