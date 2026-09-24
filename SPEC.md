# chattr SPEC

The executable contract for chattr. The hooks, wake and e2e harness build to this file.
Deviations from the original design are marked **CHANGE**.

## 1. Store

- Path: `$CHATTR_DB`, else `~/.agent-bridge/bridge.db`. The directory is created on open.
- `node:sqlite` only. On open: `busy_timeout=5000`, `journal_mode=WAL`, `schema.sql` applied
  (idempotent `CREATE ... IF NOT EXISTS`). Every write runs in `BEGIN IMMEDIATE`.
- Times are integer epoch milliseconds. Ids: `messages.uuid` and `incarnation` are
  `crypto.randomUUID()`; `batches.id` is an autoincrement integer.
- Columns beyond the epic's sketch:
  - `messages.reply_status` (`answered | interrupted | unknown`, on the **consult** row).
  - `deliveries.stale_at` (set when `attempts` would exceed 3).
  - `sessions.joined_at`.
  - `sessions.pid_start` (`ps -o lstart=` text), `sessions.last_wake_at` (ms, written by
    Part 2's `wake`), `batches.continued` (0/1, written through `markContinued`).

## 2. Identity and bootstrap

- Caller identity: `CHATTR_SESSION`, else `CODEX_THREAD_ID`. Neither → exit 3.
- **Claude (proven, 2.1.274):** the `SessionStart` hook reads `session_id` from stdin and
  appends `export CHATTR_SESSION=<id>` to `$CLAUDE_ENV_FILE`; every Bash tool call in the
  session then sees it. Transcript A.
- **Codex (proven, 0.154.0) — CHANGE:** no hook and no `by-pid` marker. Codex exports
  `CODEX_THREAD_ID` (equal to `CODEX_SESSION_ID`, the thread uuid) into every shell
  command. The `by-pid` fallback is dropped: it cannot work, since `ps` is denied inside the
  Codex sandbox, so a parent-pid walk is impossible. Transcript B.
- Codex `SessionStart` hooks did not fire under `codex exec` with a temp `CODEX_HOME`
  (likely hook trust). Whether they fire in an interactive session is **pending for Part 0/2**;
  identity does not depend on it.
- `join` is the one command that accepts `--session <id>` (hooks know the id before the env
  is applied).

## 3. Sandbox — CHANGE

`~/.agent-bridge` is **not** writable from Codex `workspace-write` (the sandbox a trusted
project gets): `mkdir: Operation not permitted` (Transcript B). With
`sandbox_workspace_write.writable_roots = ["~/.agent-bridge"]` (absolute path) and the
directory pre-created, a WAL write succeeds (Transcript C). The DB path therefore stays
`~/.agent-bridge/bridge.db`, and **Part 2's `install.sh` must create `~/.agent-bridge` and
add it to `writable_roots` in `~/.codex/config.toml`.**

Also inside the Codex sandbox: `ps` is denied, `kill -0` works, `git rev-parse` works. So
pid liveness uses `process.kill(pid, 0)`; `pid_start` is compared only when `ps` is readable
on both sides (recorded at `join` by the unsandboxed hook). A sandboxed `who` cannot detect
pid reuse; an unsandboxed one can.

## 4. Repo identity

`repo = realpath(resolve(cwd, git -C cwd rev-parse --git-common-dir))`; `null` outside git.
All worktrees of one checkout share it.

## 5. Liveness (computed by `who`, `state`, fan-out)

1. stored `gone` → `gone`.
2. `pid` missing or `kill(pid,0)` fails with `ESRCH` → `gone` (persisted).
3. both stored and current `pid_start` readable and different → `gone` (persisted). `ps` runs
   with `TZ=UTC LC_ALL=C`, so readers in different zones or locales agree. A row joined
   before that pin holds local time and is compared as such; one that cannot be parsed is not
   evidence of pid reuse.
4. `now - last_seen > 10 min` → `unknown` (reported, not persisted).
5. else the stored status. Rows are never deleted.

"Live" = computed status is not `gone`.

## 6. Addressing

- `<session id>`: must exist in `sessions` (any status; a resume keeps the id) → else exit 4.
- `kind:<kind>`: every live session of that kind in the sender's repo, sender excluded. Zero → exit 4.
- `broadcast`: every live session in the sender's repo, sender excluded. Zero recipients is ok.
- Sender `repo` null with `kind:` or `broadcast` → exit 4 (`repo_required`).
- `reply --to <consult>`: recipient is the consult's sender; caller must hold a delivery of
  that consult, else exit 4. Default `--status answered`.
- `expire` / `supersede`: caller must be the sender of every message named, else exit 4.
  `supersede <old> <new>` sets `old.superseded_by = new`.

## 7. Delivery (library API, used by Part 2's hook)

`turn(db, sessionId, event)` for `event ∈ start|prompt|tool|stop|stop_failure|interrupt|blocked`:

- Sets `last_seen`, and status: `start|stop|interrupt → idle`, `prompt|tool → working`,
  `stop_failure → error`, `blocked → blocked`.
- `stop`: first acks every unacked delivery whose batch belongs to the current incarnation
  (all such batches are older than this event) and stamps those batches' `acked_at`.
- `stop` with only broadcasts pending injects nothing: a broadcast never continues a
  turn on its own. It rides with a directed message at `stop`, or arrives at the next `start|prompt`.
- `start|prompt|stop` then inject. Candidates: unacked, not stale, message not expired or
  superseded. A candidate already injected in the current incarnation is skipped. One whose
  last batch is from an earlier incarnation: `attempts >= 3` → `attempts=4, stale_at=now`,
  not injected; else `attempts+1`. Never-injected: `attempts=1`. Any injected → one `batches`
  row; deliveries get `batch`, `incarnation`, `last_injected_at`.
- Order: `messages.created_at`, then `uuid`. `created_at` is made strictly increasing across
  the store (`max(now, max(created_at)+1)` inside the insert transaction), so send order holds.
- `tool`: no batch; returns `notice` when an unacked, uninjected broadcast is pending.
- Returns `{status, batch: id|null, messages: [Message], acked: n, notice: string|null}`.

`markContinued(db, batchId)` sets `continued=1`. Continuation caps are Part 2's.

`join(db, {id, kind, source, pid, pidStart, tty, surface, cwd, wakeEndpoint})`: new row, or
update of `pid/pid_start/tty/surface/cwd/repo/wake_endpoint/last_seen`; `source=compact` on
an existing row keeps `incarnation`, anything else issues a new one; status `idle`.

## 7a. Claims

`claims(id, repo, resource, session_id, incarnation, note, claimed_at, released_at, release_reason)`,
with a unique index on `(repo, resource)` where `released_at IS NULL`: one active owner per resource.

- A resource is `<kind>:<name>`, lower-cased, matching `^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._/-]*$`
  (`issue:115`, `pr:108`, `resource:preview-db`); anything else exits 2. Claims are scoped to the
  caller's repo; a null repo exits 4 (`repo_required`).
- `claim(db, session, resource, note)`: one transaction inserts the row and a `broadcast` message
  `claim <resource>: <note>`; neither commits without the other. Held by another live session →
  exit 4 `claimed`, with that `claim` in the response. Held by the caller → `already: true`, no
  message, and the row's `incarnation` is refreshed (this is how a resumed owner re-claims).
- `release(db, session, resource, note)`: one transaction stamps `released_at`,
  `release_reason='released'` and a `broadcast` `release <resource>: <note>`. The caller's claim
  already released → `already: true`, no message. Another session's claim → exit 4 `not_owner`,
  untouched. No claim at all → exit 4 `unknown_claim`.
- A `session` whose `incarnation` is not the stored one may neither claim nor release (exit 4
  `stale_incarnation`). The CLI always passes the stored row; this guards library callers.
- A caller whose computed status is `gone` may not claim (exit 3 `session_gone`): the next read
  would reap the claim while the caller believed it held the work. It re-joins at its next hook event.
- A claim belongs to the repo it was made in, and follows its owner: `join` rewrites
  `sessions.repo`, so `state` also lists the caller's own claims from other repos, and `release`
  finds the caller's active claim by `(session_id, resource)` and announces it in the claim's repo.
  `release` checks the caller's own rows before another owner's, so a repeat release stays
  `already: true` after someone else takes the resource.
- The note is every argument after the resource, verbatim; only a trailing `--json`/`--text` is a flag.
- Reconciliation, on every claim read: an owner whose computed status is `gone` has its claim
  released with `release_reason='owner_gone'` and no message. `idle`, `unknown` and elapsed time
  never release. A claim whose `incarnation` differs from its live owner's is reported `stale: true`
  and still blocks others.
- A claim is a record, never authorization.

## 8. States

Per recipient, first match: `acked` (acked_at) · `stale` (stale_at) · `superseded` ·
`expired` (`expires_at <= now`) · `injected` (batch set) · `queued`.
Rank for the summary (least advanced wins): `queued < injected < stale < expired < superseded < acked`.
A consult with `reply_status` set reports that value (`answered | interrupted | unknown`)
as `summary`, keeping per-recipient rows.

## 9. CLI

`chattr <cmd> [--json|--text]`; default `--json`. Body = remaining args joined by space,
or stdin when the body is `-`. Every JSON response has `ok`. Errors print
`{"ok":false,"error":{"code","message"}}` to stdout.

| Command | Response (besides `ok:true`) |
|---|---|
| `join --kind K [--session ID] [--source startup\|resume\|compact] [--pid N] [--tty T] [--surface S] [--wake-endpoint JSON] [--cwd P]` | `session: Session` |
| `leave` | `session: Session` (status `gone`) |
| `who [--repo] [--all] [--coverage [--cwd P \| --under P]]` | `sessions: [Session]`; with `--coverage`: `coverage: {processes:{claude,codex}, enrolled:{claude,codex}, unenrolled:[{pid, kind, cwd}], complete: bool}`; `--cwd` counts only processes and sessions in directory P; `--under` counts those in P or below it (path-segment match on realpaths); either way a process whose cwd is unreadable still counts. `unenrolled` lists each counted root process whose pid matches no live session's `pid` (`cwd` null when unreadable). A countable session process is a root `claude` or `codex` process (no same-named parent). A codex process running as a host is not process-counted at all -- it hosts conversations rather than being one, so `processes`/`unenrolled` never include it. From a second scan scoped to the codex roots (`ps -ww -o pid=,args= -p <pids>`, skipped when there are none), with the executable stripped by its known path from the first scan (it may contain spaces), the subcommand is the first argument after the global options: `-c/--config`, `-p/--profile`, `-m/--model`, `-C/--cd`, `--enable`, `--disable`, `-s/--sandbox` and `-a/--ask-for-approval` take the next argument as their value, any other `-` argument (including `--flag=value`) is a flag, and a value ps split on spaces is consumed until its braces/brackets balance and double quotes pair. A host's subcommand is `app-server`, or `sandbox` followed by an option or `--` with a standalone `--` from there on (the `codex sandbox [OPTIONS] -- COMMAND...` form the ChatGPT app's tool sandboxes use). `enrolled` counts distinct live session pids per kind (`/clear` leaving two rows at one pid is one enrolled process), excluding codex sessions at a host's pid or at a non-root codex process (codex parent), so they cannot offset an unrelated unenrolled root. A root the args scan doesn't answer, or that isn't positively identified as a host (e.g. a prompt that starts with "sandbox"), still counts (fail closed); a root `ps` scan or args scan that fails or cannot be spawned makes `complete: false` (so does an args scan whose codex roots all exited in between). Accepted limitations: an unenrolled conversation hosted inside an app-server (e.g. the VS Code OpenAI extension or the ChatGPT app) is invisible to coverage -- only its own enrollment, never process presence, can surface it, and it never makes coverage incomplete. A codex process whose parent is a codex host is not a root either (hosts spawn helpers such as `codex exec` and `codex mcp-server`), so an interactive codex run inside a sandbox host is invisible the same way. `complete` compares counts, not identities. Host classification is a heuristic over space-joined argv: a `-c` value with a quoted brace or bracket, or a single-quoted value with spaces, can misparse; that makes the process count as a root (fail closed), never a hidden one, except in contrived argv that ends such a misparse exactly on an `app-server` or `sandbox … --` token. |
| `status <uuid>` | `message: Message, recipients: [{session_id, state, attempts, batch, acked_at}], summary` |
| `status <session>` | `session: Session` |
| `send <to> <body>` / `consult <to> <body>` / `broadcast <body>` | `message: Message, recipients: [session_id]` |
| `reply --to <uuid> [--status S] <body>` | `message: Message, recipients: [session_id]` |
| `claim <resource> [note…]` / `release <resource> [note…]` | `claim: Claim, already: bool, message: Message\|null, recipients: [session_id]`; on exit 4 `claimed`/`not_owner`: `error` plus the owner's `claim` |
| `inbox [--after <uuid>] [--limit N]` | `messages: [Message & {state}]` (unacked, not stale/expired/superseded; default limit 50) |
| `ack <uuid…>` | `acked: [uuid], already: [uuid], unknown: [uuid]` |
| `expire <uuid>` | `message: Message` |
| `supersede <old> <new>` | `message: Message` (the old one) |
| `state` | `session, peers: [Session], broadcasts: [Message] (≤10, newest first), unacked: [Message & {state}], claims: [Claim & {owner_status, stale, mine}]` (every active claim in the repo, oldest first; not bounded by the broadcast window) |
| `hook <event> --agent <kind>` | dispatched to `./hook/index.mjs` default export `(args) => exitCode` (Part 2) |
| `wake <session>` | dispatched to `./wake.mjs` default export `(args) => exitCode` (Part 2) |

`Session = {id, kind, incarnation, pid, pid_start, tty, surface, cwd, repo, status, last_seen, last_wake_at, wake_endpoint, joined_at}` (`status` is the computed one; `wake_endpoint` parsed JSON).
`Claim = {id, repo, resource, session_id, incarnation, note, claimed_at, released_at, release_reason}`.
`Message = {uuid, from_id, to_spec, repo, type, reply_to, body, created_at, expires_at, superseded_by, reply_status}`.

Exit codes: `0` ok · `2` usage · `3` not enrolled (no identity, or identity has no row, except `join`) · `4` unknown recipient / not permitted / resource claimed.

`--text` prints one `key: value` line per scalar field and one line per row, for humans.

## Appendix: proof transcripts (2026-09-16, `$P` = a scratch dir)

**A. Claude `CLAUDE_ENV_FILE`** — throwaway `--settings`, real settings untouched.

```
$ cat $P/settings.json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"$P/hook.sh"}]}]}}
$ cat $P/hook.sh   # reads stdin JSON, then:
[ -n "$CLAUDE_ENV_FILE" ] && echo "export CHATTR_SESSION=${sid}" >> "$CLAUDE_ENV_FILE"
$ claude --settings $P/settings.json -p 'Run exactly this bash command and reply with only its output: printf "CHATTR_SESSION=%s\n" "$CHATTR_SESSION"' --allowedTools Bash --output-format json --model haiku
session_id=16ba64d1-5b5c-4e9d-b507-7fae44bb7e02
result=CHATTR_SESSION=16ba64d1-5b5c-4e9d-b507-7fae44bb7e02
$ cat $P/hook.log
hook: CLAUDE_ENV_FILE=~/.claude-terminal/session-env/16ba64d1-…/sessionstart-hook-1.sh sid/source=16ba64d1-… startup
```

**B. Codex identity and default sandbox** — temp `CODEX_HOME` (copied `auth.json`, minimal config).

```
$ CODEX_HOME=$P/home codex exec -s workspace-write --skip-git-repo-check "Run \`sh $P/probe.sh\` …" </dev/null
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
session id: 01a0ad99-a61a-7a43-a5d0-cf098aecf2fd
CODEX_SANDBOX=seatbelt
CODEX_THREAD_ID=01a0ad99-a61a-7a43-a5d0-cf098aecf2fd
CODEX_SESSION_ID=01a0ad99-a61a-7a43-a5d0-cf098aecf2fd
probe.sh: line 3: /bin/ps: Operation not permitted
mkdir: /Users/me/.agent-bridge: Operation not permitted
WRITE_FAILED
$ cat $P/hook.log
cat: hook.log: No such file or directory      # SessionStart hook did not fire
```

**C. Codex with `~/.agent-bridge` as a writable root** (directory pre-created, probe removed after).

```
$ CODEX_HOME=$P/home codex exec -s workspace-write --skip-git-repo-check -c 'sandbox_workspace_write.writable_roots=["/Users/me/.agent-bridge"]' "Run \`sh $P/probe2.sh\` …" </dev/null
CODEX_THREAD_ID=01a0ad9f-bea4-7181-a4e5-cea29fe4ba07
kill0_ok
ps_denied
rows=1          # node:sqlite, WAL, busy_timeout=5000, ~/.agent-bridge/sandbox-probe.db
WRITE_OK
```
