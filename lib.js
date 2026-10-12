'use strict';
/**
 * agentviz: shared state for coding agents working on one repository in parallel (PLAN.md convention).
 *
 * Agents keep editing PLAN.md as the convention says ([~] + by:, [x], [!]). The Claude Code hooks (agentviz/hook.js)
 * turn every status change and every file an agent writes into an event in a file of its own:
 *
 *   <git common dir>/agentviz/sessions/<session>.jsonl   one file per agent session, append-only
 *   <git common dir>/agentviz/locks/<name>.json          shared resources (deployments)
 *
 * The git common dir is the same for the main checkout and every `git worktree` of the clone, so parallel sessions in
 * different worktrees see each other; nothing here is committed. Because each session only appends to its own file,
 * no session can overwrite another's state. `reduce()` folds all events into one view: a task's status is the latest
 * status event, and a claim ([~]) is a lease — it holds while its session shows activity and ends with the session.
 * `applyStatuses()` writes that view back into PLAN.md, changing only checkbox characters and `by:` lines.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LEASE_MS = Number(process.env.AGENTVIZ_LEASE_MINUTES || 30) * 60e3;
const SESSION_FILES_MAX_AGE_MS = 7 * 24 * 3600e3;
const STATUS_CHAR = { pending: ' ', done: 'x', active: '~', blocked: '!' };
const CHAR_STATUS = { ' ': 'pending', x: 'done', X: 'done', '~': 'active', '!': 'blocked' };

// ---------- repository and state directory ----------

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** { root, stateDir } for a working directory inside the repository (a worktree counts), or null outside git. */
function locate(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) || path.join(root, '.git');
  return { root: path.resolve(root), stateDir: path.join(path.resolve(common), 'agentviz') };
}

const agentLabel = (sessionId, agent = 'claude') => `${agent}#${String(sessionId || 'manual').replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'anon'}`;

// ---------- PLAN.md ----------

const NODE_RE = /^##\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i;
const TASK_RE = /^(\s*[-*]\s+\[)( |x|X|~|!)(\]\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*)$/;
const FILES_RE = /^files:\s*\[([^\]]*)\]\s*$/i;
const SUB_RE = /^\s+(tech|by|from|horizon|check):\s*(.*)$/i;

/** Components (id, title, files) and tasks (id, component, status, tech, by, line index) of a PLAN.md text. */
function parsePlan(text) {
  const lines = text.split('\n');
  const components = [];
  const tasks = [];
  let comp = null;
  let task = null;
  let inDecisions = false;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (/^##\s+decisions\s*$/i.test(line)) { inDecisions = true; comp = null; task = null; return; }
    let m;
    if ((m = line.match(NODE_RE))) { inDecisions = false; comp = { id: m[2], title: m[1], files: [] }; components.push(comp); task = null; return; }
    if (inDecisions) return;
    if ((m = line.match(TASK_RE))) { task = { id: m[5], title: m[4], component: comp?.id || null, status: CHAR_STATUS[m[2]], line: i, tech: '', by: '', check: '' }; tasks.push(task); return; }
    if ((m = line.match(FILES_RE))) { if (comp) comp.files = m[1].split(',').map(s => s.trim()).filter(Boolean); return; }
    if (task && (m = line.match(SUB_RE))) { const k = m[1].toLowerCase(); if (k in task) task[k] = m[2].trim(); return; }
    if (line.trim() && !/^\s/.test(line)) task = null;
  });
  return { components, tasks };
}

function globToRe(g) {
  if (!/[*?]/.test(g)) return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '(/|$)');
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp('^' + esc + '$');
}

/** Component ids whose `files:` globs cover a repository-relative path (forward slashes). */
function componentsOf(plan, rel) {
  return plan.components.filter(c => c.files.some(g => globToRe(g).test(rel))).map(c => c.id);
}

/** Repository-relative path with forward slashes, or null when the file lies outside the repository. */
function relPath(root, file) {
  if (!file) return null;
  const abs = path.resolve(root, String(file));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Writes statuses into a PLAN.md text: `statuses` maps task id -> { status, by? }. Only the checkbox character and,
 * for an active claim, the task's `by:` line change; every other line stays as the owner wrote it.
 */
function applyStatuses(text, statuses) {
  const lines = text.split('\n');
  const plan = parsePlan(text);
  // bottom-up so inserted lines do not shift the indices still to be visited
  for (const t of [...plan.tasks].sort((a, b) => b.line - a.line)) {
    const want = statuses[t.id];
    if (!want) continue;
    const m = lines[t.line].match(TASK_RE);
    if (!m) continue;
    const ch = STATUS_CHAR[want.status];
    if (ch !== undefined && CHAR_STATUS[m[2]] !== want.status) lines[t.line] = m[1] + ch + m[3];
    if (want.status === 'active' && want.by) {
      let j = t.line + 1;
      let byAt = -1;
      while (j < lines.length && SUB_RE.test(lines[j])) { if (/^\s+by:/i.test(lines[j])) byAt = j; j++; }
      const indent = (lines[t.line].match(/^\s*/)[0]) + '  ';
      if (byAt >= 0) { if (!lines[byAt].includes(want.by)) lines[byAt] = `${indent}by: ${want.by}`; }
      else lines.splice(j, 0, `${indent}by: ${want.by}`);
    }
  }
  return lines.join('\n');
}

// ---------- events ----------

function sessionFile(stateDir, session) { return path.join(stateDir, 'sessions', `${String(session).replace(/[^a-z0-9_-]/gi, '_')}.jsonl`); }

function append(stateDir, event) {
  const file = sessionFile(stateDir, event.session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...event }) + '\n');
}

