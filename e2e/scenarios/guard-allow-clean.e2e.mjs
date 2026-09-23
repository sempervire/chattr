// Guard regression: worktree-guard.mjs must allow when `who --repo` is empty
// AND coverage is complete -- the "nothing to rule out" case, so the guard is
// proven not to fail-closed unconditionally. Does not need the composed hooks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHATTR_BIN, WORKTREE_GUARD } from '../lib/paths.mjs';
import { installFakePs } from '../lib/fakePs.mjs';

export default {
  name: 'worktree-guard allows when who --repo is empty and coverage is complete',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'guard-allow-clean');
    mkdirSync(workDir, { recursive: true });
    installFakePs(sandbox);
    // A private DB: these are synthetic guard checks whose coverage arithmetic
    // depends on exactly who is enrolled. In installed mode sandbox.dbFile is the
    // real ~/.agent-bridge DB, where the cutover's own live test sessions are
    // enrolled and shift the count.
    const dbFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'chattr-guard-')), 'bridge.db');

    const env = {
      ...process.env,
      PATH: `${sandbox.binDir}:${process.env.PATH}`,
      CHATTR_BIN,
      CHATTR_DB: dbFile,
      // No fake processes and nothing enrolled: 0 >= 0 on both kinds is
      // complete (chattr.mjs's own coverage()), so there is nothing to
      // rule out and the edit is allowed.
      FAKE_PS_LINES: '',
    };

    const result = spawnSync(process.execPath, [WORKTREE_GUARD], {
      input: JSON.stringify({ cwd: workDir, session_id: 'me', tool_input: { file_path: path.join(workDir, 'file.txt') } }),
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  },
};
