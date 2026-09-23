// Falsifier: "message to idle (native wake)" (the scenario list) --
// a message sent to a REAL, genuinely idle Claude session must reach it via
// the native inbox socket wake (agent-policy/WAKE.md), not by us driving a
// second human turn: `chattr wake <session>` must make the LIVE process
// spontaneously start a turn on its own and drain the message, ending idle
// again.
//
// The idle session is `claude --print --input-format stream-json
// --output-format stream-json`, not `--bg`: it is a single resident process
// with no separate "backgrounding supervisor", so its `sessions.pid` (set by
// `agentPid()`'s ancestor walk) matches the pid embedded in its own
// `CLAUDE_CODE_MESSAGING_SOCKET` -- proven while building this harness. A
// `claude --bg` session now records its socket-owning worker's pid via
// `sessionPid()` in `chattr/hook/index.mjs`, so the same check passes there.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawnClaudeStream } from '../lib/isolation.mjs';
import { chattr, joinSynthetic, leaveSynthetic, waitForMessageState, waitForSessionStatus } from '../lib/cli.mjs';

export default {
  name: 'message to idle: a native wake drains a queued message without a second human turn',
  async run({ sandbox }) {
    const workDir = path.join(sandbox.root, 'wake-idle-peer');
    mkdirSync(workDir, { recursive: true });
    const sessionId = randomUUID();
    const session = spawnClaudeStream(sandbox, { cwd: workDir, extraArgs: ['--session-id', sessionId] });

    try {
      session.send('Reply with exactly: READY');
      // Wait for the turn to genuinely START before waiting for it to go idle --
      // otherwise the poll can catch the session's pre-turn `idle` (set by
      // `join()` itself, before UserPromptSubmit even fires) and race straight
      // into the wake call while the real first turn is still starting.
      const started = await waitForSessionStatus(sandbox, sessionId, (s) => s.status === 'working', { timeoutMs: 10000 });
      // waitForSessionStatus returns the last row seen even on timeout: assert the status itself.
      assert.equal(started?.status, 'working', `session never entered its first turn (last status ${started?.status}): ${session.buffer}`);
      const idle = await waitForSessionStatus(sandbox, sessionId, (s) => s.status === 'idle', { timeoutMs: 20000 });
      assert.equal(idle?.status, 'idle', `session never went idle after its first turn (last status ${idle?.status}): ${session.buffer}`);
      assert.equal(idle.wake_endpoint?.kind, 'uds', `expected a native uds wake_endpoint, got ${JSON.stringify(idle.wake_endpoint)}`);
      const socketPid = Number(path.basename(idle.wake_endpoint.path, '.sock'));
      assert.equal(socketPid, idle.pid, "sessions.pid must match the socket's own pid for a resident (non --bg) session");

      joinSynthetic(sandbox, 'idle-sender', { cwd: workDir });
      try {
        const sent = chattr(sandbox, ['send', sessionId, 'wake up and say HELLO_BACK'], { CHATTR_SESSION: 'idle-sender' });
        const uuid = sent.message.uuid;

        const beforeWake = chattr(sandbox, ['status', uuid]);
        assert.equal(beforeWake.recipients[0].state, 'queued', 'a message to an idle session must wait for the wake, not be injected on its own');

        const woke = chattr(sandbox, ['wake', sessionId]);
        assert.equal(woke.woke, true, `native wake did not succeed: ${JSON.stringify(woke)}`);
        assert.equal(woke.via, 'uds');

        const delivered = await waitForMessageState(sandbox, uuid, (r) => r.state === 'acked', { timeoutMs: 20000 });
        assert.equal(delivered?.state, 'acked', `wake did not drain the message into a real turn: ${JSON.stringify(delivered)}\n${session.buffer}`);

        const idleAgain = await waitForSessionStatus(sandbox, sessionId, (s) => s.status === 'idle', { timeoutMs: 10000 });
        assert.equal(idleAgain?.status, 'idle', 'session did not return to idle after the woken turn finished');
      } finally {
        leaveSynthetic(sandbox, 'idle-sender');
      }
    } finally {
      await session.kill();
    }
  },
};
