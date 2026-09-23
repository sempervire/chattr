// Minimal pty harness for driving `claude` and `codex` interactively, without
// a native pty addon. `chattr` is `node:sqlite`-only, no dependencies
// (chattr/README.md); this harness follows the same rule rather than
// pulling in `node-pty`.
//
// macOS/BSD `script -q /dev/null <command> <args...>` allocates a real pty for
// the child (satisfying `isatty()`/`$TERM` checks a CLI's interactive mode
// makes) and shuttles bytes between that pty and script's own stdio, which
// Node sees as ordinary pipes. `script` ships with every macOS box this epic
// runs on (chattr/SPEC.md's own proofs are all macOS transcripts).
//
// Today's scenarios only need non-interactive, single-shot runs (`claude -p`,
// `codex exec`) — see scenarios/pty-smoke.e2e.mjs. Their stdin is `/dev/null`
// (real device fd), not a pipe: `script` calls `tcgetattr` on ITS OWN stdin to
// save/restore terminal state, and that fails ("Operation not supported on
// socket", verified while building this harness) when stdin is a Node pipe,
// which shows up as a socket fd on macOS. `/dev/null` is a real device, so
// `script` is happy, and neither `claude -p` nor `codex exec` needs typed
// input anyway.
//
// `interactive: true` opens a real stdin pipe instead, for a caller that
// needs `write()`. The composed-hook scenarios (composed hooks firing mid-session, wake
// escalation, continuation) will need to type into a live session -- whether
// `script`'s tcgetattr problem also blocks THAT is not proven here; it is
// that issue's to prove, not faked as working now.

import { spawn, spawnSync } from 'node:child_process';

export class PtySession {
  constructor(command, args = [], { cwd, env, interactive = false } = {}) {
    this.command = command;
    this.args = args;
    this.buffer = '';
    this.child = spawn('script', ['-q', '/dev/null', command, ...args], {
      cwd,
      env: env ?? process.env,
      stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const onData = (chunk) => {
      this.buffer += chunk.toString('utf8');
    };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  /** Type into the session, as a real terminal would (no trailing newline added). Requires `interactive: true`. */
  write(text) {
    if (!this.child.stdin) throw new Error('PtySession.write(): this session was not opened with { interactive: true }');
    this.child.stdin.write(text);
  }

  /**
   * Poll the accumulated buffer for `pattern` until it matches or `timeoutMs`
   * elapses. Pass a non-global RegExp -- a global one's `lastIndex` would make
   * this non-idempotent across polls.
   */
  async waitFor(pattern, { timeoutMs = 15000, pollMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pattern.test(this.buffer)) return true;
      if (this.child.exitCode !== null || Date.now() >= deadline) return pattern.test(this.buffer);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Signal both `script` and its direct children: `script` wraps the real
   * command (`claude`/`codex`) under a pty and does not reliably forward a
   * signal sent to itself down to that child -- proven while building this
   * harness (a killed session's real `claude`/`codex` process kept running
   * as an orphan long enough for the NEXT scenario's `who --coverage` to
   * still see it as live). `pgrep -P` finds `script`'s direct children each
   * time, since the pid to signal can change between the first and the
   * escalating SIGKILL sweep.
   */
  #signalTree(signal) {
    try {
      const children = spawnSync('pgrep', ['-P', String(this.child.pid)], { encoding: 'utf8' }).stdout
        .split('\n').map((line) => line.trim()).filter(Boolean);
      for (const pid of children) {
        try { process.kill(Number(pid), signal); } catch { /* already gone */ }
      }
    } catch { /* pgrep unavailable: script's own signal is still sent below */ }
    try { this.child.kill(signal); } catch { /* already gone */ }
  }

  /** Kill the session -- and the real command it wraps -- (SIGTERM, then SIGKILL after a grace period) and wait for exit. */
  async kill(signal = 'SIGTERM') {
    if (this.child.exitCode !== null) return this.exited;
    this.#signalTree(signal);
    const result = await Promise.race([this.exited, new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
    if (result) return result;
    this.#signalTree('SIGKILL');
    return this.exited;
  }
}

/** `env` is the complete environment (lib/isolation.mjs's cliEnv), not merged over process.env here. */
export function claudeSession({ cwd, args = [], env, interactive = false }) {
  return new PtySession('claude', args, { cwd, env, interactive });
}

export function codexSession({ cwd, args = [], env, interactive = false }) {
  return new PtySession('codex', args, { cwd, env, interactive });
}
