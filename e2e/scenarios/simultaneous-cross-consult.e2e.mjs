// Falsifier: "simultaneous cross-consult completes without deadlock" (the
// scenario list). Two sessions consulting EACH OTHER at once, then
// replying to each other at once, must both resolve -- `chattr.mjs`'s
// `open()` runs every write in `BEGIN IMMEDIATE` with a busy-timeout/retry
// loop specifically so two real, concurrent writers never deadlock or
// corrupt the store; this proves that against two real overlapping OS
// processes hitting the same sqlite file, not a single-threaded call
// sequence that could never have raced in the first place.
//
// The two "sides" are plain joined sessions, not live Claude/Codex CLIs:
// what this scenario is falsifying is chattr's own concurrency handling,
// not a CLI integration, and a live model turn would only add latency and
// cost without adding coverage here (both directions of a real CLI
// receiving and answering a consult are covered by codex-claude-consult.e2e.mjs).

import assert from 'node:assert/strict';
import { chattr, chattrAsync, joinSynthetic, leaveSynthetic } from '../lib/cli.mjs';

export default {
  name: 'simultaneous cross-consult completes without deadlock',
  async run({ sandbox }) {
    joinSynthetic(sandbox, 'consult-a', { kind: 'claude' });
    joinSynthetic(sandbox, 'consult-b', { kind: 'codex' });
    try {
      const [fromA, fromB] = await Promise.all([
        chattrAsync(sandbox, ['consult', 'consult-b', 'question from A'], { CHATTR_SESSION: 'consult-a' }),
        chattrAsync(sandbox, ['consult', 'consult-a', 'question from B'], { CHATTR_SESSION: 'consult-b' }),
      ]);
      assert.equal(fromA.message.to_spec, 'consult-b');
      assert.equal(fromB.message.to_spec, 'consult-a');
      assert.notEqual(fromA.message.uuid, fromB.message.uuid);

      const [replyToA, replyToB] = await Promise.all([
        chattrAsync(sandbox, ['reply', '--to', fromA.message.uuid, '--status', 'answered', 'answer from B'], { CHATTR_SESSION: 'consult-b' }),
        chattrAsync(sandbox, ['reply', '--to', fromB.message.uuid, '--status', 'answered', 'answer from A'], { CHATTR_SESSION: 'consult-a' }),
      ]);
      assert.equal(replyToA.message.reply_to, fromA.message.uuid);
      assert.equal(replyToB.message.reply_to, fromB.message.uuid);

      const statusA = chattr(sandbox, ['status', fromA.message.uuid]);
      assert.equal(statusA.summary, 'answered', `A's consult was not resolved: ${JSON.stringify(statusA)}`);
      const statusB = chattr(sandbox, ['status', fromB.message.uuid]);
      assert.equal(statusB.summary, 'answered', `B's consult was not resolved: ${JSON.stringify(statusB)}`);
    } finally {
      leaveSynthetic(sandbox, 'consult-a');
      leaveSynthetic(sandbox, 'consult-b');
    }
  },
};
