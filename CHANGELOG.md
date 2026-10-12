# Changelog

## 1.0.2: Subagent detection fixed

**Subagents are agents of their own**
- Claude Code raises a subagent's hook events with its parent's session id plus an `agent_id`. AgentViz counted all of them as the parent session, so four parallel subagents showed as one agent, could not block each other, and the board could not say which of them worked or finished.
- An agent is now keyed by session and subagent and labelled `claude#166b › a623`. Each subagent has its own claims and file guard; a session and its own subagents never block each other, sibling subagents do. A session in a linked worktree without a subagent id is keyed by the worktree (`claude#166b › wt-<folder>`), and file paths count relative to their worktree.
- `SubagentStart` and `SubagentStop` are registered by `setup` / `init` and mark a subagent's start and end; its claims are released when it ends. `SessionEnd` ends the session's remaining subagents.
- The board nests subagents under their session (working and finished), counts a session whose subagents work through them, raises no conflict between a session and its own subagents, and offers the parent session's `claude --resume` command.

**Updating**
- `init` (and so `setup`) moves hooks an earlier install left at another copy, an old `agentviz/` folder, the npx cache or a global install, to the current copy. The README explains the update: run `setup` again with the version tag.

**A calmer, navigable map**
- Cards show only title, state, progress and the agents in them; a click opens the component in a side panel with its tasks by stage and its details (builds on, used by, coupled, files, last change). `#comp=<id>` links to it.
- Zoom controls (+, -, Reset view), Ctrl and the wheel, keys `+` `-` `0`, a minimap, and dragging the canvas to pan.
- More room between columns and rows, stronger edges and arrowheads, brighter secondary text.
- The sidebar sections (Parallel agents, Agents, Blocked, Conflicts, Uncommitted changes) are set apart as blocks with a coloured marker.
- Colours and type after the ASAPIO documentation (dark mode): navy surfaces, ASAPIO red for the brand mark and primary actions, blue links, emerald, amber and violet for the states, Inter and Fira Code. Fonts are not loaded from the web: the board stays local.

## 1.0.1

**One-step setup**
- `npx -y github:cfl0x/agentviz setup` copies agentviz into `.agentviz/` in the repository, installs the convention, the hooks and the npm scripts from there, and opens the board. The hooks no longer depend on a global install or the npx cache. Running it again updates the copy.

**The status of the whole plan**
- An overview strip: the share of tasks done, the current scope without the roadmap, one bar across all tasks and a count per stage (done, in progress, blocked, planned, roadmap) that filters the board.
- A status board next to the map: every task in a column per stage, grouped by component (keys `m` and `b`).
- Cards say what they mean: agent working, blocked, scope done, work planned, not started, roadmap only; their bars show planned and roadmap work apart.
- A *Blocked* section in the sidebar with the reason of each stuck task.
- `from: roadmap` is read from PLAN.md again. It was dropped by the parser, so roadmap tasks showed as plain open tasks.

**How many agents to run**
- A *Parallel agents* panel: the free lanes (one agent per component with planned work, nobody in it, no conflict, its needs started, no edge to a busy or suggested component), the next task in each with its brief, all briefs in one copy, and why the other components are held back. Without planned work it shows what pulling roadmap work in would allow.

**From tasks to agents, sessions and commits**
- The task popover links the holding agent, the files it changed in the component, its session with a `claude --resume` command, the commit that ticked the task (linked on GitHub, GitLab or Bitbucket), the evidence and the task's line in PLAN.md (opened in the editor, `AGENTVIZ_EDITOR`). Briefs name the components a task builds on. `#task=<id>` links to a task, `#agent=<label>` to an agent's work.
- Agent lanes link the tasks an agent holds and finished, its components and files.
- Work in files no component owns is a conflict (*outside the plan*) and is marked in the lanes and the changes.

**Board quality**
- Keyboard focus and the open popover survive live updates; the popover returns focus, keeps Tab inside, fits the window and follows its row.
- Cards are measured before layout, columns are ordered to cross fewer edges, the edges of a card light up on hover, and the map no longer shrinks below 75 %.
- When the connection drops, the board says how old its data is instead of a fresh-looking time.
- A clearer type scale, a legend for the edges, task titles on two lines with the full title on hover, changed tasks flash once, an empty plan explains what to do.

## 1.0.0

- The PLAN.md convention for parallel coding agents, Claude Code hooks that share claims and keep agents out of each other's files, the evidence check and the live board.
