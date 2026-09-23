// Puts a real `chattr` executable on PATH inside a sandbox, for scenarios
// where the LIVE model itself must run `chattr reply`/`chattr inbox`
// (the consult round-trip scenarios). A real install symlinks `chattr`
// into `~/.local/bin` (chattr/hook/install.mjs); temp mode has no such
// symlink on the live CLI's PATH by default, so a live session that tries to
// run the exact command its injected consult suggests gets "command not
// found" -- proven while building this harness. A plain wrapper script (not
// a symlink into sandbox.binDir, which is also where lib/fakePs.mjs puts its
// fake `ps`) fixes that without touching the real `~/.local/bin`.

import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CHATTR_BIN } from './paths.mjs';

/** Installs an `chattr` wrapper into `sandbox.binDir` (idempotent) and returns its path. */
export function installChattrBin(sandbox) {
  const file = path.join(sandbox.binDir, 'chattr');
  writeFileSync(file, `#!/bin/sh\nexec node "${CHATTR_BIN}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}
