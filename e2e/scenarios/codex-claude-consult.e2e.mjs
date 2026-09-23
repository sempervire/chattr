// Falsifier: "a Codex<->Claude consult both ways with `reply --status`" (the
// scenario list). Proves the RECEIVING side of a consult for both
// CLI kinds: a real, live session must (a) actually see the consult's
// suggested `chattr reply --to <uuid> --status <status> "<answer>"`
// command in its injected context (chattr/hook/index.mjs's `formatBatch`)
// and (b) actually run it -- a real model decision, not this test faking the
// reply on the session's behalf. The initiating `consult` itself is posted
// by this harness as a synthetic sender (a data-plane `chattr consult`
// call, already covered unit-level by chattr/test/chattr.test.mjs); what
// only a real CLI can prove is the receiving half.
//
// Two independent directions, one per CLI kind, each a fresh two-phase
// launch (create the session, then `--resume`/`exec resume` it once a
// consult is queued -- the same pattern resume-redelivery.e2e.mjs uses).
// `chattr` must be on PATH inside the sandbox for this: a real install
// symlinks it into ~/.local/bin (chattr/hook/install.mjs), which temp mode
// has no equivalent of -- lib/chattrPath.mjs's wrapper stands in for it.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaude, spawnCodex } from '../lib/isolation.mjs';
import { chattr, joinSynthetic, leaveSynthetic } from '../lib/cli.mjs';
import { installChattrBin } from '../lib/chattrPath.mjs';

const ANSWER_INSTRUCTION =
  'Check the context you were given at the start of this turn. If it contains a peer consult ' +
  'telling you to run an `chattr reply` command, run that EXACT shell command (filling in a short ' +
  "answer for the placeholder), using the shell/Bash tool. Then just say DONE.";

// `codex exec`'s own output is ANSI-styled through a real pty (lib/pty.mjs's
// `script` wrapper enables it; `--color never` cannot be added universally --
// see isolation.mjs's spawnCodex), which splits "session id:" from its value
// with a reset escape. Strip escapes before parsing it out.
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

export default {
  name: 'Codex<->Claude consult round trip: each side really runs the suggested `chattr reply --status`',
  async run({ sandbox }) {
    const binPath = installChattrBin(sandbox);
    const env = { PATH: `${path.dirname(binPath)}:${process.env.PATH}` };
    joinSynthetic(sandbox, 'consult-asker');
    try {
      // --- direction 1: a consult answered by a real Codex session ---
      const codexWorkDir = path.join(sandbox.root, 'consult-codex');
      mkdirSync(codexWorkDir, { recursive: true });
      const codexFirst = spawnCodex(sandbox, { cwd: codexWorkDir, env, args: ['exec', '-s', 'workspace-write', '--skip-git-repo-check', 'Reply with exactly: READY'] });
      const codexExit1 = await codexFirst.exited;
      assert.equal(codexExit1.code, 0, `codex first launch did not exit cleanly: ${codexFirst.buffer}`);
      const codexId = /session id: ([0-9a-f-]+)/.exec(stripAnsi(codexFirst.buffer))?.[1];
      assert.ok(codexId, `could not read codex's session id from its output: ${codexFirst.buffer}`);

      const codexConsult = chattr(sandbox, ['consult', codexId, 'What is 12 + 30? Reply with the digit sequence only.'], { CHATTR_SESSION: 'consult-asker' });
      const codexUuid = codexConsult.message.uuid;

      const codexSecond = spawnCodex(sandbox, { cwd: codexWorkDir, env, args: ['exec', 'resume', codexId, '--skip-git-repo-check', ANSWER_INSTRUCTION] });
      const codexExit2 = await codexSecond.exited;
      assert.equal(codexExit2.code, 0, `codex resume did not exit cleanly: ${codexSecond.buffer}`);

      const codexStatus = chattr(sandbox, ['status', codexUuid]);
      assert.equal(codexStatus.summary, 'answered', `codex never answered its consult for real: ${JSON.stringify(codexStatus)}\n${codexSecond.buffer}`);
      assert.equal(codexStatus.recipients[0].state, 'acked');

      // --- direction 2: a consult answered by a real Claude session ---
      const claudeWorkDir = path.join(sandbox.root, 'consult-claude');
      mkdirSync(claudeWorkDir, { recursive: true });
      const claudeId = randomUUID();
      const claudeFirst = spawnClaude(sandbox, { cwd: claudeWorkDir, env, args: ['--session-id', claudeId, '-p', 'Reply with exactly: READY', '--model', 'haiku', '--output-format', 'json'] });
      const claudeExit1 = await claudeFirst.exited;
      assert.equal(claudeExit1.code, 0, `claude first launch did not exit cleanly: ${claudeFirst.buffer}`);

      const claudeConsult = chattr(sandbox, ['consult', claudeId, 'What is 7 + 8? Reply with the digit sequence only.'], { CHATTR_SESSION: 'consult-asker' });
      const claudeUuid = claudeConsult.message.uuid;

      const claudeSecond = spawnClaude(sandbox, {
        cwd: claudeWorkDir, env,
        args: ['--resume', claudeId, '-p', ANSWER_INSTRUCTION, '--model', 'haiku', '--allowedTools', 'Bash', '--permission-mode', 'bypassPermissions', '--output-format', 'json'],
      });
      const claudeExit2 = await claudeSecond.exited;
      assert.equal(claudeExit2.code, 0, `claude resume did not exit cleanly: ${claudeSecond.buffer}`);

      const claudeStatus = chattr(sandbox, ['status', claudeUuid]);
      assert.equal(claudeStatus.summary, 'answered', `claude never answered its consult for real: ${JSON.stringify(claudeStatus)}\n${claudeSecond.buffer}`);
      assert.equal(claudeStatus.recipients[0].state, 'acked');
    } finally {
      leaveSynthetic(sandbox, 'consult-asker');
    }
  },
};
