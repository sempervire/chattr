// Falsifier: two REAL, hook-auto-enrolled Claude sessions sharing one cwd
// must still trip worktree-guard.mjs's "shared cwd" deny -- proving the same
// protection guard-deny-shared-cwd.e2e.mjs already proves against a
// hand-enrolled CHATTR_DB row also holds once the composed SessionStart
// hook is the thing calling `chattr join`, not this test calling it by
// hand. If the guard silently allowed here, two real agents could edit the
// same working tree at once (SPEC.md, "Coverage").
//
// `FAKE_PS_LINES=''` claims zero live claude/codex processes system-wide, so
// `who --coverage` has no root to find unenrolled, so it is trivially complete
// regardless of how many real sessions (including this very lane) happen to
// be running on the dev machine -- the alternative, listing exact pids, is a
// chicken-and-egg problem since a real CLI's pid is not known until spawn.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaude } from '../lib/isolation.mjs';
import { installFakePs } from '../lib/fakePs.mjs';
import { ensureSessionGone, waitForSessionStatus } from '../lib/cli.mjs';

export default {
  name: 'two real live Claude sessions sharing one cwd trip the guard for real, with no hand-enrolled session',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'guard-live-two-sessions');
    mkdirSync(workDir, { recursive: true });
    installFakePs(sandbox);
    const env = { PATH: `${sandbox.binDir}:${process.env.PATH}`, FAKE_PS_LINES: '' };
    const sessionA = randomUUID();

    // Session A must still be a LIVE process -- not merely a row in the DB --
    // when B attempts its edit: `findRepoRivals` only considers sessions
    // `liveStatus()` currently reports as live, and a `-p` process that has
    // already exited is immediately recomputed as `gone` and excluded (proven
    // while building this harness: awaiting A's exit before starting B made
    // the guard silently ALLOW, since there was no live rival left to find).
    // A holds its turn open on a gate file, not a timer: a fixed sleep raced B's
    // cold model call and occasionally let A finish first (the guard then saw no
    // rival and allowed). The test opens the gate only after B's outcome, so A is
    // live for exactly as long as B needs; the loop's ~100 s cap keeps a lost
    // session from outliving the Bash tool's own 2-minute timeout.
    const gate = path.join(workDir, 'a-release');
    const a = spawnClaude(sandbox, {
      cwd: workDir,
      env,
      args: [
        '--session-id', sessionA, '-p',
        `Use the Bash tool to run exactly: for i in $(seq 1 500); do [ -f ${gate} ] && break; sleep 0.2; done; echo A_DONE. Then reply with exactly: A_READY`,
        '--model', 'haiku', '--allowedTools', 'Bash', '--permission-mode', 'bypassPermissions', '--output-format', 'json',
      ],
    });
    try {
      const busyA = await waitForSessionStatus(sandbox, sessionA, (s) => s.status === 'working', { timeoutMs: 10000 });
      assert.ok(busyA, `session A never reached "working": ${a.buffer}`);

      const b = spawnClaude(sandbox, {
        cwd: workDir,
        env,
        args: [
          '-p',
          'Use the Edit tool to create a file named note.txt with the content hi. ' +
            'If the tool call is denied, do not retry -- just reply with exactly: BLOCKED.',
          '--model', 'haiku', '--allowedTools', 'Edit', '--permission-mode', 'bypassPermissions',
        ],
      });
      await b.waitFor(/BLOCKED/, { timeoutMs: 45000 });
      await b.kill();
      assert.match(b.buffer, /BLOCKED/, `the guard did not deny session B's edit in the shared cwd (A still live): ${b.buffer}`);
      assert.ok(!existsSync(path.join(workDir, 'note.txt')), 'note.txt was created -- the guard did not actually block the edit');
    } finally {
      // Every scenario in this run shares one CHATTR_DB (run.mjs): a still-live
      // session A would inflate `who --coverage`'s enrolled count for every
      // scenario that runs after this one. `a.kill()` alone proved NOT reliably
      // enough while building this harness (`script`'s signal does not always
      // reach the real wrapped `claude` process promptly) -- confirm chattr
      // itself now considers it gone, escalating to a direct kill of the exact
      // recorded pid if not. Best-effort like leaveSynthetic: cleanup must
      // never throw and mask a real assertion failure from the `try` above.
      try { writeFileSync(gate, ''); } catch {}
      await a.kill().catch(() => {});
      const gone = await ensureSessionGone(sandbox, sessionA);
      if (!gone) console.error(`coverage-live-two-sessions: session A (${sessionA}) may still be alive after cleanup`);
    }
  },
};
