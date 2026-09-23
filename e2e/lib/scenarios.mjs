// Discovers and validates `../scenarios/*.e2e.mjs`. A scenario's default
// export is `{ name, needs?, run? }`. `needs` names the blocking issue (e.g.
// "composed hooks") for a scenario that cannot run yet -- `run.mjs` reports it as
// SKIP without executing anything. A scenario with no `needs` MUST have a
// `run()`: this loader throws rather than let a scenario silently do nothing
// and still count as passing ("don't fake these").

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCENARIOS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

export async function discoverScenarios() {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.e2e.mjs'))
    .sort();
  const scenarios = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(SCENARIOS_DIR, file)).href);
    const scenario = mod.default;
    if (!scenario?.name) throw new Error(`${file}: default export must have a "name"`);
    if (!scenario.needs && typeof scenario.run !== 'function') {
      throw new Error(`${file}: "${scenario.name}" has no "needs" and no run() -- a live scenario must actually run`);
    }
    scenarios.push({ ...scenario, file });
  }
  return scenarios;
}
