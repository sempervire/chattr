// Falsifier: "wake refuses a session that isn't idle" (the scenario
// list; `chattr/wake.mjs`'s `wakeSession`: `if (status !== 'idle') return
// {..., reason: 'status_${status}'}`). A native wake sent while a REAL
// Claude session is genuinely mid-turn (a live Bash sleep, not a
// hand-written `working` row) must be refused, and must never touch
// `last_wake_at`. `chattr/hook/test/wake.test.mjs` already proves this
// against a hand-enrolled row; this is the live, real-CLI proof that a
// plain (non-`--bg`) session's `sessions.pid` genuinely matches its own
// messaging socket, so a refusal here is really about status, not an
// unrelated pid mismatch.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaude } from '../lib/isolation.mjs';
import { chattr, waitForSessionStatus } from '../lib/cli.mjs';

export default {
  name: "wake refuses a session that isn't idle",
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'wake-refuses-non-idle');
    mkdirSync(workDir, { recursive: true });
    const sessionId = randomUUID();

    const claude = spawnClaude(sandbox, {
      cwd: workDir,
      args: [
        '--session-id', sessionId, '-p',
        'Use the Bash tool to run exactly: sleep 6 && echo DONE. Then reply with exactly: COMPLETE',
        '--model', 'haiku', '--allowedTools', 'Bash', '--permission-mode', 'bypassPermissions', '--output-format', 'json',
      ],
    });

    const busy = await waitForSessionStatus(sandbox, sessionId, (s) => s.status === 'working', { timeoutMs: 10000 });
    assert.ok(busy, `session never reached "working" while its Bash sleep ran: ${claude.buffer}`);
    assert.equal(busy.wake_endpoint?.kind, 'uds');
    const socketPid = Number(path.basename(busy.wake_endpoint.path, '.sock'));
    assert.equal(socketPid, busy.pid, 'a plain -p session must report a socket-matching pid (not a --bg supervisor/worker split)');

    const attempt = chattr(sandbox, ['wake', sessionId]);
    assert.equal(attempt.woke, false, `wake must refuse a busy session: ${JSON.stringify(attempt)}`);
    assert.equal(attempt.reason, 'status_working');
    assert.equal(attempt.via, 'uds');

    const afterAttempt = chattr(sandbox, ['status', sessionId]).session;
    assert.equal(afterAttempt.last_wake_at, null, 'a refused wake must not record last_wake_at');

    const exit = await claude.exited;
    assert.equal(exit.code, 0, `claude did not exit cleanly: ${claude.buffer}`);
  },
};
