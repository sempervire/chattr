// The sha256 before/after manifest behind the harness's isolation proof.
// `run.mjs` snapshots this once before running any temp-mode scenario and
// once after; a diff proves nothing watched -- the chattr checkout and the
// real ~/.claude and ~/.codex config -- moved
// while the harness ran, which is the closest thing to a receipt for the
// hard limit "never write to ~/.claude, ~/.codex or ~/.agent-bridge".

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_CLAUDE_NAMES = ['settings.json', 'CLAUDE.md', 'hooks', 'commands', 'agents'];
const HOME_CODEX_FILES = ['config.toml', 'hooks.json', 'AGENTS.md'];
const HOME_CODEX_DIRS = ['rules', 'hooks', 'mcp', 'prompts'];

function walk(entryPath) {
  if (!existsSync(entryPath)) return [];
  const st = statSync(entryPath);
  if (st.isFile()) return [entryPath];
  if (!st.isDirectory()) return [];
  return readdirSync(entryPath, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(entryPath, entry.name);
    return entry.isDirectory() ? walk(child) : entry.isFile() ? [child] : [];
  });
}

function repoFiles(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((rel) => path.join(repoDir, rel));
  } catch {
    return [];
  }
}

function homeConfigFiles(home) {
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  const projectsDir = path.join(claudeDir, 'projects');
  return [
    ...HOME_CLAUDE_NAMES.flatMap((name) => walk(path.join(claudeDir, name))),
    ...walk(path.join(home, '.claude.json')),
    ...HOME_CODEX_FILES.flatMap((name) => walk(path.join(codexDir, name))),
    ...HOME_CODEX_DIRS.flatMap((name) => walk(path.join(codexDir, name))),
    // the memory dirs: ~/.claude/projects/*/memory/
    ...(existsSync(projectsDir) ? readdirSync(projectsDir).flatMap((name) => walk(path.join(projectsDir, name, 'memory'))) : []),
  ];
}

// A real, reproducible discovery from building this harness: a native UDS
// wake (chattr/wake.mjs's `sendUds`, exercised for real by
// scenarios/wake-idle-peer.e2e.mjs) makes the live Claude Code binary
// increment `promptQueueUseCount` in `~/.claude.json` -- REGARDLESS of
// CLAUDE_CONFIG_DIR. `~/.claude.json` is a single global file, not part of
// the `~/.claude/` directory CLAUDE_CONFIG_DIR relocates, so a fully
// isolated temp-mode session cannot avoid it while exercising the wake path
// the epic's own scenario list requires. It is not a bug in chattr/hook or
// chattr.mjs (neither writes there) -- it is the real Claude Code CLI, and
// it is out of this issue's reach to change (same category as
// scenarios/pty-smoke.e2e.mjs's "Claude Code's auth is not portable" note).
//
// This harness must never write to the real ~/.claude.json itself (a hard
// limit), so it cannot "fix" the file -- it normalizes away this ONE proven,
// benign, non-content field before hashing, so the manifest still catches
// any OTHER change to this file (or anything else in it) while not treating
// Claude Code's own known telemetry counter as an isolation violation.
const VOLATILE_CLAUDE_JSON_FIELDS = ['promptQueueUseCount'];

function normalizedContent(file, raw, claudeJsonPath) {
  if (file !== claudeJsonPath) return raw;
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    for (const field of VOLATILE_CLAUDE_JSON_FIELDS) delete parsed[field];
    return JSON.stringify(parsed);
  } catch {
    return raw; // unparseable: fall back to the strict raw-byte comparison
  }
}

/** @returns {Record<string, string|null>} path -> sha256 hex, or null if unreadable. */
export function snapshotManifest({ repos = [], home = os.homedir() } = {}) {
  const contentFiles = [...new Set([...repos.flatMap(repoFiles), ...homeConfigFiles(home)])];
  const claudeJsonPath = path.join(home, '.claude.json');
  const manifest = {};
  for (const file of contentFiles) {
    try {
      manifest[file] = createHash('sha256').update(normalizedContent(file, readFileSync(file), claudeJsonPath)).digest('hex');
    } catch {
      manifest[file] = null;
    }
  }
  return manifest;
}

/** @returns {{file: string, before: string|null, after: string|null}[]} */
export function diffManifests(before, after) {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const file of files) {
    if (before[file] !== after[file]) changed.push({ file, before: before[file] ?? null, after: after[file] ?? null });
  }
  return changed;
}
