// Lays down a temp-mode sandbox's HOME with the real installer.
//
// Temp mode used to write settings.json/hooks.json itself from install.mjs's `compose()` and skip
// Codex hook trust with `--dangerously-bypass-hook-trust`. That matched the hook groups but not
// the install: not the command strings against a real HOME, not the `~/.local/bin/chattr` link,
// not the writable root, not trust, and not how a session finds its config. The first cutover
// failed on exactly that kind of difference, so temp mode now runs `chattr/install.sh --trust`
// against the sandbox's HOME, the same invocation cutover-chattr.sh step 3a makes.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedCodexAuth } from './isolation.mjs';
import { CHATTR_DIR } from './paths.mjs';

/** Runs the real install.sh --trust against sandbox.home. Throws with its output on failure. */
export function installSandboxHooks(sandbox, root = CHATTR_DIR, { log = () => {} } = {}) {
  mkdirSync(sandbox.codexHome, { recursive: true });
  // Pre-existing user config the installer must preserve: keep temp Codex runs cheap.
  writeFileSync(path.join(sandbox.codexHome, 'config.toml'), 'model_reasoning_effort = "low"\n');
  seedCodexAuth(sandbox);
  const args = [path.join(CHATTR_DIR, 'install.sh'), '--trust', '--snapshot', path.join(sandbox.root, 'install-snapshot'), '--home', sandbox.home, '--root', root];
  const env = { ...process.env, HOME: sandbox.home };
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  const run = spawnSync('sh', args, { encoding: 'utf8', env, timeout: 120_000 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  log(output);
  if (run.status !== 0) throw new Error(`install.sh --trust against ${sandbox.home} exited ${run.status ?? run.signal}:\n${output}`);
  if (!/trusted Codex hooks: (?!none needed)/.test(output)) throw new Error(`install.sh --trust recorded no Codex hook trust:\n${output}`);
  return output;
}
