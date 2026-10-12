#!/usr/bin/env node
'use strict';
/**
 * The plan board: one live view of PLAN.md and of the agents working on it (npm run plan:board).
 *
 * A view only. It reads what already exists and writes nothing:
 *   PLAN.md                       components, edges, tasks (agentviz/lib.js parser)
 *   <git common dir>/agentviz/    the hook events (which session touched which file, holds which claim) and locks
 *   git                           uncommitted changes and the last commit per component
 *   agentviz/check.js         evidence behind every [x] (paths and line ranges; tests only with --tests)
 *
 * From those it derives what agenttrail could not: conflicts. Two live sessions in one file, two live sessions in one
 * component, a claim on a task whose component another session holds, files changed without a claimed task. File
 * activity comes from the hooks (attributed to a session) and from the working tree (uncommitted changes, attributed to
 * nobody); a file counts as changed only when its modification time moved, never because something read it.
 *
 *   node agentviz/board.js [--port 5340] [--open] [--tests]
 *
 * GET /            the page (agentviz/board.html)
 * GET /api/state   the state as JSON
 * GET /events      server-sent events: a `state` event on every change, a `ping` every 15 s
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const check = require('./check');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(opt('--port', process.env.AGENTVIZ_PORT || 5340));
const RUN_TESTS = flag('--tests');
const ACTIVITY_WINDOW_MS = 24 * 3600e3;

// ---------- git ----------

function git(root, a) {
  const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return r.status === 0 ? r.stdout : '';
}

/** Uncommitted changes of the working tree: [{ file, status }] (status: M, A, D, ?, R…). */
function workingTree(root) {
  return git(root, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).map(l => {
    const status = l.slice(0, 2).trim() || 'M';
    let file = l.slice(3).trim();
    if (file.includes(' -> ')) file = file.split(' -> ').pop();
    return { file: file.replace(/^"|"$/g, ''), status };
  });
}

/** Last commit touching the files of a component: { hash, subject, at } or null. */
function lastCommitFor(root, files) {
  if (!files.length) return null;
  const globs = files.map(g => g.replace(/\*\*$/, '').replace(/\*/g, ''));
  const out = git(root, ['log', '-1', '--format=%h%x1f%s%x1f%ct', '--', ...globs]).trim();
  if (!out) return null;
  const [hash, subject, ct] = out.split('\x1f');
  return { hash, subject, at: Number(ct) * 1000 };
}

/**
 * The commit that last ticked each task: one `git log -p` over PLAN.md, newest first. A commit counts for a task when it
 * adds the task's line as [x] and either removes it with another status or adds the task new. Cached per HEAD.
 */
