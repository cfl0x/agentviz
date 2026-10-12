# agentviz

See what your coding agents actually do.

agentviz is for repositories where several AI coding agents (Claude Code sessions, also in separate git worktrees) work at the same time. It gives them one shared plan, keeps them out of each other's files, verifies what they claim to have finished, and shows all of it on one live board.

- **One plan.** `PLAN.md` holds 5–9 components of the system, the files each owns, the edges between them, and tasks whose status is backed by evidence. Agents maintain it; you read it.
- **Claims that mean something.** An agent's `[~]` is a claim every other session sees. It lasts while the session is active, ends with the session or after 30 minutes without activity, and the task then falls back. A second agent marking the same task is reverted and told who holds it.
- **No mixed edits.** Writing a file another live session changed within the lease is refused. A different file of a claimed component only warns. Deploy commands take one lock.
- **Ticks you can audit.** Every `[x]` names its evidence (files, line ranges, tests) on its `tech:` line; `agentviz check` verifies them and turns a tick whose evidence is gone into `[!]`. It only ever takes ticks away.
- **A board that shows facts.** The whole plan at a glance (done, in progress, blocked, planned, roadmap), components along their dependency edges, every task on a status board, the agents live in each component, uncommitted changes and the last commit per component, the state of every tick, and the conflicts derived from what agents really did: two agents in one file, two agents in one component, work without a claim, work outside every component, claims that fell back. Sessions are **active**, **open** (still up, not editing), **ended** or **gone** (their Claude Code transcript is missing or silent for a day).
- **How many agents to run.** The board counts the lanes that can take an agent now without stepping on another one, names the next task in each and hands you its brief.

No dependencies. Node 20 or newer, git, and Claude Code for the hooks (the check and the board work with any agent that maintains PLAN.md).

## Setup: one step

In the repository your agents work on:

```bash
npx -y github:cfl0x/agentviz setup
```

That is all. `setup`:

1. copies agentviz into `.agentviz/` in the repository. Commit it: every clone then has the hooks, and nothing depends on a global install or the npx cache,
2. writes the plan convention into `CLAUDE.md` and `AGENTS.md`, a `PLAN.md` skeleton when none exists, the Claude Code hooks into `.claude/settings.json` (pointing at `.agentviz/hook.js`), and `plan:board` / `plan:check` scripts into `package.json` (when present),
3. opens the board in the browser.

Then ask your agent to backfill `PLAN.md` from the code: every `[x]` must cite its evidence. Run `setup` again to update the copy. `--no-board` skips opening the board.

### Update

Run `setup` again in the repository, with the version you want, and commit `.agentviz/`:

```bash
npx -y github:cfl0x/agentviz#v1.0.2 setup      # a release: any tag from https://github.com/cfl0x/agentviz/releases
npx -y github:cfl0x/agentviz setup             # the newest state of the main branch
```

It replaces the copy in `.agentviz/`, adds hooks a newer version needs, and moves hooks an earlier install left at another place (an old `agentviz/` folder, the npx cache, a global install) to the copy. With a global install: `npm install -g github:cfl0x/agentviz#v1.0.2`, then `agentviz init` in each repository. `agentviz --version` (or `node .agentviz/cli.js --version`) says which version runs.

The package is not on the npm registry (the name `agentviz` there belongs to a different project), so install it from GitHub. A global install works as well: `npm install -g github:cfl0x/agentviz`, then `agentviz init` in a repository.

## Use

With the copy in `.agentviz/` call `node .agentviz/cli.js …` or the npm scripts; with a global install, `agentviz …`.

```bash
agentviz board            # http://localhost:5340 ; --open opens the browser, --port n, --tests also runs cited tests
agentviz check            # evidence behind every [x], live claims, released claims, unplanned changes, locks
agentviz check --write    # mark ticks whose evidence fails as [!] with a check: line (and restore them when it is back)
agentviz check --tests    # also run every test file the ticked tasks cite
```

`check` exits 1 when evidence fails, so it can run after a merge in CI.

## The board

- **Status at a glance.** One number (the share of tasks done), one bar across all tasks and a count per stage: done, in progress, blocked, planned and roadmap. *Current scope* leaves the roadmap out. Each stage filters the map and the status board.
- **Map and status board.** The map shows the components along their `needs:` (arrows) and `links:` (dashed) edges. A card shows only its title, state, progress and the agents in it; a click opens the component in a side panel: its tasks by stage, what it builds on, what uses it, what it is coupled to, the files it owns and its last change. Zoom with `+` / `-` (or Ctrl and the wheel), `0` or *Reset view* shows the whole plan, the minimap and dragging the canvas move the view. The status board (`b`, back to the map with `m`) shows every task in a column per stage, grouped by component.
- **Parallel agents.** Components own disjoint files, so each takes one agent. A component is a free lane when it has planned work, nobody is in it, nothing there is in conflict and every component it needs has started. A component that shares an edge with a busy or already suggested one is held back, because coupled components change the same surface. The panel names the next task per lane and copies its brief; when nothing is planned, it shows what pulling roadmap work in would allow.
- **From a task to the work.** A task opens a popover with its stage, the component and what it builds on, the agent holding it (one click shows only that agent's work), the files that agent changed there, the session with a ready `claude --resume` command, the commit that ticked it (linked on GitHub, GitLab or Bitbucket), its evidence as links into the editor and its line in `PLAN.md`. Open tasks carry a brief for an agent. `#task=<id>` links straight to a task.
- **From an agent to its tasks.** An agent's lane lists the tasks it holds and finished, its components and every file it changed; a file outside every component is marked *outside the plan*.
- **Subagents.** A subagent that a session starts (the Agent tool, parallel waves in worktrees) is an agent of its own, `claude#166b › a623`, nested under its session: its own claims, its own file guard, its own start and end (`SubagentStart` / `SubagentStop`). A session and its subagents never block each other; two sibling subagents do. A session working in a linked worktree without a subagent id is keyed by the worktree (`claude#166b › wt-<folder>`).

`AGENTVIZ_EDITOR` sets the editor the links open (`vscode`, the default; `cursor`, `vscode-insiders`, … or `none`).

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
- Tasks: `[ ]` open, `[~]` in progress (with `by:`), `[x]` done (with evidence on `tech:`), `[!]` stuck. `from: agent` or `from: roadmap` names where an open task came from; `from: roadmap` keeps it out of the current scope (the board shows it as *roadmap*, every other open task as *planned*).
- `{#id}`s never change. Plan-affecting decisions go under `## decisions` before the work.

The full text that `init` installs for agents is in [cli.js](cli.js).

## How it works

Every hook event (file written, PLAN.md changed, session start/stop) is appended to a file of its own session under the repository's git common directory (`.git/agentviz/sessions/<session>.jsonl`), so sessions in different worktrees see each other and none can overwrite another. Statuses are reduced from those events; a claim is a lease. `check` and the board read the same events, git and PLAN.md. Nothing is committed and nothing leaves the machine.

Environment: `AGENTVIZ_HOOK=off` disables the hooks for a session; `AGENTVIZ_LEASE_MINUTES` (30) sets the lease; `AGENTVIZ_ALLOW_SHARED_FILES=1` turns the same-file refusal into a warning; `AGENTVIZ_LOCK_COMMANDS` is a regular expression for the commands that take the deploy lock; `AGENTVIZ_PORT` sets the board's port; `AGENTVIZ_EDITOR` the editor its file links open.

## Development

```bash
npm test     # plays two sessions against each other in scratch repositories
```

MIT © 2026 Florian Farr
