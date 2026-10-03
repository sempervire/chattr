// install.sh against a temp home only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addWritableRoot, compose, install } from '../install.mjs';
import { main } from '../../chattr.mjs';

const ROOT = '/opt/scripts';
const commands = (config) => Object.values(config.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));

const legacyClaude = {
  model: 'opus',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '"/x/agent-notify.sh" claude' }, { type: 'command', command: 'node "$HOME/.claude/hooks/browser-tab-guard.mjs"' }] }, { hooks: [{ type: 'command', command: '/x/cc-status' }] }],
    PreToolUse: [{ matcher: 'Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/worktree-guard.mjs" || echo deny' }] }, { matcher: 'mcp__x', hooks: [{ type: 'command', command: 'node secret-grant.mjs' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: "bash '/h/.codex/herdr-agent-state.sh' session" }] }],
  },
};

test('compose replaces notify, herdr and worktree registrations, keeps the rest (a standalone tab guard included), and is idempotent', () => {
  const once = compose(legacyClaude, 'claude', ROOT);
  const all = commands(once);
  assert.equal(once.model, 'opus');
  assert.ok(all.includes('/x/cc-status') && all.includes('node secret-grant.mjs'));
  assert.ok(!all.some((c) => /agent-notify|herdr|\.claude\/hooks\/worktree/.test(c)));
  assert.deepEqual(once.hooks.Stop.at(-1).hooks.map((h) => h.command), [`node "${ROOT}/chattr.mjs" hook Stop --agent claude`]);
  assert.deepEqual(all.filter((c) => c.includes('browser-tab-guard')), ['node "$HOME/.claude/hooks/browser-tab-guard.mjs"'], 'a standalone tab guard is kept');
  assert.deepEqual(compose(once, 'claude', ROOT), once);
});

