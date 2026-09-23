import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffManifests, snapshotManifest } from '../lib/manifest.mjs';
import { assertInvocationsIsolated, cliEnv, createInstalledContext, createSandbox, cleanupInstalledContext, cleanupSandbox } from '../lib/isolation.mjs';
import { discoverScenarios } from '../lib/scenarios.mjs';
import { runScenarioList } from '../lib/runner.mjs';

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

describe('lib/manifest', () => {
  let root, repo, home;
  test.before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'manifest-test-'));
    repo = path.join(root, 'repo');
    home = path.join(root, 'home');
    mkdirSync(home, { recursive: true });
    initRepo(repo);
    writeFileSync(path.join(repo, 'README.md'), 'v1');
    commitAll(repo, 'init');
  });
  test.after(() => rmSync(root, { recursive: true, force: true }));

  test('detects a changed file and reports no diff when nothing changed', () => {
    const opts = { repos: [repo], home };
    const before = snapshotManifest(opts);
    assert.deepEqual(diffManifests(before, snapshotManifest(opts)), []);

    writeFileSync(path.join(repo, 'README.md'), 'v2 -- changed on disk without a commit');
    const after = snapshotManifest(opts);
    const changed = diffManifests(before, after);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].file, path.join(repo, 'README.md'));
    assert.notEqual(changed[0].before, changed[0].after);
  });

  test('ignores ~/.claude.json\'s promptQueueUseCount (a real Claude Code CLI counter outside CLAUDE_CONFIG_DIR) but still catches any other change to that file', () => {
    const opts = { repos: [repo], home };
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ promptQueueUseCount: 10, numStartups: 5 }));
    const before = snapshotManifest(opts);

    // A native wake bumps only the known counter: not a violation.
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ promptQueueUseCount: 11, numStartups: 5 }));
    assert.deepEqual(diffManifests(before, snapshotManifest(opts)), []);

    // Any OTHER field changing in the same file is still a real violation.
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ promptQueueUseCount: 11, numStartups: 6 }));
    const changed = diffManifests(before, snapshotManifest(opts));
    assert.equal(changed.length, 1);
    assert.equal(changed[0].file, path.join(home, '.claude.json'));
  });
});

describe('lib/isolation', () => {
  let sandbox;
  test.before(() => {
    sandbox = createSandbox('isolation-test-');
  });
  test.after(() => cleanupSandbox(sandbox));

  test('no invocation log at all is trivially isolated', () => {
    const result = assertInvocationsIsolated(sandbox);
    assert.deepEqual(result, { ok: true, checked: 0, problems: [] });
  });

  test('flags a claude invocation not pointed at the sandbox', () => {
    writeFileSync(sandbox.invocationLog, `${JSON.stringify({ cli: 'claude', env: { CLAUDE_CONFIG_DIR: '/Users/nobody/.claude' } })}\n`);
    const result = assertInvocationsIsolated(sandbox);
    assert.equal(result.ok, false);
    assert.equal(result.checked, 1);
    assert.match(result.problems[0], /without a sandboxed CLAUDE_CONFIG_DIR/);
  });

  test('flags an invocation whose HOME is outside the sandbox', () => {
    writeFileSync(sandbox.invocationLog, `${JSON.stringify({ cli: 'codex', env: { HOME: '/Users/nobody', CODEX_HOME: sandbox.codexHome } })}\n`);
    const result = assertInvocationsIsolated(sandbox);
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /unsandboxed HOME/);
  });

  test('temp mode is a whole HOME: config dirs and the bus live at their default paths under it', () => {
    assert.equal(sandbox.claudeConfigDir, path.join(sandbox.home, '.claude'));
    assert.equal(sandbox.codexHome, path.join(sandbox.home, '.codex'));
    assert.equal(sandbox.dbFile, path.join(sandbox.home, '.agent-bridge', 'bridge.db'));
    assert.ok(sandbox.home.startsWith(sandbox.root));
  });

  // Root cause: installed mode exported CLAUDE_CONFIG_DIR=~/.claude, which Claude Code treats as
  // a separate, logged-out profile. A CLI must get the defaults the way a launcher-started session does.
  test('cliEnv never exports CLAUDE_CONFIG_DIR, CODEX_HOME or CHATTR_DB when they are the home defaults', () => {
    const installed = createInstalledContext('cli-env-test-');
    try {
      for (const context of [installed, sandbox]) {
        for (const kind of ['claude', 'codex']) {
          const env = cliEnv(context, kind, { CLAUDE_CONFIG_DIR: '/elsewhere', CODEX_HOME: '/elsewhere', CHATTR_DB: '/elsewhere.db' });
          assert.equal(env.HOME, context.home);
          assert.equal(env.CLAUDE_CONFIG_DIR, undefined, `${kind} CLAUDE_CONFIG_DIR`);
          assert.equal(env.CODEX_HOME, undefined, `${kind} CODEX_HOME`);
          assert.equal(env.CHATTR_DB, undefined, `${kind} CHATTR_DB`);
          assert.ok(env.PATH.startsWith(`${path.join(context.home, '.local', 'bin')}:`));
        }
      }
      assert.equal(installed.home, homedir());
      assert.equal(cliEnv(installed, 'claude').CLAUDE_CODE_OAUTH_TOKEN, undefined, 'installed mode uses the real login, never the e2e token');
      const odd = { ...sandbox, claudeConfigDir: path.join(sandbox.root, 'other-claude'), codexHome: path.join(sandbox.root, 'other-codex') };
      assert.equal(cliEnv(odd, 'claude').CLAUDE_CONFIG_DIR, odd.claudeConfigDir);
      assert.equal(cliEnv(odd, 'codex').CODEX_HOME, odd.codexHome);
    } finally {
      cleanupInstalledContext(installed);
    }
  });

  test('passes a codex invocation pointed inside the sandbox', () => {
    writeFileSync(sandbox.invocationLog, `${JSON.stringify({ cli: 'codex', env: { CODEX_HOME: sandbox.codexHome } })}\n`);
    const result = assertInvocationsIsolated(sandbox);
    assert.deepEqual(result, { ok: true, checked: 1, problems: [] });
  });
});

