// Isolation machinery for `--mode temp`. A
// sandbox is a scratch directory holding a whole temp HOME: its
// `.claude`, `.codex`, `.agent-bridge` and `.local/bin` are laid down by the
// real `chattr/install.sh --trust` (lib/hookConfig.mjs), and every real CLI
// runs with HOME pointed at it, so a temp run sees the same hook commands,
// default paths and Codex hook trust an installed machine does and never
// touches ~/.claude, ~/.codex or ~/.agent-bridge (the epic's hard limit).
//
// Every real CLI spawn goes through `spawnClaude`/`spawnCodex`/`spawnClaudeStream`
// below, which append a record to the sandbox's invocation log before
// spawning. `assertInvocationsIsolated` reads that log back and fails loud if
// any recorded invocation was not pointed at the sandbox -- the "invocation
// log assertion" this issue calls for, independent of (and in addition to)
// the sha256 manifest diff in `manifest.mjs`, which proves the same thing
// from the filesystem's side. `assertInvocationsIsolated` is a `--mode temp`
// check only: `run.mjs`'s `--mode installed` reuses these same spawn
// functions against a context object that points at the REAL ~/.claude,
// ~/.codex and ~/.agent-bridge on purpose, and never calls it.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { claudeSession, codexSession } from './pty.mjs';

const REAL_HOME = homedir();
const REAL_CLAUDE_DIR = path.join(REAL_HOME, '.claude');
const REAL_CODEX_DIR = path.join(REAL_HOME, '.codex');

// Claude Code's auth is not portable across a fresh CLAUDE_CONFIG_DIR the way
// Codex's auth.json is (lib/pty.mjs's header comment; verified while building
// this harness). The fix: a long-lived
// `claude setup-token`, stored in the macOS Keychain (service
// `chattr-e2e-claude-token`, account $USER) once by the user, read here into
// CLAUDE_CODE_OAUTH_TOKEN for TEMP-MODE Claude invocations only -- never for
// `--mode installed` (which uses the real login), never printed, never
// logged, never written to disk. Cached per process so a run with many
// scenarios only pays the `security` call once.
let cachedClaudeToken;
function claudeOAuthToken() {
  if (cachedClaudeToken !== undefined) return cachedClaudeToken;
  try {
    cachedClaudeToken = execFileSync('security', ['find-generic-password', '-a', process.env.USER, '-s', 'chattr-e2e-claude-token', '-w'], { encoding: 'utf8' }).trim();
  } catch {
    cachedClaudeToken = null;
  }
  return cachedClaudeToken;
}

/** `{}` for `--mode installed` (sandbox.claudeConfigDir === the REAL ~/.claude): that mode uses the real login. */
function claudeAuthEnv(sandbox) {
  if (sandbox.claudeConfigDir === REAL_CLAUDE_DIR) return {};
  const token = claudeOAuthToken();
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
}

export function createSandbox(prefix = 'chattr-e2e-') {
  // realpath: macOS tmpdir is a /var -> /private/var symlink, and hook paths must compare equal.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const home = path.join(root, 'home');
  const claudeConfigDir = path.join(home, '.claude');
  const codexHome = path.join(home, '.codex');
  const agentBridgeDir = path.join(home, '.agent-bridge');
  const binDir = path.join(root, 'bin');
  for (const dir of [claudeConfigDir, codexHome, agentBridgeDir, binDir]) mkdirSync(dir, { recursive: true });
  return {
    root,
    home,
    claudeConfigDir,
    codexHome,
    agentBridgeDir,
    binDir,
    dbFile: path.join(agentBridgeDir, 'bridge.db'),
    invocationLog: path.join(root, 'invocations.jsonl'),
  };
}

/**
 * A sandbox-shaped context for `--mode installed` (used by `run.mjs`'s
 * `runInstalled`, never by `run.mjs`'s `runTemp` or by this repo's own test
 * run -- see the epic's "Do NOT run it" limit). Same field names as
 * `createSandbox`'s return value, so every scenario's `spawnClaude`/
 * `spawnCodex`/`spawnClaudeStream`/`fakePs` call works unchanged, but
 * `claudeConfigDir`/`codexHome`/`dbFile` point at the REAL home instead of a
 * scratch one. `root`/`binDir`/`invocationLog` still live under a throwaway
 * temp dir -- only `fakePs` and the invocation log need scratch space, and
 * neither is home config.
 */
