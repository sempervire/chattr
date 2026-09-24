// Guard regression: worktree-guard.mjs must deny -- never silently allow --
// when `chattr who --coverage` reports live claude/codex root processes that no
// enrolled session covers (SPEC.md, "Coverage"). Does not need the composed hooks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHATTR_BIN, WORKTREE_GUARD } from '../lib/paths.mjs';
import { installFakePs } from '../lib/fakePs.mjs';

export default {
  name: 'worktree-guard denies on incomplete coverage, with no rival enrolled at all',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'guard-incomplete-coverage');
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
      // Two live claude processes "exist" per the fake ps, and the private DB
      // holds no enrolled session, so the shortfall is exactly 2.
      FAKE_PS_LINES: '9001 1 claude\n9002 1 claude\n',
    };

    const result = spawnSync(process.execPath, [WORKTREE_GUARD], {
      input: JSON.stringify({ cwd: workDir, session_id: 'me', tool_input: { file_path: path.join(workDir, 'file.txt') } }),
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /incomplete peer coverage/);
    if (!/2 live claude\/codex processes not enrolled/.test(out.hookSpecificOutput.permissionDecisionReason)) {
      // A shortfall other than 2 means the guard counted something outside this
      // private DB -- dump `who --all` so that is diagnosable in one read.
      const who = spawnSync(process.execPath, [CHATTR_BIN, 'who', '--all'], { encoding: 'utf8', env: { ...process.env, CHATTR_DB: dbFile } }).stdout;
      assert.fail(`${out.hookSpecificOutput.permissionDecisionReason}\nDIAGNOSTIC who --all: ${who}`);
    }
  },
};
