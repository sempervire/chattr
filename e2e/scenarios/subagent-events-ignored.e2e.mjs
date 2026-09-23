// Falsifier: "subagent events ignored" (the scenario list). A real
// Claude Task-tool subagent fires its own PreToolUse/PostToolUse/Stop hook
// events with `agent_id` set (chattr/hook/adapters/claude.mjs's
// `normalize()`: "Native subagents (Agent tool) carry agent_id; they are not
// peers"). This drives an ACTUAL subagent through the Task tool -- not a
// crafted payload -- and asserts the only session chattr ever sees is the
// parent: no phantom peer row, no delivery, no output, for the whole
// subagent lifecycle.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaude } from '../lib/isolation.mjs';
import { chattr } from '../lib/cli.mjs';

export default {
  name: 'subagent events are ignored: a real Task-tool subagent never becomes a peer session',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'subagent-events-ignored');
    mkdirSync(workDir, { recursive: true });
    const sessionId = randomUUID();
    const before = chattr(sandbox, ['who', '--all']).sessions.map((s) => s.id);

    const claude = spawnClaude(sandbox, {
      cwd: workDir,
      args: [
        '--session-id', sessionId, '-p',
        'Use the Task tool (subagent_type "general-purpose") to ask a subagent to reply with exactly PONG. ' +
          'Wait for it to finish, then just reply with exactly: DONE.',
        '--model', 'haiku', '--allowedTools', 'Task', '--permission-mode', 'bypassPermissions', '--output-format', 'json',
      ],
    });
    const exit = await claude.exited;
    assert.equal(exit.code, 0, `claude did not exit cleanly: ${claude.buffer}`);
    assert.match(claude.buffer, /DONE/, `the parent session never reported finishing the subagent: ${claude.buffer}`);

    // `who --all` returns every row this shared sandbox DB has ever seen
    // (other scenarios' sessions included, `--all` bypasses the live filter),
    // so the falsifier is a before/after diff, not an exact-equality snapshot.
    const after = chattr(sandbox, ['who', '--all']).sessions.map((s) => s.id);
    const newIds = after.filter((id) => !before.includes(id));
    assert.deepEqual(newIds, [sessionId], `a subagent's own hook events must never create a peer session row: new ids were ${JSON.stringify(newIds)}`);
  },
};
