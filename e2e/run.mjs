#!/usr/bin/env node
// chattr/e2e/run.mjs -- the unattended test harness.
//
// `--mode temp` (the only mode this issue's own `npm run e2e` runs): the run
// gets an isolated sandbox holding a whole temp HOME (lib/isolation.mjs), so a
// real CLI invocation never touches ~/.claude, ~/.codex or ~/.agent-bridge.
// That HOME is laid down by the real `chattr/install.sh --trust`
// (lib/hookConfig.mjs) before any scenario runs, and every CLI runs
// with HOME pointed at it, so temp mode sees the same hook commands, default
// paths, `chattr` link and Codex hook trust as an installed machine.
//
// Flags: `--only <text>` runs scenarios whose file name contains it;
// `--log-dir <dir>` writes one log per scenario (attempts, errors, every CLI
// session's full output); `--timeout <seconds>` sets the per-attempt hard
// timeout (lib/runner.mjs; default 240s, env CHATTR_E2E_TIMEOUT_S).
//
// Isolation is proven two ways:
//   1. a sha256 manifest of the watched files (chattr checkout and home config), snapshotted
//      before and after the run (lib/manifest.mjs) -- nothing in it may change.
//   2. an invocation log of every real `claude`/`codex` spawn this run made,
//      asserted afterwards to have used only sandboxed config dirs
//      (lib/isolation.mjs's assertInvocationsIsolated).
//
// `--mode installed` drives the real CLIs against real home config: real
// ~/.claude, ~/.codex and ~/.agent-bridge, with hooks already installed for
// real by `install.sh`. This harness's own `npm run e2e` never invokes this
// mode -- run it by hand after installing, as a live check of the real
// machine: it runs the exact same
// scenario suite as `--mode temp` against a context object shaped like a
// sandbox (lib/isolation.mjs's `createInstalledContext`) but pointing at the
// real config dirs, so every scenario's `spawnClaude`/`spawnCodex` call works
// unchanged. It skips both temp-mode-only proofs (the isolation manifest and
// the invocation-log assertion) because touching real config is the point,
// not a violation, and it never writes hook registrations of its own -- the
// cutover script's earlier steps already did that for real.
//
// Cleanup runs on every exit path, including a thrown/rejected scenario: the
// sandbox (or installed-mode scratch dir) is removed in `finally`, and
// SIGINT/SIGTERM are caught so a killed run does not leave a temp
// CLAUDE_CONFIG_DIR/CODEX_HOME/bridge.db behind. `--mode installed` never
// removes ~/.claude, ~/.codex or ~/.agent-bridge themselves -- only its own
// scratch bin/invocation-log dir.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanupSandbox, cleanupInstalledContext, createSandbox, createInstalledContext, assertInvocationsIsolated, killSessions, takeSessions } from './lib/isolation.mjs';
import { installSandboxHooks } from './lib/hookConfig.mjs';
import { diffManifests, snapshotManifest } from './lib/manifest.mjs';
import { discoverScenarios } from './lib/scenarios.mjs';
import { DEFAULT_SCENARIO_TIMEOUT_MS, runScenarioList } from './lib/runner.mjs';
import { CHATTR_DIR } from './lib/paths.mjs';

function parseArgs(argv) {
  const flags = { mode: 'temp' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') flags.mode = argv[++i];
    if (argv[i] === '--only') flags.only = argv[++i];
    if (argv[i] === '--log-dir') flags.logDir = path.resolve(argv[++i]);
    if (argv[i] === '--timeout') flags.timeoutS = Number(argv[++i]);
  }
  flags.timeoutS ??= Number(process.env.CHATTR_E2E_TIMEOUT_S) || undefined;
  return flags;
}

/** Runs every non-`needs` scenario against one context, sequentially, one retry each (lib/runner.mjs). */
async function runScenarios(context, { only, logDir, timeoutS }) {
  // `--only <text>` runs the scenarios whose file name contains it (re-verifying one flaky scenario).
  const scenarios = (await discoverScenarios()).filter((s) => !only || s.file.includes(only));
  if (logDir) console.log(`per-scenario logs: ${logDir}`);
  const timeoutMs = timeoutS > 0 ? timeoutS * 1000 : DEFAULT_SCENARIO_TIMEOUT_MS;
  return (await runScenarioList(scenarios, context, { logDir, timeoutMs, killSessions, takeSessions })).failed;
}

function withCleanup(context, cleanupFn) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupFn(context);
  };
  const handlers = [];
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = async () => {
      await killSessions();
      cleanup();
      process.exit(130);
    };
    process.once(signal, handler);
    handlers.push([signal, handler]);
  }
  return { cleanup, handlers };
}

async function runTemp(flags) {
  const manifestOpts = { repos: [CHATTR_DIR] };

  const sandbox = createSandbox();
  const { cleanup } = withCleanup(sandbox, cleanupSandbox);

  let failed = false;
  try {
    console.log(`chattr e2e (temp mode): sandbox ${sandbox.root}`);
    installSandboxHooks(sandbox, CHATTR_DIR, { log: (text) => { if (flags.logDir) { mkdirSync(flags.logDir, { recursive: true }); writeFileSync(path.join(flags.logDir, '00-install.log'), text); } } });
    console.log(`install.sh --trust ran against ${sandbox.home}`);
    const before = snapshotManifest(manifestOpts);

    failed = await runScenarios(sandbox, flags);

    const after = snapshotManifest(manifestOpts);
    const changed = diffManifests(before, after);
    if (changed.length) {
      failed = true;
      console.error(`ISOLATION VIOLATION: ${changed.length} watched file(s) changed during this temp-mode run:`);
      for (const c of changed) console.error(`  ${c.file}`);
    } else {
      console.log(`isolation manifest: ${Object.keys(before).length} watched file(s) unchanged.`);
    }

    const invocationCheck = assertInvocationsIsolated(sandbox);
    if (!invocationCheck.ok) {
      failed = true;
      console.error(`ISOLATION VIOLATION: ${invocationCheck.problems.length} unsandboxed CLI invocation(s):`);
      for (const p of invocationCheck.problems) console.error(`  ${p}`);
    } else {
      console.log(`invocation log: ${invocationCheck.checked} real CLI invocation(s), all sandboxed.`);
    }
  } finally {
    await killSessions();
    cleanup();
    console.log(`sandbox removed: ${sandbox.root}`);
  }
  return failed ? 1 : 0;
}

/**
 * Drives the real CLIs against the real ~/.claude, ~/.codex and
 * ~/.agent-bridge. Never called by this repo's own `npm run e2e` or `npm
 * test` -- see the module comment. Run it by hand after `install.sh --trust`.
 */
async function runInstalled(flags) {
  const context = createInstalledContext();
  const { cleanup } = withCleanup(context, cleanupInstalledContext);

  let failed;
  try {
    console.log('chattr e2e (installed mode): real ~/.claude, ~/.codex, ~/.agent-bridge.');
    console.log('Hooks are assumed already installed for real (chattr/install.sh --trust); this run does not write them.');
    failed = await runScenarios(context, flags);
  } finally {
    await killSessions();
    cleanup();
  }
  return failed ? 1 : 0;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const { mode } = flags;
  if (mode === 'installed') return runInstalled(flags);
  if (mode !== 'temp') {
    console.error(`chattr e2e: --mode must be temp|installed, got "${mode}"`);
    return 2;
  }
  return runTemp(flags);
}

process.exitCode = await main();
