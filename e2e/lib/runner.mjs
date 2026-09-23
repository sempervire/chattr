// Runs scenarios sequentially with exactly one retry each. A scenario that fails and then
// passes is FLAKY: reported with its first failure, but it does not fail the run. Only a scenario
// that fails twice fails the run, so one flake at cutover (`--mode installed`) never forces a rollback.
//
// Every attempt has a hard timeout: past it the attempt's live CLI sessions are killed and
// the attempt fails as a TIMEOUT naming the scenario. With `logDir`, each scenario gets one log file
// holding every attempt's result, error and the full output of each CLI session it started.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SCENARIO_TIMEOUT_MS = 240_000;
const errText = (error) => String(error?.stack || error);

export class ScenarioTimeout extends Error {
  constructor(scenario, ms) {
    super(`TIMEOUT: scenario "${scenario.name}" (${scenario.file ?? 'no file'}) did not finish within ${Math.round(ms / 1000)}s; its CLI sessions were killed`);
    this.name = 'ScenarioTimeout';
  }
}

/** Runs one attempt under a hard timeout. On timeout, kills the attempt's sessions and rejects. */
async function attemptWithTimeout(scenario, context, ms, killSessions) {
  let timer;
  const running = Promise.resolve().then(() => scenario.run({ sandbox: context }));
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new ScenarioTimeout(scenario, ms)), ms); });
  try {
    return await Promise.race([running, timeout]);
  } catch (error) {
    if (error instanceof ScenarioTimeout) {
      running.catch(() => {}); // the abandoned attempt fails once its sessions die; that is expected
      await killSessions();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function logName(scenario, index) {
  const base = (scenario.file ?? scenario.name).replace(/\.e2e\.mjs$/, '').replace(/[^\w.-]+/g, '-');
  return `${String(index + 1).padStart(2, '0')}-${base}.log`;
}

function sessionSection(s) {
  return `--- ${s.cli} ${JSON.stringify(s.args)} (started ${new Date(s.at).toISOString()}, exit ${s.exitCode ?? 'none'})\n${s.buffer || '(no output)'}\n`;
}

/**
 * Returns {failed, counts: {pass, flaky, timeout, fail, skip}}. `out`/`err` are injectable for tests.
 * `killSessions()` kills the CLI sessions started so far; `takeSessions()` removes and returns them
 * (lib/isolation.mjs). `timeoutMs` is the per-attempt default; a scenario may set its own.
 */
export async function runScenarioList(scenarios, context, {
  out = console.log, err = console.error, logDir, timeoutMs = DEFAULT_SCENARIO_TIMEOUT_MS,
  killSessions = async () => {}, takeSessions = () => [],
} = {}) {
  const counts = { pass: 0, flaky: 0, timeout: 0, fail: 0, skip: 0 };
  if (logDir) mkdirSync(logDir, { recursive: true });
  for (const [index, scenario] of scenarios.entries()) {
    const log = [`scenario: ${scenario.name}\nfile: ${scenario.file ?? '-'}\n`];
    const flush = () => { if (logDir) writeFileSync(path.join(logDir, logName(scenario, index)), `${log.join('\n')}\n`); };
    if (scenario.needs) {
      out(`SKIP  ${scenario.name} (needs ${scenario.needs})`);
      counts.skip++;
      log.push(`SKIP (needs ${scenario.needs})`);
      flush();
      continue;
    }
    const limit = scenario.timeoutMs ?? timeoutMs;
    let first;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const startedAt = Date.now();
      log.push(`== attempt ${attempt} started ${new Date(startedAt).toISOString()} (timeout ${Math.round(limit / 1000)}s)`);
      flush();
      let error;
      try {
        await attemptWithTimeout(scenario, context, limit, killSessions);
      } catch (caught) {
        error = caught ?? new Error('scenario rejected with no error');
      }
      await killSessions(); // a scenario that left a session running must not leak it into the next one
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log.push(`== attempt ${attempt}: ${error ? (error instanceof ScenarioTimeout ? 'TIMEOUT' : 'FAIL') : 'ok'} after ${seconds}s`);
      if (error) log.push(errText(error));
      for (const s of takeSessions()) log.push(sessionSection(s));
      flush();
      if (!error) {
        if (first === undefined) {
          out(`ok    ${scenario.name}`);
          counts.pass++;
        } else {
          out(`FLAKY ${scenario.name} (failed once, passed on retry)`);
          err(`first failure of ${scenario.name}:\n${errText(first)}`);
          counts.flaky++;
        }
        break;
      }
      if (attempt === 1) {
        first = error;
        out(`RETRY ${scenario.name}${error instanceof ScenarioTimeout ? ` (${error.message})` : ''}`);
        continue;
      }
      if (error instanceof ScenarioTimeout) {
        out(`TIMEOUT ${scenario.name} (${scenario.file ?? '-'}): no attempt finished within ${Math.round(limit / 1000)}s`);
        counts.timeout++;
      } else {
        out(`FAIL  ${scenario.name}`);
        counts.fail++;
      }
      err(`first failure:\n${errText(first)}\nsecond failure:\n${errText(error)}`);
    }
  }
  out(`summary: ${counts.pass} pass, ${counts.flaky} flaky, ${counts.timeout} timeout, ${counts.fail} fail, ${counts.skip} skip`);
  return { failed: counts.fail + counts.timeout > 0, counts };
}
