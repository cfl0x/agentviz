#!/usr/bin/env node
'use strict';
/**
 * agentviz - see what your coding agents actually do: the plan convention for parallel agents, as one command for any git repository.
 *
 *   agentviz setup    the one step: copies agentviz into <repo>/.agentviz (committed with the repository, so the whole
 *                      team has it), runs init from there and opens the board           [--no-board] [--port n]
 *                      npx -y github:cfl0x/agentviz setup
 *   agentviz update   to the newest GitHub release, or a named one       [version] [--check] [--dry-run]
 *   agentviz uninstall  takes it out of the repository again (PLAN.md stays)  [--dry-run]
 *   agentviz init     writes the convention into CLAUDE.md and AGENTS.md, a PLAN.md skeleton when none exists, the
 *                      Claude Code hooks into .claude/settings.json and the npm scripts into package.json (when present)
 *   agentviz board    the live view (agentviz/board.js)         [--port n] [--open] [--tests]
 *   agentviz check    the evidence and claims check (check.js)      [--write] [--tests] [--json]
 *   agentviz advise   does this plan qualify for multi-agent work? verdict, number of agents, lanes (advise.js)   [--json]
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
- CLAIM BEFORE YOU EDIT: the hook refuses to write a file of a component until you hold a \`[~]\` task of that component. Mark the task \`[~]\`, add \`by:\`, save PLAN.md, then edit. If no task fits, add one under that component first
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
/**
 * agentviz uninstall [--dry-run]: takes agentviz out of this repository, the reverse of setup / init:
 *   .claude/settings.json   the agentviz hooks (other hooks stay; empty groups and events go)
 *   CLAUDE.md, AGENTS.md    the two sections init added (a file that held nothing else goes)
 *   package.json            the plan:* scripts that call agentviz
 *   .agentviz/              the copy setup made
 *   <git common dir>/agentviz/   the shared state: events, claims, locks, briefs
 * PLAN.md stays: it is the owner's plan, not agentviz's. A global install is removed with npm uninstall -g agentviz.
 */