function readEvents(stateDir, now = Date.now()) {
  const dir = path.join(stateDir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      if (now - fs.statSync(file).mtimeMs > SESSION_FILES_MAX_AGE_MS) continue;
      for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
    } catch { /* removed meanwhile */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Folds the events into the current picture:
 *   sessions  id -> { agent, lastAt, ended, alive, files: Map(rel -> at), components: Set }
 *   statuses  task id -> { status, by, session, at }   (an expired or ended claim falls back to its `prev` status)
 *   claims    live claims: [{ task, by, session, at }]
 *   released  claims that ended without the task being finished: [{ task, by, session, reason }]
 */
function reduce(events, now = Date.now()) {
  const sessions = {};
  const last = {};
  for (const e of events) {
    const s = sessions[e.session] || (sessions[e.session] = { id: e.session, agent: e.agent, lastAt: 0, ended: false, transcript: null, files: new Map(), components: new Set(), planned: new Set() });
    s.lastAt = Math.max(s.lastAt, e.at);
    if (e.agent) s.agent = e.agent;
    if (e.transcript) s.transcript = e.transcript;
    if (e.type === 'end') s.ended = true;
    else if (e.type === 'start') s.ended = false;
    if (e.type === 'touch' && e.file) { s.files.set(e.file, e.at); for (const c of e.components || []) s.components.add(c); }
    if (e.type === 'status' && e.task) { last[e.task] = e; if (e.component) s.planned.add(e.component); }
  }
  for (const s of Object.values(sessions)) s.alive = !s.ended && now - s.lastAt < LEASE_MS;
  const statuses = {};
  const claims = [];
  const released = [];
  for (const [task, e] of Object.entries(last)) {
    if (e.status === 'active') {
      const s = sessions[e.session];
      if (s?.alive) { statuses[task] = { status: 'active', by: e.agent, session: e.session, at: e.at }; claims.push({ task, by: e.agent, session: e.session, at: e.at, component: e.component || null }); }
      else {
        statuses[task] = { status: e.prev && e.prev !== 'active' ? e.prev : 'pending', session: e.session, at: e.at };
        released.push({ task, by: e.agent, session: e.session, reason: s?.ended ? 'session ended' : `no activity for ${Math.round(LEASE_MS / 60e3)} minutes` });
      }
    } else statuses[task] = { status: e.status, by: e.agent, session: e.session, at: e.at };
  }
  return { sessions, statuses, claims, released };
}

// ---------- locks ----------

function lockFile(stateDir, name) { return path.join(stateDir, 'locks', `${name.replace(/[^a-z0-9_-]/gi, '_')}.json`); }

function readLock(stateDir, name) {
  try { return JSON.parse(fs.readFileSync(lockFile(stateDir, name), 'utf8')); } catch { return null; }
}

/** Takes a named lock for a session. Returns { ok, holder } — holder is the other live owner when ok is false. */
function acquireLock(stateDir, name, { session, agent, ttlMs = 45 * 60e3, note = '' }, now = Date.now()) {
  const file = lockFile(stateDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const held = readLock(stateDir, name);
  if (held && held.session !== session && held.expiresAt > now) return { ok: false, holder: held };
  const lock = { name, session, agent, at: now, expiresAt: now + ttlMs, note };
  // exclusive create when free; a stale or own lock is replaced
  try {
    if (!held) fs.writeFileSync(file, JSON.stringify(lock), { flag: 'wx' });
    else fs.writeFileSync(file, JSON.stringify(lock));
  } catch (e) {
    if (e.code === 'EEXIST') { const other = readLock(stateDir, name); if (other && other.session !== session) return { ok: false, holder: other }; }
    else throw e;
  }
  return { ok: true, holder: lock };
}

function releaseLock(stateDir, name, session) {
  const held = readLock(stateDir, name);
  if (held && held.session === session) { try { fs.unlinkSync(lockFile(stateDir, name)); } catch { /* gone */ } return true; }
  return false;
}

function locksOf(stateDir) {
  const dir = path.join(stateDir, 'locks');
  try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

// ---------- sync ----------

/** Brings PLAN.md in `root` in line with the shared events. Returns true when the file changed. */
function syncPlan(root, stateDir, now = Date.now()) {
  const planPath = path.join(root, 'PLAN.md');
  let text;
  try { text = fs.readFileSync(planPath, 'utf8'); } catch { return false; }
  const { statuses } = reduce(readEvents(stateDir, now), now);
  if (!Object.keys(statuses).length) return false;
  const next = applyStatuses(text, statuses);
  if (next === text) return false;
  fs.writeFileSync(planPath, next);
  return true;
}

module.exports = {
  LEASE_MS, locate, agentLabel, parsePlan, globToRe, componentsOf, relPath, applyStatuses,
  append, readEvents, reduce, acquireLock, releaseLock, readLock, locksOf, syncPlan,
};
