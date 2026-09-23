// Falsifier: "broadcast, then a new joiner" (the scenario list) --
// a broadcast sent before any recipient exists gets zero delivery targets
// (chattr/SPEC.md's `resolveRecipients` snapshots live sessions AT SEND
// TIME), so a session that joins afterwards must still be able to see it:
// `chattr state`'s `broadcasts` field is a separate, repo-scoped query
// with no dependency on `deliveries`, precisely so a late joiner is not
// silently blind to it. This proves both halves against a REAL Claude
// session: it must NOT become a delivery recipient of a broadcast sent
// before it existed, AND it must still see that broadcast via `state`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaude } from '../lib/isolation.mjs';
import { chattr, joinSynthetic, leaveSynthetic } from '../lib/cli.mjs';

export default {
  name: 'a broadcast sent before a session existed is still visible to it via state once it joins',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'broadcast-new-joiner');
    mkdirSync(workDir, { recursive: true });
    // `broadcast` requires a non-null repo (chattr/SPEC.md section 6: "Sender
    // repo null with kind:/broadcast -> exit 4"), so this needs a real repo, not
    // just a plain throwaway directory.
    execFileSync('git', ['init', '-q'], { cwd: workDir });

    joinSynthetic(sandbox, 'broadcaster', { cwd: workDir });
    try {
      const sent = chattr(sandbox, ['broadcast', 'heads up: a new joiner should still see this'], { CHATTR_SESSION: 'broadcaster' });
      const uuid = sent.message.uuid;
      assert.deepEqual(sent.recipients, [], 'no session existed yet, so the broadcast should have had zero delivery targets');

      const sessionId = randomUUID();
      const claude = spawnClaude(sandbox, {
        cwd: workDir,
        args: ['--session-id', sessionId, '-p', 'Reply with exactly: JOINED', '--model', 'haiku', '--output-format', 'json'],
      });
      const exit = await claude.exited;
      assert.equal(exit.code, 0, `new joiner did not exit cleanly: ${claude.buffer}`);

      const status = chattr(sandbox, ['status', uuid]);
      assert.ok(!status.recipients.some((r) => r.session_id === sessionId), 'a late joiner must not retroactively become a delivery recipient of an earlier broadcast');

      const state = chattr(sandbox, ['state'], { CHATTR_SESSION: sessionId });
      assert.ok(state.broadcasts.some((m) => m.uuid === uuid), `the new joiner's state did not list the pre-existing broadcast: ${JSON.stringify(state.broadcasts)}`);
    } finally {
      leaveSynthetic(sandbox, 'broadcaster');
    }
  },
};
