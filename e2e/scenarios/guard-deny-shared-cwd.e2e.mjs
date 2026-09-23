// Guard regression: worktree-guard.mjs must deny an edit when another live
// session shares this exact cwd -- the core protection built on top of
//  the real `chattr` CLI (not a mock), run
// here against the harness's isolated CHATTR_DB. Does not need the composed hooks: the
// guard reads `chattr who` directly -- it
// has no dependency on the composed hooks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { CHATTR_BIN, WORKTREE_GUARD } from '../lib/paths.mjs';
import { installFakePs } from '../lib/fakePs.mjs';

export default {
  name: 'worktree-guard denies an edit when a rival session shares this cwd',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'guard-shared-cwd');
    mkdirSync(workDir, { recursive: true });
    installFakePs(sandbox);

    const env = {
      ...process.env,
      PATH: `${sandbox.binDir}:${process.env.PATH}`,
      CHATTR_BIN,
      CHATTR_DB: sandbox.dbFile,
      // One enrolled claude session below must equal the fake process count,
      // so `coverage.complete` is true and the deny is about the shared cwd,
      // not about incomplete coverage (that is its own scenario).
      FAKE_PS_LINES: '9999 1 claude\n',
    };

    const join = spawnSync(process.execPath, [CHATTR_BIN, 'join', '--kind', 'claude', '--session', 'rival-session', '--cwd', workDir, '--pid', String(process.pid)], {
      encoding: 'utf8',
      env,
    });
    assert.equal(join.status, 0, join.stderr);

    try {
      const result = spawnSync(process.execPath, [WORKTREE_GUARD], {
        input: JSON.stringify({ cwd: workDir, session_id: 'me', tool_input: { file_path: path.join(workDir, 'file.txt') } }),
        encoding: 'utf8',
        env,
      });
      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /another session is live in this same working directory/);
    } finally {
      // Every scenario in this run shares one CHATTR_DB (run.mjs), and this
      // harness's own pid -- used above so the rival looks genuinely live --
      // stays alive for the whole run, so leave explicitly rather than
      // leaving "rival-session" looking live to every scenario that runs
      // after this one.
      spawnSync(process.execPath, [CHATTR_BIN, 'leave'], { encoding: 'utf8', env: { ...env, CHATTR_SESSION: 'rival-session' } });
    }
  },
};
