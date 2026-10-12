# agentviz

See what your coding agents actually do.

agentviz is for repositories where several AI coding agents (Claude Code sessions, also in separate git worktrees) work at the same time. It gives them one shared plan, keeps them out of each other's files, verifies what they claim to have finished, and shows all of it on one live board.

- **One plan.** `PLAN.md` holds 5–9 components of the system, the files each owns, the edges between them, and tasks whose status is backed by evidence. Agents maintain it; you read it.
- **Claims that mean something.** An agent's `[~]` is a claim every other session sees. It lasts while the session is active, ends with the session or after 30 minutes without activity, and the task then falls back. A second agent marking the same task is reverted and told who holds it.
- **No mixed edits.** Writing a file another live session changed within the lease is refused. A different file of a claimed component only warns. Deploy commands take one lock.
- **Ticks you can audit.** Every `[x]` names its evidence (files, line ranges, tests) on its `tech:` line; `agentviz check` verifies them and turns a tick whose evidence is gone into `[!]`. It only ever takes ticks away.
- **A board that shows facts.** Components along their dependency edges with progress, the agents live in each, uncommitted changes and the last commit per component, the state of every tick, and the conflicts derived from what agents really did: two agents in one file, two agents in one component, work without a claim, claims that fell back. Sessions are **active**, **open** (still up, not editing), **ended** or **gone** (their Claude Code transcript is missing or silent for a day).

No dependencies. Node 20 or newer, git, and Claude Code for the hooks (the check and the board work with any agent that maintains PLAN.md).

## Install

```bash
npm install -g agentviz        # or run it from a clone: node <clone>/agentviz/cli.js …
cd your-repo
agentviz init
```

`init` writes the plan convention into `CLAUDE.md` and `AGENTS.md`, a `PLAN.md` skeleton when none exists, the Claude Code hooks into `.claude/settings.json`, and `plan:board` / `plan:check` scripts into `package.json` (when present). Then ask your agent to backfill `PLAN.md` from the code: every `[x]` must cite its evidence.

## Use

```bash
agentviz board            # http://localhost:5340 ; --open opens the browser, --port n, --tests also runs cited tests
agentviz check            # evidence behind every [x], live claims, released claims, unplanned changes, locks
agentviz check --write    # mark ticks whose evidence fails as [!] with a check: line (and restore them when it is back)
agentviz check --tests    # also run every test file the ticked tasks cite
```

`check` exits 1 when evidence fails, so it can run after a merge in CI.

## The plan convention

```markdown
# project

## Take in events {#ingest}
tech: webhook ingress, broker consumers
files: [src/ingest/**]
needs: [security]
links: [engine]
- [x] Accept signed webhooks {#ingest-webhook}
  tech: src/ingest/webhook.js:20-60, test/webhook.test.js
- [~] Consume the message broker {#ingest-broker}
  by: claude#a1b2
- [ ] Dead-letter failed messages {#ingest-dlq}
  from: roadmap

## decisions
- 2026-10-12: components cut by ownership, not by layer.
```

- `## Title {#id}` is a component: a part one agent can own for a session. Titles are verb-led and concrete; the engineer phrasing goes on `tech:`. Keep 5–9 components; split only when one agent could not own it any more.
- `files:` globs declare which paths the component owns — this is how edits are attributed. `needs:` are sequencing edges, `links:` coupling.
- Tasks: `[ ]` open, `[~]` in progress (with `by:`), `[x]` done (with evidence on `tech:`), `[!]` stuck. `from: agent` or `from: roadmap` names where an open task came from.
- `{#id}`s never change. Plan-affecting decisions go under `## decisions` before the work.

The full text that `init` installs for agents is in [cli.js](cli.js).

## How it works

Every hook event (file written, PLAN.md changed, session start/stop) is appended to a file of its own session under the repository's git common directory (`.git/agentviz/sessions/<session>.jsonl`), so sessions in different worktrees see each other and none can overwrite another. Statuses are reduced from those events; a claim is a lease. `check` and the board read the same events, git and PLAN.md. Nothing is committed and nothing leaves the machine.

Environment: `AGENTVIZ_HOOK=off` disables the hooks for a session; `AGENTVIZ_LEASE_MINUTES` (30) sets the lease; `AGENTVIZ_ALLOW_SHARED_FILES=1` turns the same-file refusal into a warning; `AGENTVIZ_LOCK_COMMANDS` is a regular expression for the commands that take the deploy lock; `AGENTVIZ_PORT` sets the board's port.

## Development

```bash
npm test     # plays two sessions against each other in scratch repositories
```

MIT © 2026 Florian Farr
