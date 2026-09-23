// install.sh [--dry-run] [--trust] [--snapshot <dir>] [--home <dir>] [--root <dir>] [--tab-guard <file>]
// Registers the composed hooks in ~/.claude/settings.json and ~/.codex/hooks.json, replacing earlier
// chattr (and agentbus) hooks, worktree guards, standalone tab-guard and legacy notify registrations; creates
// ~/.agent-bridge and makes it a Codex writable root; links `chattr` into ~/.local/bin.
// Idempotent. Nothing is written without --snapshot, which receives a copy of every overwritten file.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// worktree-setup.sh is deliberately absent: chattr does not install it, so it keeps any registration it finds.
const REPLACED = /agent-notify\.sh|herdr-agent-state\.sh|browser-tab-guard\.mjs|worktree-guard\.mjs|worktree-session-start\.mjs|(agentbus|chattr)\.mjs"? hook /;
const GUARD_DENY = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"worktree-guard could not run, so another session sharing this checkout cannot be ruled out. Blocking by design (fail closed). Move to a worktree, or set CLAUDE_ALLOW_SHARED_CWD=1 to share deliberately."}}`;

const group = (command, extra = {}, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10, ...extra }] });

/** The composed hook groups for one CLI, by event. */
export function composedHooks(kind, root, tabGuard) {
  const bus = (event) => `${event === 'Stop' && tabGuard ? `CHATTR_TAB_GUARD="${tabGuard}" ` : ''}node "${root}/chattr.mjs" hook ${event} --agent ${kind}`;
  const hook = (event, matcher, extra) => group(bus(event), extra, matcher);
  const guard = group(`CHATTR_BIN="${root}/chattr.mjs" node "${root}/hooks/worktree-guard.mjs" || echo '${GUARD_DENY}'`,
    { statusMessage: 'Checking for other sessions in this directory' }, kind === 'claude' ? 'Edit|Write|NotebookEdit' : '^(apply_patch|Edit|Write)$');
  const sessionStart = group(`CHATTR_BIN="${root}/chattr.mjs" node "${root}/hooks/worktree-session-start.mjs"`, { statusMessage: 'Checking for another session in this directory' });
  const stop = hook('Stop', undefined, { timeout: 20, statusMessage: 'chattr: delivery and open-tab check' });
  if (kind === 'claude') {
    return {
      SessionStart: [hook('SessionStart'), sessionStart],
      UserPromptSubmit: [hook('UserPromptSubmit')],
      PreToolUse: [guard, hook('PreToolUse', '^AskUserQuestion$')],
      PostToolUse: [hook('PostToolUse')],
      Stop: [stop],
      StopFailure: [hook('StopFailure')],
      Notification: [hook('Notification', 'permission_prompt|elicitation_dialog')],
    };
  }
  return {
    SessionStart: [hook('SessionStart'), sessionStart],
    UserPromptSubmit: [hook('UserPromptSubmit')],
    PreToolUse: [guard, hook('PreToolUse', '^request_user_input(_async)?$')],
    PostToolUse: [hook('PostToolUse')],
    PermissionRequest: [hook('PermissionRequest')],
    Stop: [stop],
    Interrupt: [hook('Interrupt')],
  };
}

/** Remove every replaced registration, then append the composed groups. Pure; idempotent. */
export function compose(config, kind, root, tabGuard) {
  const hooks = {};
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    const kept = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !REPLACED.test(h.command ?? '')) })).filter((g) => g.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(composedHooks(kind, root, tabGuard))) hooks[event] = [...(hooks[event] ?? []), ...groups];
  return { ...config, hooks };
}

/** Add `dir` to [sandbox_workspace_write] writable_roots in config.toml text. Idempotent. */
export function addWritableRoot(toml, dir) {
  const quoted = JSON.stringify(dir);
  const lines = toml.split('\n');
  const header = lines.findIndex((l) => l.trim() === '[sandbox_workspace_write]');
  if (header < 0) return `${toml.replace(/\n*$/, '\n')}\n[sandbox_workspace_write]\nwritable_roots = [${quoted}]\n`;
  let end = lines.findIndex((l, i) => i > header && l.trim().startsWith('['));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > header && i < end && /^\s*writable_roots\s*=/.test(l));
  if (at < 0) {
    lines.splice(header + 1, 0, `writable_roots = [${quoted}]`);
  } else if (!lines[at].includes(quoted)) {
    const m = lines[at].match(/^(\s*writable_roots\s*=\s*\[)(.*)\]\s*$/);
    if (!m) throw new Error('writable_roots spans several lines; add ~/.agent-bridge by hand');
    const items = m[2].trim().replace(/,$/, '');
    lines[at] = `${m[1]}${items ? `${items}, ` : ''}${quoted}]`;
  }
  return lines.join('\n');
}

function diff(label, before, after) {
  const dir = mkdtempSync(path.join(tmpdir(), 'chattr-install-'));
  writeFileSync(path.join(dir, 'a'), before);
  writeFileSync(path.join(dir, 'b'), after);
  const out = spawnSync('diff', ['-u', '--label', `${label} (current)`, '--label', `${label} (composed)`, path.join(dir, 'a'), path.join(dir, 'b')], { encoding: 'utf8' });
  return out.stdout || `${label}: no changes\n`;
}

/** Talks to the installed Codex app-server: hooks/list, then fn(hooks, writeHookState). */
async function codexHooks(home, fn) {
  const codexHome = path.join(home, '.codex');
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, CODEX_HOME: codexHome } });
  const pending = new Map();
  let buffer = '';
  let next = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      try {
        const message = JSON.parse(buffer.slice(0, i));
        pending.get(message.id)?.(message);
      } catch {}
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await call('initialize', { clientInfo: { name: 'chattr-install', title: null, version: '1' }, capabilities: null });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    const { data } = await call('hooks/list', { cwds: [home] });
    return await fn(data.flatMap((entry) => entry.hooks), (value) => call('config/value/write', { keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }));
  } finally {
    child.kill();
  }
}

export async function install(argv, log = (s) => process.stdout.write(s)) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  const home = path.resolve(value('home') ?? homedir());
  const root = path.resolve(value('root') ?? realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  const dryRun = flag('dry-run');
  const snapshot = value('snapshot');
  const tabGuard = value('tab-guard') && path.resolve(value('tab-guard'));
  if (!dryRun && !snapshot) {
    log('install.sh: pass --snapshot <dir> (receives a copy of every file it overwrites) or --dry-run\n');
    return 2;
  }
  const bridge = path.join(home, '.agent-bridge');
  const link = path.join(home, '.local', 'bin', 'chattr');
  const cli = path.join(root, 'chattr.mjs');
  const read = (file, fallback) => (existsSync(file) ? readFileSync(file, 'utf8') : fallback);
  const files = [
    ['claude', path.join(home, '.claude', 'settings.json')],
    ['codex', path.join(home, '.codex', 'hooks.json')],
  ].map(([kind, file]) => {
    const before = read(file, '{}\n');
    return { file, before, after: `${JSON.stringify(compose(JSON.parse(before), kind, root, tabGuard), null, 2)}\n`, pretty: `${JSON.stringify(JSON.parse(before), null, 2)}\n` };
  });
  const toml = path.join(home, '.codex', 'config.toml');
  const tomlBefore = read(toml, '');
  files.push({ file: toml, before: tomlBefore, after: addWritableRoot(tomlBefore, bridge), pretty: tomlBefore });

  for (const f of files) log(diff(f.file, f.pretty, f.after));
  const present = (() => { try { return lstatSync(link); } catch { return null; } })();
  const linked = Boolean(present?.isSymbolicLink() && readlinkSync(link) === cli);
  log(`${existsSync(bridge) ? 'exists' : 'create'}: ${bridge}\n${linked ? 'exists' : 'link'}: ${link} -> ${cli}\n`);
  if (dryRun) {
    log('dry run: nothing written.\nCodex hook trust: after installing, run install.sh --trust --snapshot <dir>, or review with /hooks in a fresh Codex session.\n');
    return 0;
  }
  // Trust keys are positional, so a reorder un-trusts hooks the user already trusted: remember them.
  const trustedBefore = flag('trust') ? await codexHooks(home, (hooks) => new Set(hooks.filter((h) => h.trustStatus === 'trusted').map((h) => h.command))) : null;
  // Snapshot all three first: --trust rewrites config.toml even when this run did not.
  for (const f of files.filter((x) => existsSync(x.file))) {
    const copy = path.join(snapshot, path.relative(home, f.file));
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(f.file, copy);
  }
  for (const f of files.filter((x) => x.after !== x.before)) {
    mkdirSync(path.dirname(f.file), { recursive: true });
    writeFileSync(f.file, f.after);
  }
  mkdirSync(bridge, { recursive: true });
  if (!linked) {
    if (present) throw new Error(`${link} exists and is not the chattr link; move it aside first`);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(cli, link);
  }
  if (trustedBefore) {
    const trusted = await codexHooks(home, async (hooks, write) => {
      const due = hooks.filter((h) => h.trustStatus !== 'trusted' && (h.command?.includes(root) || trustedBefore.has(h.command)));
      if (due.length) await write(Object.fromEntries(due.map((h) => [h.key, { trusted_hash: h.currentHash }])));
      return due.map((h) => h.key);
    });
    log(`trusted Codex hooks: ${trusted.join(', ') || 'none needed'}\n`);
  }
  else log('Codex hook trust: run install.sh --trust --snapshot <dir>, or review with /hooks in a fresh Codex session.\n');
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`install.sh: ${error.message}`); process.exitCode = 1; });
}
