'use strict';
/**
 * What the board can do, besides showing: the owner marks a task in progress or releases it, and starts an agent on a
 * task. Every action goes through the same shared state the hooks write, so agents see it at once.
 *
 *   claim    the owner takes a task: an event of the session `human:<name>` (a claim that never expires; an agent may
 *            take it over) and [~] with `by: <name>` in PLAN.md
 *   release  the owner's claim ends, the task falls back to its previous status
 *   start    writes the task's brief to <git common dir>/agentviz/briefs/, then opens a terminal running
 *            `claude -n "<name>" --session-id <uuid> [-w <worktree>] "<read the brief>"`; the session id is known before the
 *            session starts, so the board shows the agent as starting and links it to its task at once
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const lib = require('./lib');

const human = name => `human:${String(name || 'owner').replace(/[^a-z0-9._-]/gi, '_').slice(0, 40) || 'owner'}`;

function ownerName(root) {
  const r = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return (r.status === 0 && r.stdout.trim()) || require('os').userInfo().username || 'owner';
}

function planOf(root) {
  try { return lib.parsePlan(fs.readFileSync(path.join(root, 'PLAN.md'), 'utf8')); } catch { return { components: [], tasks: [] }; }
}

function claim(loc, taskId, now = Date.now()) {
  const t = planOf(loc.root).tasks.find(x => x.id === taskId);
  if (!t) return { ok: false, error: `#${taskId} is not in PLAN.md` };
  if (t.status === 'done') return { ok: false, error: `#${taskId} is done` };
  const view = lib.reduce(lib.readEvents(loc.stateDir, now), now);
  const held = view.claims.find(c => c.task === taskId);
  if (held) return { ok: false, error: `#${taskId} is already held by ${held.by}` };
  const name = ownerName(loc.root);
  lib.append(loc.stateDir, { at: now, session: human(name), agent: name, human: true, type: 'status', task: t.id, component: t.component, status: 'active', prev: t.status === 'active' ? 'pending' : t.status });
  lib.syncPlan(loc.root, loc.stateDir, now);
  return { ok: true, by: name };
}

function release(loc, taskId, now = Date.now()) {
  const view = lib.reduce(lib.readEvents(loc.stateDir, now), now);
  const held = view.claims.find(c => c.task === taskId);
  if (!held) return { ok: false, error: `#${taskId} is not claimed` };
  if (!String(held.session).startsWith('human:')) return { ok: false, error: `#${taskId} is held by the agent ${held.by}; it releases its own claims` };
  const prev = lib.readEvents(loc.stateDir, now).filter(e => e.type === 'status' && e.task === taskId && e.status === 'active' && e.session === held.session).pop()?.prev || 'pending';
  lib.append(loc.stateDir, { at: now, session: held.session, agent: held.by, human: true, type: 'status', task: taskId, component: held.component, status: prev, prev: 'active', reason: 'released by the owner' });
  lib.syncPlan(loc.root, loc.stateDir, now);
  return { ok: true };
}

/** A command line for a shell: arguments quoted for PowerShell (Windows) or a POSIX shell. */
function commandLine(args, win) {
  const q = a => win ? `'${String(a).replace(/'/g, "''")}'` : `'${String(a).replace(/'/g, `'\\''`)}'`;
  return ['claude', ...args.map(q)].join(' ');
}

/** Opens a terminal window running the command in `cwd`. Returns true when a terminal was started. */
function openTerminal(cwd, line, title) {
  try {
    let p;
    if (process.platform === 'win32') {
      const ps = `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${line}`;
      p = spawn('cmd.exe', ['/c', 'start', `"${title.replace(/"/g, '')}"`, 'powershell.exe', '-NoExit', '-Command', `"${ps.replace(/"/g, '\\"')}"`], { cwd, detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: false });
    } else if (process.platform === 'darwin') {
      const sh = `cd '${cwd.replace(/'/g, `'\\''`)}' && ${line}`;
      p = spawn('osascript', ['-e', `tell application "Terminal" to do script "${sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' });
    } else {
      p = spawn('x-terminal-emulator', ['-e', 'bash', '-lc', `${line}; exec bash`], { cwd, detached: true, stdio: 'ignore' });
    }
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

function start(loc, taskId, { brief, worktree = false, launch = true } = {}, now = Date.now()) {
  const t = planOf(loc.root).tasks.find(x => x.id === taskId);
  if (!t) return { ok: false, error: `#${taskId} is not in PLAN.md` };
  if (t.status === 'done') return { ok: false, error: `#${taskId} is done` };
  const view = lib.reduce(lib.readEvents(loc.stateDir, now), now);
  const held = view.claims.find(c => c.task === taskId);
  if (held && !String(held.session).startsWith('human:')) return { ok: false, error: `#${taskId} is already held by ${held.by}` };
  const session = crypto.randomUUID();
  const dir = path.join(loc.stateDir, 'briefs');
  fs.mkdirSync(dir, { recursive: true });
  const briefPath = path.join(dir, `${t.id}-${session.slice(0, 8)}.md`);
  fs.writeFileSync(briefPath, String(brief || `Take task #${t.id} in PLAN.md: "${t.title}". Mark it [~] before you start and [x] with evidence when done.`) + '\n');
  const name = `#${t.id} ${t.title}`.replace(/["%^&|<>`]/g, '').slice(0, 60);   // safe inside cmd, PowerShell and sh quotes
  const prompt = `Your task brief is in ${briefPath.split(path.sep).join('/')} . Read it and follow it: claim task #${t.id} in PLAN.md first.`;
  const args = ['-n', name, '--session-id', session, ...(worktree ? ['-w', `agentviz-${t.id}`.slice(0, 40)] : []), prompt];
  const win = process.platform === 'win32';
  const line = commandLine(args, win);
  const launched = launch ? openTerminal(loc.root, line, `AgentViz ${name}`) : false;
  fs.appendFileSync(path.join(loc.stateDir, 'launches.jsonl'), JSON.stringify({ at: now, session, task: t.id, name, worktree: !!worktree, launched }) + '\n');
  return { ok: true, session, launched, command: `cd "${loc.root}"\n${line}`, brief: briefPath };
}

/** Launches of the last ten minutes whose session has not shown up yet. */
function pendingLaunches(stateDir, knownSessions, now = Date.now()) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(stateDir, 'launches.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const l of lines.slice(-50)) { try { const j = JSON.parse(l); if (now - j.at < 10 * 60e3 && !knownSessions.has(j.session)) out.push(j); } catch { /* torn */ } }
  return out;
}

module.exports = { claim, release, start, pendingLaunches, ownerName, commandLine, openTerminal, human };