export function createInstalledContext(prefix = 'chattr-e2e-installed-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  return {
    root,
    home: REAL_HOME,
    claudeConfigDir: path.join(REAL_HOME, '.claude'),
    codexHome: path.join(REAL_HOME, '.codex'),
    agentBridgeDir: path.join(REAL_HOME, '.agent-bridge'),
    binDir,
    dbFile: path.join(REAL_HOME, '.agent-bridge', 'bridge.db'),
    invocationLog: path.join(root, 'invocations.jsonl'),
  };
}

/** Removes only the scratch part of an installed-mode context (never the real home dirs it points at). */
export function cleanupInstalledContext(context) {
  cleanupSandbox(context);
}

function logInvocation(sandbox, record) {
  appendFileSync(sandbox.invocationLog, `${JSON.stringify({ at: Date.now(), ...record })}\n`);
}

/**
 * The environment a real CLI gets, identical in shape for both modes: HOME is the context's
 * home, its `.local/bin` (where install.sh links `chattr`) leads PATH, and CLAUDE_CONFIG_DIR,
 * CODEX_HOME and CHATTR_DB are set only when they differ from that home's defaults, the way a
 * launcher-started session has them.
 *
 * Root cause of the first cutover's rollback: installed mode exported
 * CLAUDE_CONFIG_DIR=~/.claude. Claude Code treats any explicit CLAUDE_CONFIG_DIR as a separate
 * profile (its state file becomes $CLAUDE_CONFIG_DIR/.claude.json, with no login), so every
 * harness-started Claude session answered "Not logged in" and never ran a turn.
 */
export function cliEnv(sandbox, kind, extra = {}) {
  const env = { ...process.env, ...extra, HOME: sandbox.home };
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CHATTR_DB', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[name];
  env.PATH = `${path.join(sandbox.home, '.local', 'bin')}:${extra.PATH ?? process.env.PATH}`;
  if (sandbox.dbFile !== path.join(sandbox.home, '.agent-bridge', 'bridge.db')) env.CHATTR_DB = sandbox.dbFile;
  if (kind === 'claude') {
    if (sandbox.claudeConfigDir !== path.join(sandbox.home, '.claude')) env.CLAUDE_CONFIG_DIR = sandbox.claudeConfigDir;
    Object.assign(env, claudeAuthEnv(sandbox));
  } else if (sandbox.codexHome !== path.join(sandbox.home, '.codex')) {
    env.CODEX_HOME = sandbox.codexHome;
  }
  return env;
}

// Every live CLI this process started, so a timed-out scenario's sessions can be killed and
// every scenario's session output can land in its log (lib/runner.mjs).
const started = [];

function track(sandbox, cli, args, session) {
  started.push({ cli, args, session, at: Date.now() });
  return session;
}

/** Removes and returns the sessions started since the last call: {cli, args, at, buffer, exitCode}. */
export function takeSessions() {
  return started.splice(0).map(({ cli, args, at, session }) => ({ cli, args, at, get buffer() { return session.buffer; }, get exitCode() { return session.child.exitCode; }, session }));
}

/** Kills every session started since the last takeSessions() and waits for each to exit. */
export async function killSessions(sessions = started) {
  await Promise.all(sessions.map(({ session }) => session.kill().catch(() => {})));
}

/**
 * Real Codex CLI runs need a token, and Codex's is a plain file
 * (`~/.codex/auth.json`) rather than an OS keychain entry. Copying it into the
 * sandbox's isolated CODEX_HOME is the same move `chattr/SPEC.md`'s own
 * proof transcripts made (section 2, Transcript B/C) -- a READ of the real
 * file, a WRITE only inside the sandbox, never back. Claude Code's auth is
 * NOT config-dir-portable this way (verified while building this harness: a
 * fresh CLAUDE_CONFIG_DIR reports "Not logged in" even with a valid session
 * elsewhere) and its storage is out of this issue's reach -- see
 * scenarios/pty-smoke.e2e.mjs for what that means for the Claude smoke run.
 */
export function seedCodexAuth(sandbox) {
  const src = path.join(REAL_CODEX_DIR, 'auth.json');
  const dest = path.join(sandbox.codexHome, 'auth.json');
  if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
}

export function spawnClaude(sandbox, { args = [], cwd, env = {}, interactive = false } = {}) {
  logInvocation(sandbox, { cli: 'claude', args, env: { HOME: sandbox.home, CLAUDE_CONFIG_DIR: sandbox.claudeConfigDir } });
  return track(sandbox, 'claude', args, claudeSession({ cwd, args, env: cliEnv(sandbox, 'claude', env), interactive }));
}

