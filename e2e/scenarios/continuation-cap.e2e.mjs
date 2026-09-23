// Falsifier: "continuation cap honored" (the scenario list; the
// interface spec: "at most 2 continued batches since the last human
// prompt"). A single REAL Claude invocation is driven through two real
// continuation cycles by peer messages whose bodies each instruct one more
// slow Bash call (so the session is genuinely `working`, not faked, when the
// next message is sent); a third message sent during the second
// continuation's busy window must NOT trigger a third continue -- it must
// stay `queued` until a real human prompt arrives, per chattr/SPEC.md
// section 7 and the composed Stop hook's `CAP = 2` (chattr/hook/index.mjs).
//
// Sequencing is message-state-driven, not time-based: this test never
// guesses how long a continuation takes -- it waits for the PREVIOUS
// message to actually reach `injected` before sending the next one, so a
// message can never race into the same batch as the one before it.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaude } from '../lib/isolation.mjs';
import { chattr, joinSynthetic, leaveSynthetic, waitForMessageState, waitForSessionStatus } from '../lib/cli.mjs';

const bashInstruction = (n) => `Use the Bash tool to run exactly: sleep 5 && echo M${n}. Then reply with exactly: A${n}`;

export default {
  name: 'a session is not continued a third time since the last human prompt',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'continuation-cap');
    mkdirSync(workDir, { recursive: true });
    const sessionId = randomUUID();

    const claude = spawnClaude(sandbox, {
      cwd: workDir,
      args: [
        '--session-id', sessionId, '-p', bashInstruction(0),
        '--model', 'haiku', '--allowedTools', 'Bash', '--permission-mode', 'bypassPermissions', '--output-format', 'json',
      ],
    });

    // Wait for the real SessionStart join before addressing it -- a message
    // sent before the session row exists is an unknown_recipient (exit 4).
    const busy0 = await waitForSessionStatus(sandbox, sessionId, (s) => s.status === 'working', { timeoutMs: 10000 });
    assert.ok(busy0, `session never reached "working" for its initial turn: ${claude.buffer}`);

    joinSynthetic(sandbox, 'cap-sender', { cwd: workDir });
    try {
      const send = (body) => chattr(sandbox, ['send', sessionId, body], { CHATTR_SESSION: 'cap-sender' }).message.uuid;

      // Sent during the initial (turn 0) busy window: this is the FIRST continuation.
      const uuid1 = send(bashInstruction(1));
      const injected1 = await waitForMessageState(sandbox, uuid1, (r) => r.state !== 'queued', { timeoutMs: 15000 });
      assert.equal(injected1?.state, 'injected', `message 1 was never injected (first continuation never happened): ${JSON.stringify(injected1)}\n${claude.buffer}`);
      assert.equal(injected1.attempts, 1);
      const batch1 = injected1.batch;

      // Sent during the first continuation's own busy window: this is the SECOND continuation.
      const uuid2 = send(bashInstruction(2));
      const injected2 = await waitForMessageState(sandbox, uuid2, (r) => r.state !== 'queued', { timeoutMs: 15000 });
      assert.equal(injected2?.state, 'injected', `message 2 was never injected (second continuation never happened): ${JSON.stringify(injected2)}\n${claude.buffer}`);
      assert.equal(injected2.attempts, 1);
      const batch2 = injected2.batch;
      assert.notEqual(batch2, batch1, 'the second continuation must open its own batch');

      // Sent during the second continuation's busy window: the cap (2) is already spent, so
      // the composed Stop hook must take the "past cap" branch and leave this one queued.
      const uuid3 = send('just a ping, no action needed');

      const exit = await claude.exited;
      assert.equal(exit.code, 0, `claude did not exit cleanly: ${claude.buffer}`);

      // Message 1 was acked, but at the THIRD Stop -- the one that hit the cap --
      // chattr/hook/index.mjs calls `turn(db, id, 'interrupt')`, not `turn(db,
      // id, 'stop')`, because the outcome is a real stop, not a continue. Only a
      // `stop` event acks prior batches of the same incarnation (chattr.mjs's
      // `turn()`), so message 2's batch -- injected at the SECOND Stop, before the
      // cap was reached -- is delivered (in context) but deliberately stays
      // unacked: "the last continued batch is acked at the next stop instead of
      // this one" (chattr/hook/index.mjs's own comment). That is what proves
      // the cap actually fired, not a fluke of timing.
      const final1 = chattr(sandbox, ['status', uuid1]);
      assert.equal(final1.recipients[0].state, 'acked', `message 1 (acked at the second Stop, before message 2's injection) was not acked: ${JSON.stringify(final1)}`);
      const final2 = chattr(sandbox, ['status', uuid2]);
      assert.equal(final2.recipients[0].state, 'injected', `message 2 should be delivered but deliberately NOT yet acked (the cap made the third Stop an interrupt, not a stop): ${JSON.stringify(final2)}\n${claude.buffer}`);
      assert.equal(final2.recipients[0].batch, batch2, "message 2's batch must not have been touched by the cap-triggered interrupt");
      const final3 = chattr(sandbox, ['status', uuid3]);
      assert.equal(final3.recipients[0].state, 'queued', `a third message during the busy window must stay queued past the cap, not be injected: ${JSON.stringify(final3)}\n${claude.buffer}`);
      assert.equal(final3.recipients[0].attempts, 0);
      assert.equal(final3.recipients[0].batch, null);

      // The composed hook sets `idle` via `turn(db, id, 'interrupt')` the instant
      // the cap trips; by the time this test can read it back, the underlying
      // `-p` process has usually already exited for real too (a genuine real
      // stop, not a continue), and a `gone` session's last known status was
      // still `idle` before the exit was detected -- both readings prove the
      // same thing: the cap made this a real stop, never a third continue.
      const session = chattr(sandbox, ['status', sessionId]).session;
      assert.ok(['idle', 'gone'].includes(session.status), `the session must end up idle (or since-exited) once it truly stops past the cap, not left "working": ${JSON.stringify(session)}`);
    } finally {
      leaveSynthetic(sandbox, 'cap-sender');
    }
  },
};
