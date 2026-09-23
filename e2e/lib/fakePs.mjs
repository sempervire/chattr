// A fake `ps` ahead of the real one on PATH, so a guard scenario controls
// `chattr who --coverage`'s process count instead of the real machine
// dictating it (this dev box always has live claude/codex processes while
// these scenarios run). Ported from the same fixture in
// hooks/test/worktree-guard.test.mjs -- kept here rather than duplicated,
// since guard e2e scenarios need the identical trick.
//
// Only the aggregate `-Ao pid=,ppid=,comm=` scan is faked; a per-pid `-p`
// lookup (liveness / pid_start checks) delegates to the real `/bin/ps`, or
// every session this harness enrolls would look "gone".

import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FAKE_PS = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args.includes('-p')) {
  try {
    process.stdout.write(execFileSync('/bin/ps', args, { encoding: 'utf8' }))
  } catch {
    process.exitCode = 1
  }
} else {
  process.stdout.write(process.env.FAKE_PS_LINES || '')
}
`;

/** Installs the fake `ps` into `sandbox.binDir` (created once; safe to call more than once). */
export function installFakePs(sandbox) {
  const file = path.join(sandbox.binDir, 'ps');
  writeFileSync(file, FAKE_PS);
  chmodSync(file, 0o755);
  return file;
}