test('Codex gets apply_patch on the worktree guard and an Interrupt entry; Claude gets neither', () => {
  const codex = compose({}, 'codex', ROOT);
  assert.equal(codex.hooks.PreToolUse[0].matcher, '^(apply_patch|Edit|Write)$');
  assert.match(codex.hooks.PreToolUse[0].hooks[0].command, /hooks\/worktree-guard\.mjs" \|\| echo/);
  assert.ok(codex.hooks.Interrupt);
  const claude = compose({}, 'claude', ROOT);
  assert.equal(claude.hooks.PreToolUse[0].matcher, 'Edit|Write|NotebookEdit');
  assert.equal(claude.hooks.Interrupt, undefined);
});

test('a reinstall replaces agentbus hooks once and leaves an existing worktree-setup.sh registration as it is', () => {
  const setup = { matcher: 'EnterWorktree', hooks: [{ type: 'command', command: '"/p/hooks/worktree-setup.sh"', timeout: 30 }] };
  const installed = { hooks: {
    PostToolUse: [{ hooks: [{ type: 'command', command: 'node "/old/agentbus/agentbus.mjs" hook PostToolUse --agent claude' }] }, setup],
    Stop: [{ hooks: [{ type: 'command', command: 'node "/old/agentbus/agentbus.mjs" hook Stop --agent claude' }] }],
  } };
  const once = compose(installed, 'claude', ROOT);
  const all = commands(once);
  assert.ok(!all.some((c) => c.includes('agentbus')));
  assert.equal(all.filter((c) => c.endsWith('hook Stop --agent claude')).length, 1);
  assert.deepEqual(once.hooks.PostToolUse.filter((g) => g.matcher === 'EnterWorktree'), [setup]);
  assert.deepEqual(compose(once, 'claude', ROOT), once);
});

test('addWritableRoot appends the table, extends an existing array once, and leaves other tables alone', () => {
  const dir = '/h/.agent-bridge';
  const added = addWritableRoot('model = "x"\n[tui]\nnotifications = false\n', dir);
  assert.match(added, /\[tui\]\nnotifications = false\n\n\[sandbox_workspace_write\]\nwritable_roots = \["\/h\/\.agent-bridge"\]\n$/);
  assert.equal(addWritableRoot(added, dir), added);
  const extended = addWritableRoot('[sandbox_workspace_write]\nwritable_roots = ["/a"]\n[x]\n', dir);
  assert.equal(extended, '[sandbox_workspace_write]\nwritable_roots = ["/a", "/h/.agent-bridge"]\n[x]\n');
  assert.equal(addWritableRoot('[sandbox_workspace_write]\nnetwork_access = true\n', dir), '[sandbox_workspace_write]\nwritable_roots = ["/h/.agent-bridge"]\nnetwork_access = true\n');
});

test('install: --dry-run writes nothing; a real run needs --snapshot, snapshots, writes, and a rerun changes nothing', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'chattr-install-home-'));
  mkdirSync(path.join(home, '.claude'));
  mkdirSync(path.join(home, '.codex'));
  const settings = path.join(home, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify(legacyClaude));
  writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
  let out = '';
  const log = (s) => { out += s; };
  assert.equal(await install(['--dry-run', '--home', home, '--root', ROOT], log), 0);
  assert.match(out, /\+.*chattr\.mjs\\" hook Stop --agent claude/);
  assert.match(out, /create: .*\.agent-bridge/);
  assert.equal(readFileSync(settings, 'utf8'), JSON.stringify(legacyClaude));
  assert.equal(existsSync(path.join(home, '.agent-bridge')), false);
  assert.equal(await install(['--home', home, '--root', ROOT], log), 2);

  const snap = path.join(home, 'snap');
  assert.equal(await install(['--home', home, '--root', ROOT, '--snapshot', snap], log), 0);
  assert.equal(readFileSync(path.join(snap, '.claude', 'settings.json'), 'utf8'), JSON.stringify(legacyClaude));
  assert.ok(commands(JSON.parse(readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'))).some((c) => c.includes('--agent codex')));
  assert.match(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /writable_roots = \[".*\.agent-bridge"\]/);
  assert.ok(existsSync(path.join(home, '.agent-bridge')));
  assert.equal(readlinkSync(path.join(home, '.local', 'bin', 'chattr')), `${ROOT}/chattr.mjs`);

  out = '';
  assert.equal(await install(['--dry-run', '--home', home, '--root', ROOT], log), 0);
  assert.equal(out.match(/no changes/g).length, 3);
  assert.match(out, /exists: .*chattr -> /);
});

test('chattr uninstall-hooks removes only chattr registrations, old --agent and tab-guard forms included; needs --snapshot', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'chattr-uninstall-home-'));
  for (const d of ['.claude', '.codex']) mkdirSync(path.join(home, d));
  const settings = path.join(home, '.claude', 'settings.json');
  const hooksJson = path.join(home, '.codex', 'hooks.json');
  const installed = compose(legacyClaude, 'claude', ROOT);
  installed.hooks.Stop.at(-1).hooks[0].command = `CHATTR_TAB_GUARD="/g/browser-tab-guard.mjs" ${installed.hooks.Stop.at(-1).hooks[0].command}`;
  installed.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node "/w/hooks/browser-tab-guard.mjs"' }] });
  writeFileSync(settings, JSON.stringify(installed));
  writeFileSync(hooksJson, JSON.stringify(compose({}, 'codex', ROOT)));
  const toml = path.join(home, '.codex', 'config.toml');
  writeFileSync(toml, 'model = "x"\n');

  assert.equal((await main(['uninstall-hooks', '--home', home])).code, 2);
  assert.equal((await main(['uninstall-hooks', '--home', home, '--dry-run'])).code, 0);
  assert.equal(readFileSync(settings, 'utf8'), JSON.stringify(installed));

  const snap = path.join(home, 'snap');
  assert.equal((await main(['uninstall-hooks', '--home', home, '--snapshot', snap])).code, 0);
  const left = commands(JSON.parse(readFileSync(settings, 'utf8')));
  assert.deepEqual(left.sort(), ['/x/cc-status', 'node "$HOME/.claude/hooks/browser-tab-guard.mjs"', 'node "/w/hooks/browser-tab-guard.mjs"', 'node secret-grant.mjs']);
  assert.deepEqual(JSON.parse(readFileSync(hooksJson, 'utf8')).hooks, {});
  assert.equal(readFileSync(path.join(snap, '.claude', 'settings.json'), 'utf8'), JSON.stringify(installed));
  assert.equal(readFileSync(toml, 'utf8'), 'model = "x"\n');
  assert.equal(existsSync(path.join(home, '.agent-bridge')), false);
});
