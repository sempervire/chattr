#!/usr/bin/env node
// Syntax-checks every tracked .mjs/.js file; `node --check a b` would check only `a`.
import { execFileSync, spawnSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '*.mjs', '*.js'], { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`lint: syntax error in ${file}`);
    process.exit(1);
  }
}
console.log(`lint: ${files.length} files ok`);
