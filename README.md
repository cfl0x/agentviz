# agentviz

See what your coding agents actually do.

agentviz is for repositories where several AI coding agents (Claude Code sessions, also in separate git worktrees) work at the same time. It gives them one shared plan, keeps them out of each other's files, verifies what they claim to have finished, and shows all of it on one live board.

- **One plan.** `PLAN.md` holds 5–9 components of the system, the files each owns, the edges between them, and tasks whose status is backed by evidence. Agents maintain it; you read it.
- **Claims that mean something.** An agent's `[~]` is a claim every other session sees. It lasts while the session is active, ends with the session or after 30 minutes without activity, and the task then falls back. A second agent marking the same task is reverted and told who holds it.
- **Claim before you edit.** Writing a file of a component is refused until the agent (or its session) holds a `[~]` task of that component; the message names the open tasks and what to do. `PLAN.md` and files no component owns are never refused.
- **No mixed edits.** Writing a file another live session changed within the lease is refused. A different file of a claimed component only warns. Deploy commands take one lock.
- **Ticks you can audit.** Every `[x]` names its evidence (files, line ranges, tests) on its `tech:` line; `agentviz check` verifies them and turns a tick whose evidence is gone into `[!]`. It only ever takes ticks away.
- **A board that shows what happens.** Which agent does what right now (thinking, editing, running a command, waiting for you), on which task, branch and release; start an agent on a task or mark it in progress from the board.
- **A board that shows facts.** The whole plan at a glance (done, in progress, blocked, planned, roadmap), components along their dependency edges, every task on a status board, the agents live in each component, uncommitted changes and the last commit per component, the state of every tick, and the conflicts derived from what agents really did: two agents in one file, two agents in one component, work without a claim, work outside every component, claims that fell back. Sessions are **active**, **open** (still up, not editing), **ended** or **gone** (their Claude Code transcript is missing or silent for a day).
- **How many agents to run.** The board counts the lanes that can take an agent now without stepping on another one, names the next task in each and hands you its brief. `agentviz advise` turns that into a verdict: does this plan qualify for multi-agent work, and with how many agents?

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

In the repository:

```bash
node .agentviz/cli.js update          # or `agentviz update` with a global install; --check only looks
```

It asks GitHub for the newest release (or takes the one you name: `update 1.1.0`), replaces the copy in `.agentviz/` (or reinstalls the global one and runs `init` here), and says so. Commit `.agentviz/` afterwards and restart a running board. The same by hand: run `setup` again with the version you want:

```bash
npx -y github:cfl0x/agentviz#v1.0.3 setup      # a release: any tag from https://github.com/cfl0x/agentviz/releases
npx -y github:cfl0x/agentviz setup             # the newest state of the main branch
```

It replaces the copy in `.agentviz/`, adds hooks a newer version needs, and moves hooks an earlier install left at another place (an old `agentviz/` folder, the npx cache, a global install) to the copy. With a global install: `npm install -g github:cfl0x/agentviz#v1.0.3`, then `agentviz init` in each repository. `agentviz --version` (or `node .agentviz/cli.js --version`) says which version runs.

### Uninstall

```bash
node .agentviz/cli.js uninstall       # or `agentviz uninstall`; --dry-run lists what it would remove
```

It removes the agentviz hooks from `.claude/settings.json` (other hooks stay), the two sections `init` added to `CLAUDE.md` and `AGENTS.md`, the `plan:*` scripts, the copy in `.agentviz/` and the shared state under `.git/agentviz/`. `PLAN.md` stays: it is your plan. A global install goes with `npm uninstall -g agentviz`.

The package is not on the npm registry (the name `agentviz` there belongs to a different project), so install it from GitHub. A global install works as well: `npm install -g github:cfl0x/agentviz`, then `agentviz init` in a repository.

## Use

With the copy in `.agentviz/` call `node .agentviz/cli.js …` or the npm scripts; with a global install, `agentviz …`.

```bash
agentviz board            # http://localhost:5340 ; --open opens the browser, --port n, --tests also runs cited tests
agentviz check            # evidence behind every [x], live claims, released claims, unplanned changes, locks
agentviz check --write    # mark ticks whose evidence fails as [!] with a check: line (and restore them when it is back)
agentviz check --tests    # also run every test file the ticked tasks cite
agentviz advise           # does this plan qualify for multi-agent work? verdict, number of agents, lanes (--json for scripts)
```

`check` exits 1 when evidence fails, so it can run after a merge in CI.

### Does the plan qualify for multi-agent work?

`agentviz advise` answers from the same lane count as the board's *Parallel agents* panel:

| Verdict | Rule | Advice |
| --- | --- | --- |
| **multi-agent** | two or more free lanes and at least three planned tasks | one agent per free lane, at most six |
| **single-agent** | fewer than two free lanes, or fewer than three planned tasks | one agent; the output says what holds the other components back (waits, coupled, busy) |
| **not-ready** | no `PLAN.md`, no components, or only the skeleton | backfill the plan from the code first |

### Claim before you edit

