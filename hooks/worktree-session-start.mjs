#!/usr/bin/env node
/**
 * worktree-session-start — SessionStart notice for a shared checkout.
 *
 * Two sessions in one directory share one git index and one working tree.
 * `worktree-guard.mjs` catches that at the moment of an `Edit`/`Write`, which
 * is most of the writing but not all of it: in auto mode file work goes
 * through `Bash`, and `git pull` / `git checkout` / `sed -i` never touch an
 * edit tool. On 2026-08-11 a `git pull` in a shared checkout rebased a peer
 * session's three unpushed commits; nothing was lost, and nothing prevented it
 * either.
 *
 * Sharing a checkout is a property of the SESSION, not of any one command. It
 * is knowable the moment the second session opens, which is also the moment
 * it is cheapest to act on — before any work exists to disturb. So this runs
 * ONCE per session instead of on every tool call, and it warns rather than
 * blocks, because `SessionStart` has nothing to block.
 *
 * Why not a `Bash` matcher on the guard instead — the alternative that looks
 * obvious — is recorded in `README.md`. Do not re-propose it without reading
 * that entry.
 *
 * Deliberately advisory: it prints a notice and exits 0 on every path. It adds
 * protection where there is none today and removes none, so an error here
 * must never wedge a session. Where it CANNOT complete its check it says so
 * and still recommends the worktree — the fail-closed instinct of the guard,
 * expressed in the only currency this event has: an "unknown" that is never
 * reported as "no peers".
 *
 * Escape hatch: CLAUDE_ALLOW_SHARED_CWD=1, the same one the guard honours.
 *
 * Peer discovery is `chattr who --repo --coverage` (
 * `chattr/SPEC.md`), not a session registry — see
 * `lib/peers.mjs`. Incomplete coverage (SPEC.md, "Coverage") prints
 * "peers: unknown (N unenrolled)" rather than trusting whatever `who` did
 * return as the whole picture.
 */

import { readFileSync } from 'node:fs'

import {
  canonical,
  coverageComplete,
  describePeers,
  findRepoPeers,
  findRepoRivals,
  listRepoSessions,
  unenrolledCount,
} from './lib/peers.mjs'

function say(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })
  )
  process.exit(0)
}

function silent() {
  process.exit(0)
}

let input = {}
try {
  const raw = readFileSync(0, 'utf8')
  if (raw.trim()) input = JSON.parse(raw)
} catch {
  // No payload to read. process.cwd() is still the session's directory, and
  // the sessionId filter below still degrades gracefully without one — carry
  // on rather than going quiet.
}

const myCwd = canonical(input.cwd || process.cwd())

let sessions, coverage
try {
  ;({ sessions, coverage } = listRepoSessions({ cwd: myCwd }))
} catch (err) {
  say(
    `Could not enumerate live sessions via chattr (${err.message}), so it is unknown whether ` +
      `another session is live in ${myCwd} or elsewhere in this repository.\n\n` +
      `Treat this checkout as shared: use the EnterWorktree tool before editing anything, or ` +
      `set CLAUDE_ALLOW_SHARED_CWD=1 if you know this checkout is yours alone. Peer discovery ` +
      `for announcements (agent-policy/AGENT-RULES.md) is a coordination failure to report, ` +
      `not an empty peer list.`
  )
}

// The escape hatch covers the shared-checkout warning only: a session that
// shares a checkout on purpose still has peers to announce to.
const rivals = process.env.CLAUDE_ALLOW_SHARED_CWD
  ? []
  : findRepoRivals({ cwd: myCwd, sessionId: input.session_id, sessions })
const peers = findRepoPeers({ sessionId: input.session_id, sessions }).filter((p) => !rivals.includes(p))

const parts = []
if (!coverageComplete(coverage)) {
  const n = unenrolledCount(coverage)
  parts.push(
    `peers: unknown (${n === null ? '?' : n} unenrolled)\n\n` +
      `chattr cannot vouch that every live claude/codex process on this machine has joined, ` +
      `so treat any peer list below as a lower bound, not the whole picture.`
  )
}

if (rivals.length === 0 && peers.length === 0 && parts.length === 0) silent()

if (rivals.length > 0) {
  parts.push(
    `WARNING: another session is already live in this working directory.\n\n` +
      `${myCwd}\n${describePeers(rivals)}\n\n` +
      `Two sessions sharing one checkout share one git index and one working tree. Either ` +
      `can commit, stash, rebase, or check out over the other's half-finished edits — and ` +
      `most of those arrive through Bash, where no hook will stop them.\n\n` +
      `Move into an isolated worktree BEFORE doing any work — use the EnterWorktree tool ` +
      `(preferred; it also symlinks node_modules and copies .env.local), or:\n` +
      `  git worktree add .claude/worktrees/<slug> -b <branch>\n\n` +
      `A worktree isolates FILES only. The branch, the remote, the Preview DB, GitHub ` +
      `issue/PR state, and deploys stay shared with every other session — sequence that ` +
      `work rather than assuming the worktree covers it.\n\n` +
      `To share this checkout deliberately, relaunch with CLAUDE_ALLOW_SHARED_CWD=1.`
  )
}
if (peers.length > 0) {
  parts.push(
    `Other live sessions in this repository (other worktrees):\n${describePeers(peers)}\n\n` +
      `Claim what you take before starting real work: ` +
      `\`chattr claim issue:<N> "<task>, worktree <path>, branch <name>"\`; ` +
      `\`chattr state\` lists what is already claimed. ` +
      `Otherwise message a peer only with something useful to it, and absorb incoming ` +
      `broadcasts silently (agent-policy/AGENT-RULES.md).`
  )
}

say(parts.join('\n\n'))
