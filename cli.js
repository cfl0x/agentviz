#!/usr/bin/env node
'use strict';
/**
 * agentviz - see what your coding agents actually do: the plan convention for parallel agents, as one command for any git repository.
 *
 *   agentviz setup    the one step: copies agentviz into <repo>/.agentviz (committed with the repository, so the whole
 *                      team has it), runs init from there and opens the board           [--no-board] [--port n]
 *                      npx -y github:cfl0x/agentviz setup
 *   agentviz init     writes the convention into CLAUDE.md and AGENTS.md, a PLAN.md skeleton when none exists, the
 *                      Claude Code hooks into .claude/settings.json and the npm scripts into package.json (when present)
 *   agentviz board    the live view (agentviz/board.js)         [--port n] [--open] [--tests]
 *   agentviz check    the evidence and claims check (check.js)      [--write] [--tests] [--json]
 *   agentviz hook     the Claude Code hook entry point (hook.js); registered by init, not called by hand
 *
 * Everything depends only on PLAN.md and git, nothing on this repository, so the folder can be copied, installed
 * (`npm install -g <folder>`) or run with npx from a clone, and `init` points the hooks at wherever it lives.
 */
const fs = require('fs');
const path = require('path');

const [cmd, ...rest] = process.argv.slice(2);
process.argv = [process.argv[0], process.argv[1], ...rest];

const CONVENTION = `## agentviz plan convention
Maintain PLAN.md as the living plan. It is read by the project OWNER, not by you — write it for them.
- nodes are COMPONENTS of the system being built (\`## Plain-language name {#id}\`), not phases or sprints; keep the map at 5-9 components regardless of repo size — grow tasks, not cards, and split a component only when one agent could no longer own it for a session
- naming rule: titles are verb-led, plain-language, and CONCRETE — the owner can tell when it is done ("Read alerts out loud", "Watch the repo"). Never engineer-speak ("fs watcher + activity signal") and never vague vibes ("Decide what matters"); put the engineer phrasing on a \`tech:\` line under the heading
- tasks inside a component: \`- [ ] Plain outcome {#id}\`, optional indented \`tech:\` line beneath; mark a task \`[~]\` BEFORE you start it and save PLAN.md immediately — this drives the live in-progress view; flip it to \`[x]\` the moment it completes, \`[!]\` if stuck (clear once unblocked). Never batch plan updates for the end of the session
- when you mark a task \`[~]\`, add an indented \`by: <your name>\` line under it (claude, codex, cursor, …) and leave it there when done — it is the record of who did what
- edges under a component heading: \`needs: [id, id]\` = must come after those components; \`links: [id, id]\` = interconnected with / talks to
- \`files: [src/audio/**, config.py]\` under a component declares which paths it owns — keep it current; it is how the live view knows which component you are really working in, including when you revisit finished work
- \`{#id}\`s are stable — never rename, only add or remove nodes
- open tasks carry an indented \`from:\` line naming their provenance — \`from: agent\` when YOU are declaring it as your own imminent build intent (the owner corrects these on sight if wrong), \`from: roadmap\` when it comes from planning documents (durable intent, backloggable); omit when neither
- new work NEVER creates a component by default: it lands as your session todos plus tasks under the component whose files it touches. Add a NEW component only when the system grows a durable new part. Durable is not a prediction — test it NOW: something else already depends on it (load-bearing), deleting it would change what the product does, you can name a plausible second task for it, and it owns files no component claims. Record the addition under \`## decisions\`. Time corrects mistakes cheaply: merge a card back into its neighbor if no second change ever comes; promote a task to a card when work keeps clustering in files its siblings never touch. Remove a component only when that part is deleted from the product
- before ending a session, graduate your plan-worthy completed todos into PLAN.md as \`[x]\` tasks (with \`by:\`) — housekeeping todos stay out of the plan
- record any plan-affecting decision under \`## decisions\` BEFORE implementing it
- every \`[x]\` cites its evidence on the \`tech:\` line: the implementing files (with line ranges where useful) and the test files; \`agentviz check\` verifies them and turns a tick whose evidence is gone into \`[!]\`
`;
const PARALLEL = `
## Working in parallel (this repository)
Several agents may work here at once, also from separate \`git worktree\`s. The hooks in \`.claude/settings.json\` keep them apart; keep following the convention above, the hooks turn it into shared state.
- your \`[~]\` in PLAN.md is a claim other sessions see. It lasts while your session is active and ends with it (or after 30 minutes without activity), and the task then returns to its previous status — so mark \`[~]\` before you start and \`[x]\`/\`[!]\` when you finish, not later
- a task another agent holds is reverted to its claim if you mark it; the session-start message lists who holds what. Pick something else or ask the owner
- writing a file another live session changed in the last 30 minutes is refused: two agents' changes must not mix in one file. A different file of a claimed component only warns
- deploy commands (\`cf deploy\`, \`helm upgrade\`, \`kubectl apply\`, \`terraform apply\`, ...) take the deploy lock; a second deployment waits. Never work around the lock
- the check verifies the evidence behind every \`[x]\` (the files and line ranges on its \`tech:\` line). Cite real paths: a tick whose evidence disappears becomes \`[!]\` with a \`check:\` line, and returns when the evidence is back. Run it after a merge, before you report something as done
`;
const SKELETON = `# <project>

Map of the codebase. Components are parts one agent can own for a session; every [x] names its evidence on the tech: line.

## Set up the project {#setup}
tech: scaffolding
files: [**]
- [ ] Describe the first component {#setup-first}
  from: agent

## decisions
- ${new Date().toISOString().slice(0, 10)}: PLAN.md created by agentviz init; backfill it from the code before trusting any status.
`;

