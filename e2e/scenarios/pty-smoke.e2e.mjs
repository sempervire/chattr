// Real CLI smoke test for the pty harness itself (lib/pty.mjs, lib/isolation.mjs
// spawnClaude/spawnCodex). One run each, cheap trivial prompt, killed
// afterwards -- the hard limits this issue set. Proves the plumbing
// (temp CLAUDE_CONFIG_DIR / CODEX_HOME, pty capture, process kill) works
// end to end; the isolation PROOF that neither CLI touched real config lives
// in run.mjs's before/after manifest + invocation log assertion, not here.
//
// Codex: a copied `auth.json` makes this a genuine authenticated round trip
// (verified manually while building this harness -- `codex exec` under a
// fresh, isolated CODEX_HOME with only auth.json seeded replies correctly).
//
// Claude: temp mode authenticates with the long-lived e2e token
// (lib/isolation.mjs's claudeAuthEnv) and installed mode with the real login,
// so both must produce a real reply. This is the suite's early auth canary.

import assert from 'node:assert/strict';
import { spawnClaude, spawnCodex } from '../lib/isolation.mjs';

export default {
  name: 'pty smoke: claude and codex launch under isolated config and are killed cleanly',
  async run({ sandbox }) {
    const claude = spawnClaude(sandbox, {
      args: ['-p', 'Reply with exactly: PONG', '--model', 'haiku', '--output-format', 'text'],
    });
    await claude.waitFor(/PONG|Not logged in/i, { timeoutMs: 45000 });
    const claudeExit = await claude.kill();
    // Accepting "Not logged in" here hid the first cutover's real failure. Temp mode
    // authenticates with the e2e token and installed mode with the real login; both must reply.
    assert.match(claude.buffer, /PONG/, `claude did not complete a real authenticated round trip: ${claude.buffer}`);
    assert.ok(claudeExit && typeof claudeExit === 'object', 'claude session never reported an exit');

    const codex = spawnCodex(sandbox, {
      args: ['exec', '-s', 'read-only', '--skip-git-repo-check', 'Reply with exactly: PONG'],
    });
    await codex.waitFor(/PONG/, { timeoutMs: 45000 });
    await codex.kill();
    assert.match(codex.buffer, /PONG/, 'codex did not complete a real authenticated round trip');
  },
};
