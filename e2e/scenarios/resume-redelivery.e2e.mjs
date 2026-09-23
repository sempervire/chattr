// Falsifier: "killed before Stop, then resumed -> redelivered once under the
// new incarnation" (the scenario list). A message injected into a
// REAL Claude session's context is never acked if that process is killed
// before it reaches `Stop`; when the same session id is later resumed (a new
// incarnation per chattr/SPEC.md section 2), the still-unacked delivery
// must be redelivered exactly once (attempts+1, a fresh batch) -- never
// dropped, never delivered twice in the same incarnation.
//
// Three real, sequential `claude` invocations sharing one `--session-id`:
//   1. a trivial turn, just to create the session (incarnation 1, real Stop).
//   2. `--resume`, which injects a pending message at `SessionStart`
//      (incarnation 2) and then runs a slow Bash command -- killed by SIGKILL
//      before it reaches `Stop`, so the injected batch is never acked.
//   3. `--resume` again (incarnation 3): the delivery's last batch belongs to
//      an earlier incarnation, so it is redelivered (attempts 1 -> 2) and
//      this time acked for real.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaude } from '../lib/isolation.mjs';
import { chattr, joinSynthetic, leaveSynthetic, waitForSessionStatus } from '../lib/cli.mjs';

export default {
  name: 'a session killed before Stop is redelivered exactly once under its next incarnation',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'resume-redelivery');
    mkdirSync(workDir, { recursive: true });
    const sessionId = randomUUID();
    const claudeArgs = (prompt, extra = []) => [
      '-p', prompt, '--model', 'haiku', '--allowedTools', 'Bash', '--permission-mode', 'bypassPermissions', '--output-format', 'json', ...extra,
    ];

    // 1. Create the session for real (incarnation 1), then let it exit.
    const first = spawnClaude(sandbox, { cwd: workDir, args: claudeArgs('Reply with exactly: OK1', ['--session-id', sessionId]) });
    const firstExit = await first.exited;
    assert.equal(firstExit.code, 0, `first launch did not exit cleanly: ${first.buffer}`);
    const afterFirst = chattr(sandbox, ['status', sessionId]).session;
    const incarnation1 = afterFirst.incarnation;

    // Queue a message while the session is idle (process exited): it just sits `queued`.
    joinSynthetic(sandbox, 'resume-sender', { cwd: workDir });
    try {
      const sent = chattr(sandbox, ['send', sessionId, 'please continue'], { CHATTR_SESSION: 'resume-sender' });
      const uuid = sent.message.uuid;
      assert.equal(chattr(sandbox, ['status', uuid]).recipients[0].state, 'queued');

      // 2. Resume: the pending message is injected at SessionStart (incarnation 2), alongside a
      // slow Bash command this test kills before the turn ever reaches Stop.
      const second = spawnClaude(sandbox, { cwd: workDir, args: claudeArgs('Use the Bash tool to run exactly: sleep 8 && echo T2. Then reply with exactly: OK2', ['--resume', sessionId]) });
      const busy = await waitForSessionStatus(sandbox, sessionId, (s) => s.status === 'working' && s.incarnation !== incarnation1, { timeoutMs: 10000 });
      assert.ok(busy, `session never re-entered "working" under a new incarnation after --resume: ${second.buffer}`);
      const incarnation2 = busy.incarnation;
      assert.notEqual(incarnation2, incarnation1, 'a resume must issue a fresh incarnation (chattr/SPEC.md section 2)');

      const injected = chattr(sandbox, ['status', uuid]);
      assert.equal(injected.recipients[0].state, 'injected', `message should be injected (in context) but not yet acked: ${JSON.stringify(injected)}`);
      assert.equal(injected.recipients[0].attempts, 1);
      const firstBatch = injected.recipients[0].batch;
      assert.ok(firstBatch, 'message has no batch id after being injected at SessionStart');

      await second.kill('SIGKILL'); // before Stop: the injected batch is never acked.
      const afterKill = chattr(sandbox, ['status', uuid]);
      assert.equal(afterKill.recipients[0].state, 'injected', 'a killed-before-Stop delivery must stay unacked, not silently acked');
      assert.equal(afterKill.recipients[0].batch, firstBatch);

      // 3. Resume again (incarnation 3): the stale incarnation-2 batch triggers a real redelivery.
      const third = spawnClaude(sandbox, { cwd: workDir, args: claudeArgs('Reply with exactly: OK3', ['--resume', sessionId]) });
      const thirdExit = await third.exited;
      assert.equal(thirdExit.code, 0, `third launch did not exit cleanly: ${third.buffer}`);

      const final = chattr(sandbox, ['status', uuid]);
      assert.equal(final.recipients[0].state, 'acked', `message was not redelivered and acked on resume: ${JSON.stringify(final)}\n${third.buffer}`);
      assert.equal(final.recipients[0].attempts, 2, 'a killed-before-Stop delivery must be redelivered exactly once (attempts 1 -> 2)');
      assert.notEqual(final.recipients[0].batch, firstBatch, 'redelivery must open a new batch, not reuse the orphaned one');

      const afterThird = chattr(sandbox, ['status', sessionId]).session;
      assert.notEqual(afterThird.incarnation, incarnation2, 'the second resume must also issue a fresh incarnation');
    } finally {
      leaveSynthetic(sandbox, 'resume-sender');
    }
  },
};
