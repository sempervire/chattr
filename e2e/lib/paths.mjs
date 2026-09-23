// Shared path constants for the e2e harness. One place that knows where
// things live relative to this file, so scenarios never hardcode "../../.." chains of their own.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../chattr/e2e/lib
export const E2E_DIR = path.resolve(HERE, '..'); // .../chattr/e2e
export const CHATTR_DIR = path.resolve(E2E_DIR, '..'); // the chattr checkout

export const CHATTR_BIN = path.join(CHATTR_DIR, 'chattr.mjs');
export const WORKTREE_GUARD = path.join(CHATTR_DIR, 'hooks', 'worktree-guard.mjs');
export const WORKTREE_SESSION_START = path.join(CHATTR_DIR, 'hooks', 'worktree-session-start.mjs');
