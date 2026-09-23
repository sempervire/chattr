// Falsifier: "message to busy" (the scenario list) -- a message
// sent to a REAL Claude session while it is genuinely mid-turn (a live Bash
// tool call still running, `status: working`) must not be injected until
// that turn's real `Stop`, and must land in exactly one batch there. `turn()`
// itself is already unit-tested directly against the library
// (chattr/test/chattr.test.mjs; chattr/hook/test/hook.test.mjs); this
// is the live, real-CLI, through-the-hook proof that the composed hook
// actually calls it at `stop` and that Claude's SDK actually continues the
// turn on the resulting `additionalContext` (chattr/SPEC.md section 7).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaude } from '../lib/isolation.mjs';
import { chattr, joinSynthetic, leaveSynthetic, waitForSessionStatus } from '../lib/cli.mjs';

export default {
  name: 'message to busy: delivered only at the next real turn boundary, in exactly one batch',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'message-to-busy');
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

    // Poll (never sleep-and-hope) until the real SessionStart hook has joined
    // it and the live Bash sleep has it genuinely `working`.
    const busySession = await waitForSessionStatus(sandbox, sessionId, (s) => s.status === 'working', { timeoutMs: 10000 });
    assert.ok(busySession, `session never reached "working" while its Bash sleep ran: ${claude.buffer}`);

    joinSynthetic(sandbox, 'busy-sender', { cwd: workDir });
    try {
      const sent = chattr(sandbox, ['send', sessionId, 'ping while busy'], { CHATTR_SESSION: 'busy-sender' });
      const uuid = sent.message.uuid;

      const midTurn = chattr(sandbox, ['status', uuid]);
      assert.equal(midTurn.recipients[0].state, 'queued', 'a message sent mid-turn must not be injected before the next boundary');
      assert.equal(midTurn.recipients[0].batch, null);

      const exit = await claude.exited;
      assert.equal(exit.code, 0, `claude did not exit cleanly: ${claude.buffer}`);

      const final = chattr(sandbox, ['status', uuid]);
      assert.equal(final.recipients[0].state, 'acked', `message was not delivered by the session's real stop: ${JSON.stringify(final)}\n${claude.buffer}`);
      assert.equal(final.recipients[0].attempts, 1, 'message should have been injected exactly once (one batch), not re-queued or re-injected');
      assert.ok(final.recipients[0].batch, 'message has a null batch id -- it was never actually injected');
    } finally {
      leaveSynthetic(sandbox, 'busy-sender');
    }
  },
};