function upsertSection(file, marker, text) {
  let s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (s.includes(marker)) return false;
  fs.writeFileSync(file, (s ? s.replace(/\s*$/, '\n\n') : '') + text);
  return true;
}

/**
 * The one-step setup. A copy inside the repository keeps the hooks working: they point at
 * $CLAUDE_PROJECT_DIR/.agentviz/hook.js, which neither a cleaned npx cache nor a missing global install can break, and
 * every clone of the repository has it. Running setup again updates the copy.
 */
function setup() {
  const lib = require('./lib');
  const { spawnSync } = require('child_process');
  const loc = lib.locate(process.cwd());
  if (!loc) { console.error('agentviz setup: run it inside a git repository'); process.exit(2); }
  const here = path.resolve(__dirname);
  const dest = path.join(loc.root, '.agentviz');
  const pkg = require('./package.json');
  if (path.resolve(dest).toLowerCase() !== here.toLowerCase()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of [...new Set([...pkg.files, 'package.json'])]) fs.copyFileSync(path.join(here, f), path.join(dest, f));
    console.log(`.agentviz/: agentviz ${pkg.version} copied into the repository (commit it, so every clone has the hooks)`);
  }
  const cli = path.join(dest, 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'init'], { cwd: process.cwd(), stdio: 'inherit' });
  if (r.status) process.exit(r.status);
  if (process.argv.includes('--no-board')) return;
  const port = process.argv.includes('--port') ? ['--port', process.argv[process.argv.indexOf('--port') + 1]] : [];
  console.log('\nStarting the board (Ctrl+C stops it; start it again with `node .agentviz/cli.js board --open`).');
  spawnSync(process.execPath, [cli, 'board', '--open', ...port], { cwd: process.cwd(), stdio: 'inherit' });
}

function init() {
  const lib = require('./lib');
  const loc = lib.locate(process.cwd());
  if (!loc) { console.error('agentviz init: run it inside a git repository'); process.exit(2); }
  const root = loc.root;
  const here = path.resolve(__dirname);
  const rel = path.relative(root, here).split(path.sep).join('/');
  const inside = rel && !rel.startsWith('..');
  const hookCmd = inside ? `node "$CLAUDE_PROJECT_DIR/${rel}/hook.js"` : `node "${here.split(path.sep).join('/')}/hook.js"`;
  const out = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    if (upsertSection(path.join(root, f), '## agentviz plan convention', CONVENTION)) out.push(`${f}: convention added`);
    if (upsertSection(path.join(root, f), '## Working in parallel', PARALLEL)) out.push(`${f}: parallel rules added`);
  }
  const plan = path.join(root, 'PLAN.md');
  if (!fs.existsSync(plan)) { fs.writeFileSync(plan, SKELETON.replace('<project>', path.basename(root))); out.push('PLAN.md: skeleton written - backfill it from the code'); }
  const settingsPath = path.join(root, '.claude', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* new */ }
  settings.hooks = settings.hooks || {};
  const entry = { type: 'command', command: hookCmd, timeout: 15 };
  const has = arr => (arr || []).some(h => (h.hooks || []).some(x => /hook\.js/.test(x.command || '')));
  for (const ev of ['PreToolUse', 'PostToolUse']) if (!has(settings.hooks[ev])) (settings.hooks[ev] = settings.hooks[ev] || []).push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [entry] });
  for (const ev of ['SessionStart', 'Stop', 'SessionEnd']) if (!has(settings.hooks[ev])) (settings.hooks[ev] = settings.hooks[ev] || []).push({ hooks: [entry] });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  out.push(`.claude/settings.json: hooks -> ${hookCmd}`);
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.scripts = pkg.scripts || {};
    const bin = inside ? `node ${rel}/cli.js` : 'agentviz';
    let changed = false;
    for (const [k, v] of Object.entries({ 'plan:board': `${bin} board`, 'plan:check': `${bin} check`, 'plan:check:tests': `${bin} check --tests` })) if (!pkg.scripts[k]) { pkg.scripts[k] = v; changed = true; }
    if (changed) { fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n'); out.push('package.json: scripts plan:board, plan:check, plan:check:tests'); }
  }
  console.log(out.length ? out.join('\n') : 'nothing to do: already initialised');
  const board = fs.existsSync(pkgPath) ? 'npm run plan:board' : inside ? `node ${rel}/cli.js board --open` : 'agentviz board --open';
  console.log(`\nNext: ask your agent to backfill PLAN.md from the code (every [x] must cite its evidence), then \`${board}\`.`);
}

switch (cmd) {
  case 'setup': setup(); break;
  case 'init': init(); break;
  case 'board': require('./board').start(); break;
  case 'check': require('./check').main(); break;
  case 'hook': require('./hook'); break;
  case '--version': case '-v': console.log(require('./package.json').version); break;
  default:
    console.log('usage: agentviz <setup|init|board|check|hook> [options]\n  setup  one step: copy agentviz into .agentviz/, install it and open the board   --no-board  --port n\n  init   install the convention, hooks and npm scripts into this repository\n  board  live view            --port n  --open  --tests\n  check  evidence and claims  --write  --tests  --json');
    process.exit(cmd ? 1 : 0);
}