function uninstall() {
  const lib = require('./lib');
  const loc = lib.locate(process.cwd());
  if (!loc) { console.error('agentviz uninstall: run it inside a git repository'); process.exit(2); }
  const dry = process.argv.includes('--dry-run');
  const root = loc.root;
  const out = [];
  const write = (file, text, what) => { out.push(what); if (!dry) fs.writeFileSync(file, text); };
  const remove = (p, what) => { if (!fs.existsSync(p)) return; out.push(what); if (!dry) fs.rmSync(p, { recursive: true, force: true }); };

  const settingsPath = path.join(root, '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    let n = 0;
    const ours = isOurHook;
    for (const [ev, groups] of Object.entries(settings.hooks || {})) {
      const kept = (groups || []).map(g => { const hs = (g.hooks || []).filter(x => !(ours(x) && ++n)); return { ...g, hooks: hs }; }).filter(g => g.hooks.length);
      if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
    }
    if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
    if (n) write(settingsPath, JSON.stringify(settings, null, 2) + '\n', `.claude/settings.json: ${n} agentviz hook${n === 1 ? '' : 's'} removed`);
  } catch { /* no settings */ }

  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(root, f);
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    // a section runs from its heading to the next heading of the same or a higher level
    const cut = (t, heading) => { const i = t.indexOf(heading); if (i < 0) return t; const rest = t.slice(i + heading.length); const j = rest.search(/\n#{1,2} /); return t.slice(0, i).replace(/\s*$/, '\n') + (j < 0 ? '' : rest.slice(j + 1)); };
    const next = cut(cut(text, '## agentviz plan convention'), '## Working in parallel (this repository)');
    if (next === text) continue;
    if (!next.trim()) remove(p, `${f}: removed (it held only the agentviz convention)`);
    else write(p, next.replace(/\n{3,}/g, '\n\n'), `${f}: the agentviz convention removed`);
  }

  const pkgPath = path.join(root, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const gone = Object.keys(pkg.scripts || {}).filter(k => /^plan:/.test(k) && /agentviz/.test(pkg.scripts[k]));
    for (const k of gone) delete pkg.scripts[k];
    if (gone.length) write(pkgPath, JSON.stringify(pkg, null, 2) + '\n', `package.json: scripts ${gone.join(', ')} removed`);
  } catch { /* no package.json */ }

  remove(path.join(root, '.agentviz'), '.agentviz/: the copy removed');
  remove(loc.stateDir, `${path.relative(root, loc.stateDir).split(path.sep).join('/') || loc.stateDir}: the shared agent state removed`);

  console.log((out.length ? out.join('\n') : 'nothing to remove: agentviz is not installed here') + (dry ? '\n(dry run: nothing changed)' : ''));
  console.log('PLAN.md stays: it is your plan.' + (path.resolve(__dirname).toLowerCase().startsWith(path.join(root, '.agentviz').toLowerCase()) ? '' : ' To remove a global install as well: npm uninstall -g agentviz'));
}

/**
 * agentviz update [version] [--check] [--dry-run]: brings this repository's copy (or the global install) to the newest
 * release on GitHub, or to the version named. A copy in <repo>/.agentviz is replaced by running that release's setup;
 * a global install is reinstalled from GitHub and then runs init here. --check only says whether a newer release
 * exists; --dry-run prints the commands instead of running them.
 */
async function update() {
  const { spawnSync } = require('child_process');
  const pkg = require('./package.json');
  const slug = (pkg.repository?.url || '').match(/github\.com[/:](.+?)(?:\.git)?$/)?.[1] || 'cfl0x/agentviz';
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run'), checkOnly = args.includes('--check');
  let want = args.find(a => !a.startsWith('--'));
  if (!want) {
    try {
      const r = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentviz' } });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      want = (await r.json()).tag_name;
    } catch (e) { console.error(`agentviz update: could not ask GitHub for the newest release (${e.message}). Name the version: agentviz update 1.1.0`); process.exit(1); }
  }
  const tag = want.startsWith('v') ? want : `v${want}`;
  const newer = (a, b) => { const p = s => s.replace(/^v/, '').split('.').map(Number); const [x, y] = [p(a), p(b)]; for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  console.log(`agentviz ${pkg.version} here; ${args.find(a => !a.startsWith('--')) ? 'asked for' : 'newest release'} ${tag}`);
  if (checkOnly) { console.log(newer(tag, pkg.version) ? `An update is available: agentviz update` : 'Up to date.'); return; }
  if (!newer(tag, pkg.version) && !args.find(a => !a.startsWith('--'))) { console.log('Up to date.'); return; }
  const lib = require('./lib');
  const loc = lib.locate(process.cwd());
  const vendored = loc && path.resolve(__dirname).toLowerCase() === path.join(loc.root, '.agentviz').toLowerCase();
  const steps = vendored || !loc
    ? [['npx', ['-y', `github:${slug}#${tag}`, 'setup', '--no-board']]]
    : [['npm', ['install', '-g', `github:${slug}#${tag}`]], ['agentviz', ['init']]];
  if (!loc && !vendored) steps.splice(0, steps.length, ['npm', ['install', '-g', `github:${slug}#${tag}`]]);
  for (const [cmd, a] of steps) {
    console.log(`> ${cmd} ${a.join(' ')}`);
    if (dry) continue;
    const r = spawnSync(cmd, a, { cwd: process.cwd(), stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status) { console.error(`agentviz update: ${cmd} failed`); process.exit(r.status || 1); }
  }
  if (!dry) console.log(vendored ? `\n.agentviz/ is now ${tag}. Commit it, so the team gets it too; restart a running board.` : `\nagentviz is now ${tag}; restart a running board.`);
}

/** An agentviz hook entry in settings.json: its command names agentviz and hook.js (another tool's `cf-route-hook.js` is not one). */
const isOurHook = x => /agentviz/i.test(x.command || '') && /hook\.js/.test(x.command || '');

/** JSON text as the file had it: indent 2, and the line ending `before` used (LF when there was no file). */
function jsonLike(obj, before) {
  const eol = /\r\n/.test(before || '') ? '\r\n' : '\n';
  return JSON.stringify(obj, null, 2).replace(/\n/g, eol) + eol;
}

/**
 * Adds entries to the "scripts" object of package.json text without reformatting the rest of the file: a one-line change
 * in the user's diff instead of the whole file. Null when the block is not a plain multi-line object (the caller then
 * falls back to rewriting the JSON).
 */
function addScriptsText(text, add) {
  const m = /"scripts"\s*:\s*\{/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  let i = start, depth = 1, inStr = false;
  for (; i < text.length && depth; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  if (depth) return null;
  const close = i - 1;
  const body = text.slice(start, close);
  const indent = /\r?\n([ \t]+)"/.exec(body)?.[1];
  if (!indent) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const closingIndent = /([ \t]*)$/.exec(body)[1];
  const entries = Object.entries(add).map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',' + eol);
  const out = text.slice(0, start) + body.replace(/\s+$/, '') + ',' + eol + entries + eol + closingIndent + text.slice(close);
  try { const s = JSON.parse(out).scripts; if (Object.keys(add).every(k => s && s[k] === add[k])) return out; } catch { /* fall through */ }
  return null;
}

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
    // the hooks run .agentviz/hook.js: a clone has them only when the folder is committed, otherwise it runs setup once
    const ignored = spawnSync('git', ['check-ignore', '-q', dest], { cwd: loc.root }).status === 0;
    console.log(`.agentviz/: agentviz ${pkg.version} copied into the repository (${ignored ? 'it is gitignored here: every clone runs `agentviz setup` once for the hooks to work' : 'commit it, so every clone has the hooks'})`);
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
  let settings = {}, settingsText = '';
  try { settingsText = fs.readFileSync(settingsPath, 'utf8'); settings = JSON.parse(settingsText); } catch { /* new */ }
  const settingsBefore = JSON.stringify(settings);
  settings.hooks = settings.hooks || {};
  const entry = { type: 'command', command: hookCmd, timeout: 15 };
  // only agentviz's own hook counts: another tool's hook that happens to be called hook.js (cf-route-hook.js) must not hide it
  const has = arr => (arr || []).some(h => (h.hooks || []).some(isOurHook));
  // an update repoints hooks an earlier install left at another copy (an old folder, the npx cache, a global install)
  let repointed = 0;
  for (const arr of Object.values(settings.hooks)) for (const h of arr || []) for (const x of h.hooks || []) {
    if (/agentviz/i.test(x.command || '') && /hook\.js/.test(x.command || '') && x.command !== hookCmd) { x.command = hookCmd; repointed++; }
  }
  if (repointed) out.push(`.claude/settings.json: ${repointed} hook${repointed === 1 ? '' : 's'} moved to ${hookCmd}`);
  for (const ev of ['PreToolUse', 'PostToolUse']) if (!has(settings.hooks[ev])) (settings.hooks[ev] = settings.hooks[ev] || []).push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [entry] });
  // SubagentStart / SubagentStop make each subagent an agent of its own (start and end, claims released at the end)
  for (const ev of ['SessionStart', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop']) if (!has(settings.hooks[ev])) (settings.hooks[ev] = settings.hooks[ev] || []).push({ hooks: [entry] });
  if (JSON.stringify(settings) !== settingsBefore || !settingsText) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, jsonLike(settings, settingsText));
    out.push(`.claude/settings.json: hooks -> ${hookCmd}`);
  }
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkgText = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgText);
    const bin = inside ? `node ${rel}/cli.js` : 'agentviz';
    const missing = {};
    for (const [k, v] of Object.entries({ 'plan:board': `${bin} board`, 'plan:check': `${bin} check`, 'plan:check:tests': `${bin} check --tests` })) if (!(pkg.scripts || {})[k]) missing[k] = v;
    if (Object.keys(missing).length) {
      // add the lines in place so the user's diff is three lines, not the whole file; rewrite the JSON only as a fallback
      let next = addScriptsText(pkgText, missing);
      if (next === null) { pkg.scripts = { ...(pkg.scripts || {}), ...missing }; next = jsonLike(pkg, pkgText); }
      fs.writeFileSync(pkgPath, next);
      out.push('package.json: scripts plan:board, plan:check, plan:check:tests');
    }
  }
  console.log(out.length ? out.join('\n') : 'nothing to do: already initialised');
  const board = fs.existsSync(pkgPath) ? 'npm run plan:board' : inside ? `node ${rel}/cli.js board --open` : 'agentviz board --open';
  console.log(`\nNext: ask your agent to backfill PLAN.md from the code (every [x] must cite its evidence), then \`${board}\`.`);
}

switch (cmd) {
  case 'setup': setup(); break;
  case 'update': update(); break;
  case 'uninstall': uninstall(); break;
  case 'init': init(); break;
  case 'board': require('./board').start(); break;
  case 'check': require('./check').main(); break;
  case 'advise': require('./advise').main(); break;
  case 'hook': require('./hook'); break;
  case '--version': case '-v': console.log(require('./package.json').version); break;
  default:
    console.log([
      'usage: agentviz <setup|update|uninstall|init|board|check|advise|hook> [options]',
      '  setup      one step: copy agentviz into .agentviz/, install it and open the board   --no-board  --port n',
      '  update     to the newest release, or a named one (update 1.1.0)   --check  --dry-run',
      '  uninstall  take agentviz out of this repository (hooks, convention, scripts, .agentviz/, state); PLAN.md stays   --dry-run',
      '  init       install the convention, hooks and npm scripts into this repository',
      '  board      live view            --port n  --open  --tests',
      '  check      evidence and claims  --write  --tests  --json',
      '  advise     does this plan qualify for multi-agent work, and with how many agents?  --json',
    ].join('\n'));
    process.exit(cmd ? 1 : 0);
}
