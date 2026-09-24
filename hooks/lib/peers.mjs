import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * Resolve symlinks the way `findRepoRivals` needs: a cwd or edit target that
 * does not exist YET (a file about to be created, a worktree mid setup) still
 * needs its existing ANCESTORS' symlinks resolved, or two differently-spelled
 * paths to the same real directory look like different directories. Ported
 * from a fix an installed `~/.codex/hooks` copy carried that the tracked
 * source lacked.
 */
export function canonical(p) {
  const absolute = resolve(p)
  try {
    return realpathSync(absolute)
  } catch (err) {
    if (err.code !== 'ENOENT' || dirname(absolute) === absolute) throw err
    return join(canonical(dirname(absolute)), basename(absolute))
  }
}

export function isInside(child, parent) {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * `chattr who`'s error shape (`{ok:false, error:{code, message}}`,
 * `chattr/SPEC.md` section 9), read from a failed call's stdout when
 * available, else the process-spawn error itself.
 */
function describeFailure(err) {
  if (typeof err.stdout === 'string' && err.stdout.trim()) {
    try {
      const parsed = JSON.parse(err.stdout)
      if (parsed && parsed.ok === false && parsed.error) {
        return parsed.error.message || parsed.error.code
      }
    } catch {
      // stdout wasn't the JSON error shape either -- fall through
    }
  }
  return err.code || err.message
}

/**
 * Sessions and coverage `chattr` reports for the caller's repository, per
 * `chattr/SPEC.md` section 9: `who --repo --coverage` responds
 * `{ok:true, sessions: [Session], coverage: {processes:{claude,codex},
 * enrolled:{claude,codex}, unenrolled:[{pid,kind,cwd}], complete: bool}}`;
 * `complete` and `unenrolled` are authoritative, `enrolled` informational. `--coverage` is always passed
 * here; `coverageComplete`/`unenrolledCount` below already treat a missing
 * `coverage` key (an `chattr` too old to know the flag) as incomplete.
 * `--cwd` scopes coverage to the caller's directory, matching `findRepoRivals`.
 *
 * Fails LOUD, never quiet: a failed spawn, a non-zero exit (`{ok:false}`,
 * SPEC.md section 9's exit codes), or unparseable output all throw, because
 * "could not ask" is not "nobody is there".
 */
export function listRepoSessions({
  cwd,
  run = execFileSync,
  bin = process.env.CHATTR_BIN || 'chattr',
} = {}) {
  let out
  try {
    out = run(bin, ['who', '--repo', '--coverage', ...(cwd ? ['--cwd', cwd] : []), '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    throw new Error(`chattr who --repo failed (${describeFailure(err)})`)
  }
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch (err) {
    throw new Error(`chattr who --repo returned unparseable JSON (${err.message})`)
  }
  if (!parsed.ok) {
    throw new Error(`chattr who --repo failed (${parsed.error?.message || parsed.error?.code || 'unknown error'})`)
  }
  if (!Array.isArray(parsed.sessions)) {
    throw new Error('chattr who --repo: no sessions array in the response')
  }
  return { sessions: parsed.sessions, coverage: parsed.coverage ?? null }
}

/**
 * Whether `chattr` vouches that every live `claude`/`codex` process on this
 * machine has a `sessions` row (SPEC.md section 9's
 * `coverage.complete`). Missing coverage — an old `chattr`, or a `who` that
 * didn't ask for it — is treated the same as incomplete: fail closed, never
 * assume a completeness that was never reported.
 */
export function coverageComplete(coverage) {
  return coverage != null && coverage.complete === true
}

/**
 * How many live `claude`/`codex` root processes have no enrolled session, per
 * `coverage.unenrolled`. An older `chattr` without that field falls back to the
 * processes-minus-enrolled shortfall; null when neither can be read.
 */
export function unenrolledCount(coverage) {
  if (!coverage) return null
  if (Array.isArray(coverage.unenrolled)) return coverage.unenrolled.length
  if (!coverage.processes || !coverage.enrolled) return null
  const short = (kind) => Math.max(0, (coverage.processes[kind] ?? 0) - (coverage.enrolled[kind] ?? 0))
  return short('claude') + short('codex')
}

/** Live sessions, other than `sessionId`, whose cwd canonicalises to `cwd`. */
export function findRepoRivals({ cwd, sessionId, sessions }) {
  return sessions
    .filter((s) => !sessionId || s.id !== sessionId)
    .filter((s) => s.cwd && canonical(s.cwd) === cwd)
}

/** Every other live session chattr reports in this repository. */
export function findRepoPeers({ sessionId, sessions }) {
  return sessions.filter((s) => !sessionId || s.id !== sessionId)
}

export function describePeers(peers) {
  return peers
    .map((s) => {
      const cwd = s.cwd ? `, ${s.cwd}` : ''
      return `  - "${s.id || 'unknown session'}" (${s.kind}, ${s.status}${cwd})`
    })
    .join('\n')
}