The `PreToolUse` hook refuses to write a file of a component while the agent holds no `[~]` task of that component: mark the task `[~]`, add `by:`, save `PLAN.md`, then edit. A claim of a session covers its subagents. Finishing a task (`[x]`, `[!]`) ends the permission. `AGENTVIZ_REQUIRE_CLAIM=warn` only reminds after the edit, `off` disables the rule.

## The board

The board answers three questions, top to bottom: which repository and release is this, what does each agent do right now, and where does the plan stand.

- **Top bar.** The repository, the branch of the main checkout and the version in `package.json`. Conflicts between agents, ticks without evidence and a lost connection show as alerts below it.
- **Agents.** One group per Claude Code session, one card per agent that works: the session itself and each of its subagents. A card says what the agent does right now, read from the tail of its transcript: *Thinking*, *Editing* a file, *Running* a command, *Reading* or *Searching*, *Delegating* to subagents, or *Waits for you* (its turn is over, it asks a question, or a tool call waits for your approval). Below that, the tasks it works on: the claims it holds, or for a subagent the tasks its brief names. The group shows the agent's branch and version, how many subagents work and finished, and copies the `claude --resume` command. Ended sessions fold into one line.
- **Plan.** The share of tasks done, one bar across all tasks and a count per stage (ready, in progress, blocked, done, roadmap) that filters the view. The **board** shows the tasks in a column per stage; the **map** (`m`, back with `b`) shows the components along their `needs:` and `links:` edges, with zoom (`+` `-` `0`, Ctrl and the wheel), a minimap and dragging, and opens a component's tasks and details in a side panel.
- **Act on a task.** A ready task offers **Start agent** and **Mark in progress** where the pointer or the keyboard is.
  - *Start agent* opens a new terminal window running `claude -n "<task>" --session-id <id> "<read the brief>"` in the repository, optionally in its own git worktree (`-w`). The brief (the task, its component and files, what it builds on, the PLAN.md rules) is written to `.git/agentviz/briefs/`. The agent appears as *Starting* at once and takes its place when its session begins. *Copy the command instead* gives you the command to run yourself.
  - *Mark in progress* writes `[~]` and `by: <your git name>` into PLAN.md. Your claim does not expire; an agent that takes the task writes its own name on the `by:` line and takes the claim over. *Release* opens the task again.
  - The **Start an agent** button lists the ready tasks, recommended ones first: tasks in free components that no busy component is coupled to.
- **From a task to the work.** A task opens a popover with its stage, the component and what it builds on, who holds it and what that agent does, the files it changed there, the commit that ticked it (linked on GitHub, GitLab or Bitbucket), its evidence as links into the editor and its line in `PLAN.md`. `#task=<id>`, `#comp=<id>` and `#agent=<label>` link straight to a task, a component or an agent's work.
- **Subagents.** A subagent a session starts (the Agent tool, parallel lanes in worktrees) is an agent of its own, `claude#166b › a623`: its own claims, its own file guard, its own start and end (`SubagentStart` / `SubagentStop`, or the `finished` flag Claude Code writes next to its transcript). A session and its subagents never block each other; two sibling subagents do. A session working in a linked worktree it did not start in is keyed by the worktree (`claude#166b › wt-<folder>`).

The actions only answer the page the board served: a token in the page, a localhost `Host` header and a same-origin request. `AGENTVIZ_ACTIONS=off` turns them off. `AGENTVIZ_EDITOR` sets the editor the links open (`vscode`, the default; `cursor`, `vscode-insiders`, … or `none`).

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
- Tasks: `[ ]` open, `[~]` in progress (with `by:`; `[I]` works the same and is easier to type on keyboards without a `~` key), `[x]` done (with evidence on `tech:`), `[!]` stuck. `from: agent` or `from: roadmap` names where an open task came from; `from: roadmap` keeps it out of the current scope (the board shows it as *roadmap*, every other open task as *planned*).
- `{#id}`s never change. Plan-affecting decisions go under `## decisions` before the work.

The full text that `init` installs for agents is in [cli.js](cli.js).

## How it works

Every hook event (file written, PLAN.md changed, session start/stop) is appended to a file of its own session under the repository's git common directory (`.git/agentviz/sessions/<session>.jsonl`), so sessions in different worktrees see each other and none can overwrite another. Statuses are reduced from those events; a claim is a lease. `check` and the board read the same events, git and PLAN.md. Nothing is committed and nothing leaves the machine.

Environment: `AGENTVIZ_HOOK=off` disables the hooks for a session; `AGENTVIZ_REQUIRE_CLAIM` (`refuse`, `warn`, `off`) sets whether an edit without a claim is refused; `AGENTVIZ_LEASE_MINUTES` (30) sets the lease; `AGENTVIZ_ALLOW_SHARED_FILES=1` turns the same-file refusal into a warning; `AGENTVIZ_LOCK_COMMANDS` is a regular expression for the commands that take the deploy lock; `AGENTVIZ_PORT` sets the board's port; `AGENTVIZ_EDITOR` the editor its file links open.

## Development

```bash
npm test     # plays two sessions against each other in scratch repositories
```

MIT © 2026 Florian Farr
