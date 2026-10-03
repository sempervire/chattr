<p align="center"><img src="docs/logo.svg" alt="chattr" width="360"></p>

# chattr

A durable message channel between independent **Claude Code** and **Codex CLI** sessions on one Mac.
Sessions enroll automatically through CLI hooks, see who else is working in the same repository,
send each other messages and consults, claim work so two sessions never take the same task, and
wake an idle peer when a message arrives. One SQLite file, no dependencies, no server.

It also installs two guard hooks that block edits when another live session is working in the
same checkout, so parallel agents stay in separate git worktrees.

## Requirements

- macOS (the wake path uses iTerm2 and the Claude Code / Codex local sockets and queues)
- Node.js 26 or later (`node:sqlite`)
- Claude Code and/or the Codex CLI

## Install

chattr is a plugin for both CLIs, listed in the [Winston](https://github.com/sempervire/winston) marketplace.

Claude Code:

```text
/plugin marketplace add sempervire/winston
/plugin install chattr@winston
```

Codex:

```sh
codex plugin marketplace add sempervire/winston
codex plugin add chattr@winston
```

Then, for Codex, review and trust the plugin's hooks with `/hooks` in a fresh session, and let a
sandboxed Codex write the message store by adding it to `~/.codex/config.toml`:

```toml
[sandbox_workspace_write]
writable_roots = ["/Users/<you>/.agent-bridge"]
```

Restart every Claude and Codex session afterwards so they load the hooks. One `hooks/hooks.json`
serves both CLIs: the hook reads which CLI called it from the payload. Claude Code puts the
plugin's `bin/chattr` on PATH; Codex does not, so each session is told the CLI's absolute path at
start (or link `chattr.mjs` into a PATH directory yourself).

Development, from a checkout: `claude --plugin-dir ~/chattr` loads the plugin for one session;
`claude plugin validate ~/chattr` checks it.

**Moving from the old installer.** Earlier versions wrote chattr's hooks into
`~/.claude/settings.json` and `~/.codex/hooks.json` by absolute path (`install.sh`). With the
plugin installed those would run twice, so remove them:

```sh
chattr uninstall-hooks --dry-run                       # prints the exact diff, writes nothing
chattr uninstall-hooks --snapshot ~/chattr-hooks-backup
```

It removes only hooks that run `chattr.mjs hook` (or the older `agentbus.mjs hook`),
`worktree-guard.mjs` or `worktree-session-start.mjs`; every other hook stays.

`install.sh` remains for running chattr without the plugin system (and for `npm run e2e`):
`--dry-run` prints the diff, a real run needs `--snapshot <dir>`, `--trust` records Codex hook
trust. It also creates `~/.agent-bridge`, adds the Codex writable root, and links
`~/.local/bin/chattr`.

## Peer rules

Sessions follow [`docs/AGENT-RULES.md`](docs/AGENT-RULES.md) (claims, consults, broadcasts,
authorization); every SessionStart points the session at the installed copy. Wake mechanics are
in [`docs/WAKE.md`](docs/WAKE.md).

## Quick start

In any session (the hooks have already enrolled it):

```sh
chattr who --repo --text                 # live sessions in this repository
chattr send <session-id> "rebased main, re-run your tests"
chattr consult kind:codex "does this migration look safe?"
chattr claim issue:42 "taking the login bug"
chattr state --text                      # peers, broadcasts, unacked messages, claims
```

Messages reach the recipient at its next turn boundary; an idle recipient is woken.

## Uninstall

1. Plugin: `/plugin uninstall chattr@winston` (Claude) or `codex plugin remove chattr@winston` (Codex).
   Old installer: `chattr uninstall-hooks --snapshot <dir>`, then `rm ~/.local/bin/chattr`.
2. `rm -rf ~/.agent-bridge` to drop the message store.

## How it works

Store: `~/.agent-bridge/bridge.db` (override `CHATTR_DB`). Identity: `CHATTR_SESSION`
(Claude, set via `CLAUDE_ENV_FILE`), else `CODEX_THREAD_ID` (Codex exports it to every command).
The contract, JSON schemas and proofs are in `SPEC.md`.

**Sandbox:** Codex `workspace-write` cannot write `~/.agent-bridge` by default, which is why it
must be in `writable_roots` (see Install); with that, a WAL write from inside Codex succeeds. Inside
the sandbox `ps` is denied and `kill -0` works.

## Command reference (`--json` default, `--text` for humans)

| Command | Does |
|---|---|
| `join --kind K [--session ID] [--source startup\|resume\|compact] [--pid --tty --surface --wake-endpoint --cwd]` | enroll; new incarnation unless `compact` |
| `leave` | mark self `gone` |
| `who [--repo] [--all] [--coverage [--cwd P \| --under P]]` | sessions with computed status; coverage = live root `claude`/`codex` processes, informational enrollment counts, and `unenrolled` roots with no matching live session; `complete` requires no unenrolled roots; `--cwd` scopes to exactly P, `--under` to P and below (unreadable cwd still counts) |
| `status <uuid\|session>` | per-recipient delivery states and least-advanced summary, or one session |
| `send <to> <body>` · `consult <to> <body>` | `<to>` = session id or `kind:<kind>` |
| `broadcast <body>` | every other live session in the same repo |
| `reply --to <consult> [--status answered\|interrupted\|unknown] <body>` | answers and acks a consult |
| `claim <resource> [note…]` · `release <resource> [note…]` | atomically take or free `<kind>:<name>` (`issue:115`, `resource:preview-db`) and announce it; first claim wins, a conflict returns the owner |
| `inbox [--after <uuid>] [--limit N]` | unacked messages for self, in send order |
| `ack <uuid…>` | ack deliveries; repeats are no-ops |
| `expire <uuid>` · `supersede <old> <new>` | sender withdraws or replaces a message |
| `state` | self, same-repo peers, last 10 live broadcasts, unacked, every active claim in the repo |
| `hook <event> [--agent <kind>]` · `wake <session>` | composed CLI hook (`hook/`; the CLI is read from the payload unless `--agent` names it); wake an idle session (`wake.mjs`) |
| `uninstall-hooks [--dry-run \| --snapshot <dir>] [--home <dir>]` | remove the old installer's chattr hook registrations |

A body of `-` is read from stdin. Delivery into a session's context happens only at turn
boundaries (`start`, `prompt`, `stop`) through the hook; `turn()` and `markContinued()` are
exported for it.

## States

- Session: `working | idle | blocked | error | gone | unknown` (`unknown` = pid alive, last seen > 10 min ago).
- Delivery: `queued | injected | acked | stale | expired | superseded`; a consult also reports
  `answered | interrupted | unknown` once replied. A delivery re-injected past 3 attempts is `stale`.

## Exit codes

`0` ok · `2` usage · `3` not enrolled · `4` unknown recipient, message, consult or claim, resource claimed, or not permitted.

## Wake facts (Codex 0.154, verified 2026-09-15)

- `codex queue --thread <uuid> --message <text>` writes `~/.codex/queue_1.sqlite` `queued_items`;
  the live TUI consumes the row within ~5 s and runs it as a turn. Exit 0 is not delivery; the
  row vanishing is.
- Never queue by name: `--thread <name>` fails and queues nothing. Names live only in
  `~/.codex/state_5.sqlite` `threads.name`; `/status` prints `Session: <uuid>`.
- A prompt arriving mid-turn does not open a new turn; it steers the running one. Wake only idle sessions.
- Rollout bracket per turn: `task_started{turn_id}` … `task_complete` or `turn_aborted{reason:"interrupted"}`.
  The newest rollout is not an identity (subagents and the apps write there too).
- iTerm `write text` pastes without submitting; a second empty `write text` submits.
- Wakes carry `chattr inbox`, never a message body.

## Tests

`npm test` (temp `CHATTR_DB` per test) · `npm run lint` · `npm run e2e` (live Claude and Codex sessions in a temp HOME).

## Hooks

The plugin registers `hooks/hooks.json`; `install.sh` writes the same hooks by absolute path. Per-CLI
code lives only in `hook/adapters/`. Stop composes, in order: delivery → status → notify (BEL), at most 2 delivery
continues since the last human prompt. The hook also wakes idle recipients of the session's queued
directed messages, because a sandboxed Codex sender cannot reach `codex queue` or a Claude socket
itself. A broadcast is passive: it wakes nobody and never continues a Stop on its own.

## License

MIT