// Hook trust is real in both modes: temp mode's home was installed by
// `install.sh --trust` (lib/hookConfig.mjs), exactly like the cutover, so no
// `--dangerously-bypass-hook-trust`. `bypassHookTrust: true` remains for a
// one-off diagnosis only.
// No `--color` override here: it is a real, top-level flag on `codex exec`
// but is refused by `codex exec resume` and `codex queue` (verified while
// building this harness), so it cannot be added uniformly for every
// subcommand a scenario might pass. A scenario that needs to parse `codex`'s
// own styled output (session id, etc.) strips ANSI escapes itself -- see
// codex-claude-consult.e2e.mjs.
export function spawnCodex(sandbox, { args = [], cwd, env = {}, interactive = false, bypassHookTrust = false } = {}) {
  seedCodexAuth(sandbox);
  const fullArgs = bypassHookTrust ? ['--dangerously-bypass-hook-trust', ...args] : args;
  logInvocation(sandbox, { cli: 'codex', args: fullArgs, env: { HOME: sandbox.home, CODEX_HOME: sandbox.codexHome } });
  return track(sandbox, 'codex', fullArgs, codexSession({ cwd, args: fullArgs, env: cliEnv(sandbox, 'codex', env), interactive }));
}

/**
 * A real, resident `claude` process for busy/idle scenarios that need a
 * session to stay alive (and keep listening on its native inbox socket)
 * between turns: `--print --input-format stream-json --output-format
 * stream-json` accepts one JSON user frame per turn over a real stdin pipe
 * and does not exit when a turn ends, unlike `-p`. It needs no pty at all
 * (proven while building this harness: lib/pty.mjs's `script` wrapper fails
 * `tcgetattr` on a piped stdin -- this mode sidesteps that by never asking
 * for a tty in the first place), so it is spawned directly rather than
 * through lib/pty.mjs.
 */
export function spawnClaudeStream(sandbox, { cwd, model = 'haiku', extraArgs = [] } = {}) {
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, ...extraArgs];
  logInvocation(sandbox, { cli: 'claude', args, env: { HOME: sandbox.home, CLAUDE_CONFIG_DIR: sandbox.claudeConfigDir } });
  const child = spawn('claude', args, { cwd, env: cliEnv(sandbox, 'claude'), stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  child.stdout.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  return track(sandbox, 'claude', args, {
    child,
    get buffer() { return buffer; },
    /** Sends one user turn as a stream-json frame (no trailing newline needed -- one is added). */
    send(text) {
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  });
}

/** @returns {{ok: boolean, checked: number, problems: string[]}} */
export function assertInvocationsIsolated(sandbox) {
  if (!existsSync(sandbox.invocationLog)) return { ok: true, checked: 0, problems: [] };
  const records = readFileSync(sandbox.invocationLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const problems = [];
  for (const record of records) {
    if (record.env?.HOME !== undefined && !record.env.HOME.startsWith(sandbox.root)) problems.push(`${record.cli} invocation with an unsandboxed HOME: ${record.env.HOME}`);
    if (record.cli === 'claude') {
      const dir = record.env?.CLAUDE_CONFIG_DIR;
      if (!dir || !dir.startsWith(sandbox.root)) problems.push(`claude invocation without a sandboxed CLAUDE_CONFIG_DIR: ${JSON.stringify(record)}`);
      if (dir === REAL_CLAUDE_DIR) problems.push(`claude invocation pointed at a real config dir: ${dir}`);
    } else if (record.cli === 'codex') {
      const dir = record.env?.CODEX_HOME;
      if (!dir || !dir.startsWith(sandbox.root)) problems.push(`codex invocation without a sandboxed CODEX_HOME: ${JSON.stringify(record)}`);
      if (dir === REAL_CODEX_DIR) problems.push(`codex invocation pointed at the real config dir: ${dir}`);
    } else {
      problems.push(`unrecognized invocation record: ${JSON.stringify(record)}`);
    }
  }
  return { ok: problems.length === 0, checked: records.length, problems };
}

export function cleanupSandbox(sandbox) {
  try {
    rmSync(sandbox.root, { recursive: true, force: true });
  } catch {
    // Best-effort: cleanup must never throw and mask a real scenario failure.
  }
}