describe('lib/scenarios', () => {
  test('every discovered scenario has a name, and either needs or a run()', async () => {
    const scenarios = await discoverScenarios();
    assert.ok(scenarios.length > 0);
    for (const s of scenarios) {
      assert.ok(s.name, `${s.file} is missing a name`);
      assert.ok(s.needs || typeof s.run === 'function', `${s.file} ("${s.name}") has neither needs nor run()`);
    }
  });

  test('at least one scenario is a live guard regression that does not need the composed hooks', async () => {
    const scenarios = await discoverScenarios();
    const live = scenarios.filter((s) => !s.needs);
    assert.ok(live.some((s) => /guard/i.test(s.name)), 'expected at least one guard-regression scenario to be live');
  });
});

test('runner: one retry per scenario; fail-then-pass is FLAKY and passes the run, fail-twice fails it', async () => {
  const failingOnce = () => { let n = 0; return async () => { if (n++ === 0) throw new Error('first boom'); }; };
  const logs = [];
  const errs = [];
  const io = { out: (l) => logs.push(l), err: (l) => errs.push(l) };

  let calls = 0;
  const flaky = await runScenarioList([
    { name: 'steady', run: async () => {} },
    { name: 'flaky', run: failingOnce() },
    { name: 'blocked', needs: '#0', run: async () => { calls++; } },
  ], {}, io);
  assert.equal(flaky.failed, false);
  assert.deepEqual(flaky.counts, { pass: 1, flaky: 1, timeout: 0, fail: 0, skip: 1 });
  assert.equal(calls, 0);
  assert.ok(logs.includes('FLAKY flaky (failed once, passed on retry)'));
  assert.ok(errs.some((e) => e.includes('first boom')), 'the first failure is reported');
  assert.equal(logs.at(-1), 'summary: 1 pass, 1 flaky, 0 timeout, 0 fail, 1 skip');

  let attempts = 0;
  const broken = await runScenarioList([{ name: 'broken', run: async () => { attempts++; throw new Error(`boom ${attempts}`); } }], {}, io);
  assert.equal(broken.failed, true);
  assert.equal(attempts, 2);
  assert.deepEqual(broken.counts, { pass: 0, flaky: 0, timeout: 0, fail: 1, skip: 0 });
  assert.ok(errs.at(-1).includes('boom 1') && errs.at(-1).includes('boom 2'));
});

test('runner: an attempt past its timeout kills its sessions and fails as a TIMEOUT naming the scenario', async () => {
  const logs = [];
  const errs = [];
  let kills = 0;
  let starts = 0;
  const logDir = mkdtempSync(path.join(tmpdir(), 'runner-log-test-'));
  try {
    const result = await runScenarioList([
      { name: 'hangs', file: 'hangs.e2e.mjs', run: () => { starts++; return new Promise(() => {}); } },
      { name: 'after', file: 'after.e2e.mjs', run: async () => {} },
    ], {}, {
      out: (l) => logs.push(l), err: (l) => errs.push(l), logDir, timeoutMs: 50,
      killSessions: async () => { kills++; },
      takeSessions: () => [{ cli: 'claude', args: ['-p', 'x'], at: Date.now(), exitCode: null, buffer: 'Not logged in' }],
    });
    assert.equal(result.failed, true);
    assert.deepEqual(result.counts, { pass: 1, flaky: 0, timeout: 1, fail: 0, skip: 0 });
    assert.equal(starts, 2, 'a timed-out attempt is retried once, like any failure');
    assert.ok(kills >= 2, 'each timed-out attempt kills its sessions');
    assert.ok(logs.includes('TIMEOUT hangs (hangs.e2e.mjs): no attempt finished within 0s'), logs.join('\n'));
    assert.match(errs.at(-1), /TIMEOUT: scenario "hangs" \(hangs\.e2e\.mjs\)/);
    assert.deepEqual(readdirSync(logDir).sort(), ['01-hangs.log', '02-after.log']);
    const hangLog = readFileSync(path.join(logDir, '01-hangs.log'), 'utf8');
    assert.match(hangLog, /== attempt 1: TIMEOUT/);
    assert.match(hangLog, /== attempt 2: TIMEOUT/);
    assert.match(hangLog, /--- claude \["-p","x"\][^\n]*\nNot logged in/);
    assert.match(readFileSync(path.join(logDir, '02-after.log'), 'utf8'), /== attempt 1: ok/);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