function tickCommits(root, cache) {
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  if (!head) return {};
  if (cache.head === head && cache.ticks) return cache.ticks;
  const out = git(root, ['log', '-n', '500', '--format=%x1e%h%x1f%ct%x1f%s', '-p', '--unified=0', '--no-color', '--', 'PLAN.md']);
  const ticks = {};
  const LINE = /^([+-])\s*[-*]\s+\[( |x|X|~|!)\]\s+.*?\{#([a-z0-9][a-z0-9-]*)\}\s*$/gim;
  for (const chunk of out.split('\x1e').slice(1)) {
    const nl = chunk.indexOf('\n');
    const [hash, ct, subject] = chunk.slice(0, nl < 0 ? chunk.length : nl).split('\x1f');
    const removed = {}, added = {};
    for (const m of chunk.slice(nl < 0 ? chunk.length : nl).matchAll(LINE)) (m[1] === '+' ? added : removed)[m[3]] = m[2].toLowerCase();
    for (const [id, ch] of Object.entries(added)) if (ch === 'x' && !ticks[id] && removed[id] !== 'x') ticks[id] = { hash, at: Number(ct) * 1000, subject };
  }
  cache.head = head; cache.ticks = ticks;
  return ticks;
}

/** The web address of the origin remote on GitHub, GitLab or Bitbucket: { base, commit } (commit is the path prefix), or null. */
function webOf(root) {
  const url = git(root, ['remote', 'get-url', 'origin']).trim();
  const m = url.match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
  if (!m || !/github|gitlab|bitbucket/i.test(m[1])) return null;
  return { base: `https://${m[1]}/${m[2]}`, commit: /gitlab/i.test(m[1]) ? '/-/commit/' : /bitbucket/i.test(m[1]) ? '/commits/' : '/commit/' };
}

// ---------- plan status ----------

/**
 * Where a task stands: done, active (claimed), blocked, planned (open and meant for now: plain or `from: agent`) or
 * roadmap (open, `from: roadmap`: intent for later, not part of the current scope).
 */
const stageOf = t => t.status === 'done' ? 'done' : t.status === 'active' ? 'active' : t.status === 'blocked' ? 'blocked' : t.from === 'roadmap' ? 'roadmap' : 'planned';

/**
 * How many agents can work at once without stepping on each other. Components own disjoint files, so each takes at most
 * one agent. A component is a lane when it has planned, unclaimed work, nobody is in it, nothing there is in conflict, and
 * every component it needs has started. Lanes are picked greedily (most planned work first); a candidate that shares a
 * needs: or links: edge with a busy or already picked component is held back, because coupled components change the
 * same surface. suggested = the agents running now + the lanes. `roadmap` repeats the count for roadmap tasks, for when
 * nothing is planned for now.
 */
function capacity(components, tasks, live) {
  const now = lanesFor(components, tasks, live, 'planned');
  // nothing planned for now: what pulling roadmap items in would allow
  return { ...now, roadmap: lanesFor(components, tasks, live, 'roadmap') };
}

function lanesFor(components, tasks, live, stage) {
  const byId = Object.fromEntries(components.map(c => [c.id, c]));
  const near = (a, b) => (byId[a] && (byId[a].needs.includes(b) || byId[a].links.includes(b))) || (byId[b] && (byId[b].needs.includes(a) || byId[b].links.includes(a)));
  const busy = components.filter(c => c.agents.length || c.claims.length).map(c => c.id);
  const taken = [...busy];
  const lanes = [], held = [];
  const cands = components.map(c => ({ c, open: tasks.filter(t => t.component === c.id && t.stage === stage && !t.claim) }))
    .filter(x => x.open.length && !busy.includes(x.c.id))
    .sort((a, b) => b.open.length - a.open.length || a.c.needs.length - b.c.needs.length);
  for (const { c, open } of cands) {
    const waits = c.needs.find(n => byId[n] && byId[n].counts.total && !byId[n].counts.done);
    const conflict = c.conflict === 'high' || c.conflict === 'medium';
    const near1 = taken.find(x => near(x, c.id));
    if (waits) held.push({ component: c.id, planned: open.length, reason: 'waits', on: waits });
    else if (conflict) held.push({ component: c.id, planned: open.length, reason: 'conflict' });
    else if (near1) held.push({ component: c.id, planned: open.length, reason: busy.includes(near1) ? 'busy' : 'coupled', on: near1 });
    else { lanes.push({ component: c.id, planned: open.length, next: open[0].id }); taken.push(c.id); }
  }
  return { running: live.length, busy, lanes, held, suggested: live.length + lanes.length };
}

// ---------- session names ----------

/**
 * The name a Claude Code session carries: the custom title (`/rename`, stored next to the transcript in
 * <session-id>/custom-title.json), else the generated summary at the head of a resumed transcript, else nothing.
 * Reads at most 64 KB of the transcript, never the whole file.
 */
function sessionName(transcriptPath, sessionId) {
  if (!transcriptPath) return null;
  const dir = path.dirname(transcriptPath);
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dir, sessionId, 'custom-title.json'), 'utf8'));
    const name = typeof t === 'string' ? t : t.customTitle || t.title || t.name;
    if (name) return String(name).slice(0, 80);
  } catch { /* no custom title */ }
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!/"type":"(summary|custom-title)"/.test(line)) continue;
      try { const j = JSON.parse(line); const name = j.customTitle || j.summary; if (name) return String(name).slice(0, 80); } catch { /* torn line at the end of the window */ }
    }
  } catch { /* unreadable */ }
  return null;
}

// ---------- state ----------

