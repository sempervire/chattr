#!/usr/bin/env node
/**
 * worktree-guard — PreToolUse guard for Edit|Write|NotebookEdit.
 *
 * Blocks a file edit when another live session — Claude or Codex — is working
 * in the same directory, so two sessions never share one git index / working
 * tree.
 *
 * Design rule: FAIL CLOSED. Any doubt — unreadable hook payload, an
 * unresolvable path, an `chattr` lookup that errors — blocks and sends the
 * session to a worktree. A needless worktree is cheap; two sessions in one
 * checkout is not.
 *
 * Escape hatch: set CLAUDE_ALLOW_SHARED_CWD=1 for a session that should be
 * allowed to share a checkout deliberately.
 *
 * Peer discovery is `chattr who --repo --coverage` (
 * `chattr/SPEC.md`), not a session registry — see
 * `lib/peers.mjs`. This file owns the policy: deny, and what the message
 * says.
 *
 * Coverage (SPEC.md section 9's `coverage.complete`):
 * `who` cannot see a session that never enrolled, so an empty or short-of-
 * every-live-process result is denied exactly like an `chattr` failure —
 * "no rival reported" is not "no rival exists" unless coverage says it looked
 * everywhere. Only a rival-free result WITH complete coverage allows.
 *
 * The wrap-in-try/catch around path resolution below was protection an
 * installed `~/.codex/hooks` copy carried that the old tracked source did
 * not — ported forward here rather than lost.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { canonical, coverageComplete, describePeers, findRepoRivals, isInside, listRepoSessions, unenrolledCount } from './lib/peers.mjs'

function allow() {
  process.exit(0)
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  )
  process.exit(0)
}

let input = {}
try {
  const raw = readFileSync(0, 'utf8')
  if (raw.trim()) input = JSON.parse(raw)
} catch {
  deny(
    'worktree-guard could not read the hook payload, so it cannot verify that no other ' +
      'session shares this directory. Blocking by design (fail closed). Work in a ' +
      'worktree, or set CLAUDE_ALLOW_SHARED_CWD=1 if you are sure this checkout is yours alone.'
  )
}

if (process.env.CLAUDE_ALLOW_SHARED_CWD) allow()

let myCwd
try {
  myCwd = canonical(input.cwd || process.cwd())
  const filePath = input?.tool_input?.file_path
  if (typeof filePath === 'string' && filePath.length > 0) {
    const target = canonical(resolve(myCwd, filePath))
    if (!isInside(target, myCwd)) allow()
  }
} catch {
  deny('worktree-guard could not resolve the edit location. Blocking by design (fail closed).')
}

let sessions, coverage
try {
  ;({ sessions, coverage } = listRepoSessions({ cwd: myCwd }))
} catch (err) {
  deny(
    `worktree-guard could not enumerate live sessions via chattr (${err.message}), so it cannot ` +
      'rule out another session in this directory. Blocking by design (fail closed).'
  )
}

if (!coverageComplete(coverage)) {
  const n = unenrolledCount(coverage)
  deny(
    `worktree-guard: chattr reports incomplete peer coverage` +
      (n === null ? '' : ` (${n} live claude/codex process${n === 1 ? '' : 'es'} not enrolled)`) +
      `, so it cannot rule out an unenrolled session in this directory. Blocking by design ` +
      `(fail closed). To share this checkout deliberately, relaunch with CLAUDE_ALLOW_SHARED_CWD=1.`
  )
}

const rivals = findRepoRivals({ cwd: myCwd, sessionId: input.session_id, sessions })

if (rivals.length === 0) allow()

deny(
  `Blocked: another session is live in this same working directory.\n\n` +
    `${myCwd}\n${describePeers(rivals)}\n\n` +
    `Two sessions sharing one checkout share one git index and one working tree, so ` +
    `each can commit, stash, or check out over the other's half-finished edits.\n\n` +
    `Move this session into an isolated worktree before editing — use the EnterWorktree ` +
    `tool (preferred; it also symlinks node_modules and copies .env.local), or:\n` +
    `  git worktree add .claude/worktrees/<slug> -b <branch>\n\n` +
    `Note: a worktree isolates FILES only. The branch, the remote, the Preview DB, ` +
    `GitHub issue/PR state, and deploys are still shared with every other session — ` +
    `sequence that work, do not assume the worktree covers it.\n\n` +
    `To share this checkout deliberately, relaunch with CLAUDE_ALLOW_SHARED_CWD=1.`
)
