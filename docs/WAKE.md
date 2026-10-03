# Wake paths

How `chattr wake <session>` reaches an idle session. A wake is always the text `chattr inbox`,
never a message body. Proven with Claude Code 2.1.274 and codex-cli 0.154.0 in hermetic runs
(temp `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, own ptys). Codex claims are labelled [probe]
(observed by the probe), [config], [doctor] or [inferred].

| Surface | Wake path | Result |
|---|---|---|
| Claude CLI in a terminal, idle | native inbox socket | **proven**: 2 wakes → 2 `UserPromptSubmit` `chattr inbox` |
| Claude from the phone (Remote Control) | same socket (same process) | **proven**: a socket wake showed as a new turn on the phone |
| Claude started by the desktop app | same socket | **proven**: app pids own `/tmp/cc-socks/<pid>.sock` |
| Codex CLI in a terminal, idle | `codex queue --thread <uuid>` | **proven**: row consumed in about 5 s, then `UserPromptSubmit` `chattr inbox` [probe] |
| Codex desktop app session | `codex queue` (shared `queue_1.sqlite`) | **proven**: the app thread ran the `chattr inbox` turn [probe] |
| Codex CLI thread in the desktop app | n/a (visibility) | **not available**: `source=cli` threads are not listed in the app |
| Codex CLI thread from the phone | `codex remote-control` | **not available** with API-key auth: remote control requires ChatGPT authentication [probe] |
| Typing into the terminal (last resort) | — | not used: native paths exist on every tty surface |

## Native Claude inbox

- Every Claude process (terminal and desktop app) listens on `/tmp/cc-socks/<pid>.sock` and
  exports it to hooks and tools as `CLAUDE_CODE_MESSAGING_SOCKET` (seen in the `SessionStart` hook).
- Frame: one JSON line `{"type":"user","message":{"content":"chattr inbox"},"priority":"next","from":"chattr-<8 hex>","msg_id":"<uuid>"}`.
  No auth on macOS (auth is required only on Windows).
- **`from` must vary per wake.** An identical message from the same sender is dropped
  ("Dropped a peer message from chattr: identical to the previous message"); a fixed `from`
  with a fresh `msg_id` is still dropped.
- Claude shows it as "Another Claude session sent a message" with a no-escalation preamble.
  Idle: starts a turn at once. Working: queued, runs after the turn.

## Codex

- `codex queue` is accepted when the row leaves `queued_items`; the TUI then runs it as a turn.
- `SessionStart` (`source=startup`) **fires only with the first prompt**: the thread is
  created lazily, and a TUI left idle after launch fires nothing and has no thread [probe].
  Hooks get `session_id` in the payload; `CODEX_THREAD_ID` is not set in the hook env [probe].
  So a Codex session enrolls at its first prompt, not at launch.

## `wake_endpoint` shapes (`sessions.wake_endpoint`)

- Claude, any surface: `{"kind":"uds","path":"/tmp/cc-socks/<pid>.sock"}` from `$CLAUDE_CODE_MESSAGING_SOCKET`.
- Codex TUI / desktop app: `{"kind":"codex-queue","thread":"<uuid>"}` (never by name).
- Remote-only or unknown: `{"kind":"pull"}` (drained at the next turn boundary).