function build(loc, { runTests = false, now = Date.now(), gitCache = {}, tickCache = {} } = {}) {
  const { root, stateDir } = loc;
  let planText = '';
  try { planText = fs.readFileSync(path.join(root, 'PLAN.md'), 'utf8'); } catch { /* no plan */ }
  const plan = lib.parsePlan(planText);
  const events = lib.readEvents(stateDir, now);
  const view = lib.reduce(events, now);
  const compOf = f => lib.componentsOf(plan, f);

  // tasks by component with evidence
  const evidence = check.checkEvidence(root, plan, { runTests });
  const ticks = tickCommits(root, tickCache);
  const tasks = plan.tasks.map(t => {
    const last = view.statuses[t.id];
    const task = {
      id: t.id, title: t.title, component: t.component, status: t.status, tech: t.tech, by: t.by, from: t.from || '', horizon: t.horizon || '', check: t.check, line: t.line + 1,
      problems: evidence[t.id] ? evidence[t.id].problems : [],
      refs: evidence[t.id] ? evidence[t.id].refs : check.evidenceOf(t.tech).map(e => ({ token: e.token, path: e.path, file: null, from: e.from, to: e.to })),
      claim: last?.status === 'active' ? last : null,
      // the session that last changed the status through the hooks (within the event window), and the commit that ticked it
      changedBy: last ? { session: last.session, agent: last.by || null, status: last.status, at: last.at } : null,
      tick: t.status === 'done' ? ticks[t.id] || null : null,
    };
    task.stage = stageOf(task);
    return task;
  });

  // sessions with their recent file activity (newest first) and whether they still exist:
  //   active  hook events within the lease (the agent is editing)
  //   open    no recent edits, but the Claude Code transcript is still being written: the session is up, thinking or waiting
  //   ended   the session said goodbye (SessionEnd)
  //   gone    no goodbye, and the transcript is missing or silent for a day: the session no longer exists
  const sessions = Object.values(view.sessions).map(s => {
    let transcript = null;
    if (s.transcript) { try { const st = fs.statSync(s.transcript); transcript = { path: s.transcript, exists: true, at: st.mtimeMs }; } catch { transcript = { path: s.transcript, exists: false, at: null }; } }
    const transcriptLive = transcript?.exists && now - transcript.at < lib.LEASE_MS;
    const state = s.alive ? 'active' : s.ended ? 'ended' : transcriptLive ? 'open' : (transcript && (!transcript.exists || now - transcript.at > ACTIVITY_WINDOW_MS)) ? 'gone' : (now - s.lastAt > ACTIVITY_WINDOW_MS ? 'gone' : 'open');
    return {
      id: s.id, agent: s.agent, name: sessionName(s.transcript, s.id), alive: s.alive, ended: s.ended, state, lastAt: s.lastAt, transcript,
      files: [...s.files].filter(([, at]) => now - at < ACTIVITY_WINDOW_MS).sort((a, b) => b[1] - a[1]).map(([file, at]) => ({ file, at, components: compOf(file) })),
      components: [...s.components], planned: [...s.planned],
      claims: view.claims.filter(c => c.session === s.id).map(c => c.task),
      finished: Object.entries(view.statuses).filter(([, st]) => st.session === s.id && st.status === 'done').map(([task]) => task),
    };
  }).filter(s => s.alive || now - Math.max(s.lastAt, s.transcript?.at || 0) < ACTIVITY_WINDOW_MS).sort((a, b) => (a.state === 'active') === (b.state === 'active') ? b.lastAt - a.lastAt : a.state === 'active' ? -1 : 1);

  // working tree: changes nobody's hook attributed (or everybody's — the files are what matters)
  const changes = workingTree(root).map(c => ({ ...c, components: compOf(c.file) }));

  // conflicts
  const conflicts = [];
  const live = sessions.filter(s => s.alive);
  const byFile = {};
  for (const s of live) for (const f of s.files) if (now - f.at < lib.LEASE_MS) (byFile[f.file] = byFile[f.file] || []).push({ agent: s.agent, at: f.at });
  for (const [file, who] of Object.entries(byFile)) if (who.length > 1) conflicts.push({ kind: 'file', severity: 'high', file, components: compOf(file), agents: who.map(w => w.agent), text: `${who.map(w => w.agent).join(' and ')} both changed ${file}` });
  const byComp = {};
  for (const s of live) for (const c of new Set(s.files.filter(f => now - f.at < lib.LEASE_MS).flatMap(f => f.components))) (byComp[c] = byComp[c] || new Set()).add(s.agent);
  for (const [c, who] of Object.entries(byComp)) if (who.size > 1 && !conflicts.some(x => x.kind === 'file' && x.components.includes(c))) conflicts.push({ kind: 'component', severity: 'medium', component: c, agents: [...who], text: `${[...who].join(' and ')} are both working in #${c}` });
  for (const s of live) {
    const touched = new Set(s.files.filter(f => now - f.at < lib.LEASE_MS).flatMap(f => f.components));
    for (const c of touched) {
      const holder = view.claims.find(x => x.component === c && x.session !== s.id);
      if (holder && !s.planned.includes(c)) conflicts.push({ kind: 'claim', severity: 'medium', component: c, agents: [s.agent, holder.by], text: `${s.agent} changes #${c} while ${holder.by} holds #${holder.task} there` });
      else if (!s.planned.includes(c)) conflicts.push({ kind: 'unplanned', severity: 'low', component: c, agents: [s.agent], text: `${s.agent} changes #${c} without a claimed task there` });
    }
  }
  for (const s of live) {
    const outside = s.files.filter(f => now - f.at < lib.LEASE_MS && !f.components.length && f.file !== 'PLAN.md');
    if (outside.length) conflicts.push({ kind: 'outside', severity: 'low', agents: [s.agent], files: outside.map(f => f.file), text: `${s.agent} changes ${outside.length === 1 ? outside[0].file : `${outside.length} files`} that no component of the plan owns` });
  }
  for (const r of view.released) conflicts.push({ kind: 'released', severity: 'low', agents: [r.by], task: r.task, text: `#${r.task} fell back: ${r.by} ${r.reason}` });

  // components
  const components = plan.components.map(c => {
    const ts = tasks.filter(t => t.component === c.id);
    const key = c.files.join('|');
    if (!(key in gitCache)) gitCache[key] = lastCommitFor(root, c.files);
    const touchedAt = Math.max(0, ...sessions.flatMap(s => s.files.filter(f => f.components.includes(c.id)).map(f => f.at)));
    return {
      id: c.id, title: c.title, tech: plan.tasks.length ? (planText.match(new RegExp(`\\{#${c.id}\\}\\s*\\n\\s*tech:\\s*(.*)`)) || [])[1] || '' : '',
      files: c.files, needs: planNeeds(planText, c.id, 'needs'), links: planNeeds(planText, c.id, 'links'),
      counts: { done: ts.filter(t => t.status === 'done').length, active: ts.filter(t => t.status === 'active').length, blocked: ts.filter(t => t.status === 'blocked').length, open: ts.filter(t => t.status === 'pending').length, planned: ts.filter(t => t.stage === 'planned').length, roadmap: ts.filter(t => t.stage === 'roadmap').length, total: ts.length },
      agents: live.filter(s => s.files.some(f => f.components.includes(c.id) && now - f.at < lib.LEASE_MS) || s.claims.some(k => ts.some(t => t.id === k))).map(s => s.agent),
      claims: ts.filter(t => t.claim).map(t => ({ task: t.id, by: t.claim.by })),
      uncommitted: changes.filter(ch => ch.components.includes(c.id)).length,
      lastCommit: gitCache[key], touchedAt: touchedAt || null,
      evidenceFailed: ts.filter(t => t.problems.length).map(t => t.id),
      conflict: conflicts.filter(x => x.component === c.id || (x.components || []).includes(c.id)).reduce((m, x) => (x.severity === 'high' ? 'high' : m === 'high' ? m : x.severity === 'medium' ? 'medium' : m || 'low'), null),
    };
  });

  const summary = { total: tasks.length };
  for (const k of ['done', 'active', 'blocked', 'planned', 'roadmap']) summary[k] = tasks.filter(t => t.stage === k).length;
  if (!('web' in tickCache)) tickCache.web = webOf(root);
  const editor = (process.env.AGENTVIZ_EDITOR || 'vscode').trim();

  return {
    at: now, repo: path.basename(root), root, planPath: path.join(root, 'PLAN.md'), leaseMs: lib.LEASE_MS, testsRun: runTests,
    web: tickCache.web, editor: /^(none|off|)$/i.test(editor) ? null : editor.replace(/[^a-z0-9+.-]/gi, ''),
    summary, capacity: capacity(components, tasks, live),
    components, tasks, sessions, changes, conflicts, locks: lib.locksOf(stateDir).filter(l => l.expiresAt > now),
    decisions: (planText.split(/^## decisions\s*$/m)[1] || '').split('\n').filter(l => /^\s*[-*]\s+/.test(l)).map(l => l.replace(/^\s*[-*]\s+/, '')),
  };
}

function planNeeds(text, id, key) {
  const m = text.match(new RegExp(`\\{#${id}\\}\\s*\\n(?:[a-z]+:.*\\n)*?${key}:\\s*\\[([^\\]]*)\\]`));
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

// ---------- server ----------

function serve(loc, { port = PORT, runTests = RUN_TESTS, open = flag('--open'), log = false } = {}) {
  const page = path.join(__dirname, 'board.html');
  const clients = new Set();
  const gitCache = {};
  const tickCache = {};
  let state = build(loc, { runTests, gitCache, tickCache });
  let lastJson = JSON.stringify(state);

  const refresh = (why) => {
    try {
      // the git cache is per refresh: a commit changes what "last commit" means
      for (const k of Object.keys(gitCache)) delete gitCache[k];
      state = build(loc, { runTests, gitCache, tickCache });
      const json = JSON.stringify(state);
      if (json === lastJson) return;
      lastJson = json;
      for (const res of clients) res.write(`event: state\ndata: ${json}\n\n`);
    } catch (e) { process.stderr.write(`board: refresh after ${why} failed: ${e.message}\n`); }
  };

  // watch what can change the picture: PLAN.md, the hook state, the git index; file content elsewhere is seen through
  // `git status`, polled, so a read never counts as a change
  let timer = null;
  const schedule = why => { clearTimeout(timer); timer = setTimeout(() => refresh(why), 300); };
  const watchers = [];
  const watch = (p, recursive) => { try { watchers.push(fs.watch(p, { recursive }, () => schedule(p))); } catch { /* not there yet */ } };
  watch(path.join(loc.root, 'PLAN.md'), false);
  fs.mkdirSync(path.join(loc.stateDir, 'sessions'), { recursive: true });
  watch(loc.stateDir, true);
  const poll = setInterval(() => refresh('poll'), 5000).unref();
  const ping = setInterval(() => { for (const res of clients) res.write('event: ping\ndata: {}\n\n'); }, 15000).unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(page, 'utf8'));
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(lastJson);
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${lastJson}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  // stop everything that would keep the process alive: watchers, timers, open event streams
  const shutdown = () => { clearTimeout(timer); clearInterval(poll); clearInterval(ping); for (const w of watchers) w.close(); for (const res of clients) res.end(); clients.clear(); };
  server.on('close', shutdown);
  const close = server.close.bind(server);
  server.close = cb => { shutdown(); if (server.closeAllConnections) server.closeAllConnections(); return close(cb); };
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${server.address().port}`;
      if (log) {
        console.log(`agentviz · ${state.repo} · ${url}`);
        if (open) {
          const cp = require('child_process');
          const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
          const p = cp.spawn(cmd, a, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref();
        }
      }
      resolve({ server, url, refresh });
    });
  });
}

/** The command: serve the board for the repository around the current directory. */
function start() {
  const loc = lib.locate(process.cwd());
  if (!loc) { console.error('not inside a git repository'); process.exit(2); }
  return serve(loc, { log: true }).catch(e => { console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is in use; pass --port <n>` : e.message); process.exit(1); });
}

if (require.main === module) start();

module.exports = { build, serve, start, workingTree, lastCommitFor, sessionName, tickCommits, webOf, capacity, stageOf };
