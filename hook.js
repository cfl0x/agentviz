#!/usr/bin/env node
'use strict';
/**
 * Claude Code hook for parallel agents (registered in .claude/settings.json for PreToolUse, PostToolUse, SessionStart,
 * Stop, SessionEnd, SubagentStart and SubagentStop). Reads the hook event from stdin; see agentviz/lib.js for the shared
 * state.
 *
 * An agent is a session, or a subagent inside one: Claude Code puts the parent's session_id and the subagent's agent_id
 * on every event a subagent raises, so a subagent gets an agent of its own (claude#166b › a623) with its own claims and
 * file guard. A session that edits a linked worktree without an agent_id is keyed by the worktree instead.
 *
 *   PreToolUse   Edit/Write/MultiEdit/NotebookEdit: refuses to write a file another live session wrote within the
 *                lease (exit 2, the agent reads why). PLAN.md is never refused.
 *                Bash `cf deploy` / `cf push` / `cf undeploy`: takes the deploy lock; refuses while another session
 *                holds it.
 *   PostToolUse  records the file as activity of its components; a PLAN.md edit records every changed task status as
 *                this session's claim / done / blocked event. Reports overlap with other sessions to the agent.
 *                Releases the deploy lock after the deploy command.
 *   SessionStart tells the agent which tasks other live sessions hold.
 *   Stop         heartbeat (never blocks: an agent waiting for an answer is still working).
 *   SessionEnd   releases this session's claims and locks, and those of its subagents.
 *   SubagentStart / SubagentStop   start and end of a subagent's agent; its claims are released at the end.
 *
 * A failure inside this hook never stops the agent: anything unexpected exits 0. AGENTVIZ_HOOK=off disables it.
 */
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Commands that must not run twice at once in one target; AGENTVIZ_LOCK_COMMANDS (a regular expression) replaces the default. */
const DEPLOY_RE = new RegExp(process.env.AGENTVIZ_LOCK_COMMANDS || '\\b(cf\\s+(deploy|push|undeploy|bg-deploy|blue-green-deploy)|helm\\s+(install|upgrade|uninstall)|kubectl\\s+(apply|delete|rollout)|terraform\\s+(apply|destroy)|pulumi\\s+(up|destroy))\\b');
const DEPLOY_LOCK = 'deploy';

const ago = ms => (ms < 90e3 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60e3)} min`);

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Emits context for the agent (PostToolUse / SessionStart understand additionalContext). */
function tell(event, text) {
  if (!text) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

function refuse(text) {
  process.stderr.write(text + '\n');
  process.exit(2);
}

function planOf(root) {
  try { return lib.parsePlan(fs.readFileSync(path.join(root, 'PLAN.md'), 'utf8')); } catch { return { components: [], tasks: [] }; }
}

function othersSummary(view, self, now) {
  const lines = [];
  for (const c of view.claims.filter(x => !lib.related(x.session, self))) lines.push(`- ${c.by} holds #${c.task} (claimed ${ago(now - c.at)} ago)`);
  return lines;
}

/** Ends agents: their live claims fall back to the previous status, then an end event; the deploy lock is released. */
function endAgents(stateDir, keys, base, now, reason) {
  const events = lib.readEvents(stateDir, now);
  const before = lib.reduce(events, now);
  for (const key of keys) {
    const s = before.sessions[key];
    const who = { ...base, session: key, agent: s?.agent || base.agent };
    for (const c of before.claims.filter(x => x.session === key)) {
      const prev = events.filter(e => e.type === 'status' && e.task === c.task && e.status === 'active' && e.session === key).pop()?.prev || 'pending';
      lib.append(stateDir, { ...who, type: 'status', task: c.task, component: c.component, status: prev, prev: 'active', reason });
    }
    lib.append(stateDir, { ...who, type: 'end' });
    lib.releaseLock(stateDir, DEPLOY_LOCK, key);
  }
}

function main() {
  if (process.env.AGENTVIZ_HOOK === 'off') return;
  const ev = JSON.parse(readStdin() || '{}');
  let loc = lib.locate(ev.cwd || process.cwd());
  if (!loc) return;
  const input = ev.tool_input || {};
  const filePath = input.file_path || input.notebook_path;
  // a file in another worktree of the same repository counts relative to that worktree
  if (filePath && EDIT_TOOLS.has(ev.tool_name) && !lib.relPath(loc.root, filePath)) {
    const there = fs.existsSync(path.dirname(String(filePath))) ? lib.locate(path.dirname(String(filePath))) : null;
    if (there && there.stateDir === loc.stateDir) loc = there;
  }
  const { root, stateDir } = loc;
  const sid = ev.session_id || 'manual';
  const sub = ev.agent_id ? String(ev.agent_id) : loc.worktree ? `wt-${loc.worktree}` : null;
  const session = sub ? lib.subKey(sid, sub) : sid;
  const agent = sub ? lib.subLabel(sid, sub) : lib.agentLabel(sid);
  // the transcript path lets the board tell whether a session still exists after its hooks went quiet; a subagent's
  // own transcript only arrives with SubagentStop, the parent's transcript says nothing about the subagent
  const transcript = ev.agent_id ? ev.agent_transcript_path : ev.transcript_path;
  const base = {
    session, agent, ...(transcript ? { transcript: String(transcript) } : {}),
    ...(sub ? { parent: sid, subagent: sub } : {}), ...(ev.agent_type ? { subagentType: String(ev.agent_type) } : {}), ...(loc.worktree ? { worktree: loc.worktree } : {}),
  };
  const kind = ev.hook_event_name;
  const now = Date.now();
  const rel = EDIT_TOOLS.has(ev.tool_name) ? lib.relPath(root, filePath) : null;
  const isDeploy = ev.tool_name === 'Bash' && DEPLOY_RE.test(String(input.command || ''));

  if (kind === 'SessionStart') {
    lib.append(stateDir, { ...base, type: 'start' });
    const view = lib.reduce(lib.readEvents(stateDir, now), now);
    const others = othersSummary(view, session, now);
    const lock = lib.readLock(stateDir, DEPLOY_LOCK);
    if (lock && lock.session !== session && lock.expiresAt > now) others.push(`- ${lock.agent} is deploying (since ${ago(now - lock.at)})`);
    if (lib.syncPlan(root, stateDir, now)) others.push('- PLAN.md statuses were brought in line with the other sessions; read it before editing.');
    tell('SessionStart', others.length ? `You are ${agent}. Other agents are working on this repository:\n${others.join('\n')}\nPick tasks nobody holds; mark yours [~] in PLAN.md before you start.` : `You are ${agent}. No other agent holds a task in PLAN.md right now.`);
    return;
  }

  if (kind === 'Stop') { lib.append(stateDir, { ...base, type: 'heartbeat' }); return; }

  if (kind === 'SubagentStart') { if (ev.agent_id) lib.append(stateDir, { ...base, type: 'start' }); return; }

  if (kind === 'SubagentStop') {
    if (!ev.agent_id) return;
    endAgents(stateDir, [session], base, now, 'subagent finished');
    lib.syncPlan(root, stateDir, now);
    return;
  }

  if (kind === 'SessionEnd') {
    // the session and every subagent or worktree agent of it that has not ended yet
    const view = lib.reduce(lib.readEvents(stateDir, now), now);
    const keys = [sid, ...Object.values(view.sessions).filter(s => s.id !== sid && lib.rootOf(s.id) === sid && !s.ended).map(s => s.id)];
    endAgents(stateDir, keys, { ...base, session: sid, agent: lib.agentLabel(sid) }, now, 'session ended');
    lib.syncPlan(root, stateDir, now);
    return;
  }

  if (kind === 'PreToolUse') {
    if (isDeploy) {
      const r = lib.acquireLock(stateDir, DEPLOY_LOCK, { ...base, note: String(input.command).slice(0, 200) }, now);
      if (!r.ok) refuse(`The deployment is locked by ${r.holder.agent} (since ${ago(now - r.holder.at)}, expires in ${ago(r.holder.expiresAt - now)}): ${r.holder.note}\nWait for it to finish, then retry. Two deployments into the same target at once break each other.`);
      return;
    }
    if (!rel || rel === 'PLAN.md') return;
    const view = lib.reduce(lib.readEvents(stateDir, now), now);
    for (const s of Object.values(view.sessions)) {
      // the agent itself and its family (a parent and its subagents) never block each other
      if (lib.related(s.id, session) || !s.alive) continue;
      const at = s.files.get(rel);
      if (at && now - at < lib.LEASE_MS && process.env.AGENTVIZ_ALLOW_SHARED_FILES !== '1') {
        refuse(`${rel} was changed ${ago(now - at)} ago by ${s.agent}, which is still working. Writing it now would mix two agents' changes in one file.\nCoordinate first: pick another task, or wait until ${s.agent} has finished (its claims are listed in PLAN.md).`);
      }
    }
    return;
  }

  if (kind === 'PostToolUse') {
    if (isDeploy) lib.releaseLock(stateDir, DEPLOY_LOCK, session);
    // a shell command can change PLAN.md too (sed, a script): its status changes count like an Edit's
    const planChanged = rel === 'PLAN.md' || ev.tool_name === 'Bash';
    if (!rel && !planChanged) { lib.append(stateDir, { ...base, type: 'heartbeat' }); return; }
    const plan = planOf(root);
    const notes = [];
    if (planChanged) {
      // every task whose checkbox differs from the shared view is this session's status change
      const view = lib.reduce(lib.readEvents(stateDir, now), now);
      for (const t of plan.tasks) {
        const shared = view.statuses[t.id];
        const before = shared ? shared.status : null;
        if (before === t.status || (!shared && t.status !== 'active')) continue;
        if (t.status === 'active' && shared?.status === 'active' && !lib.related(shared.session, session)) {
          notes.push(`#${t.id} is already claimed by ${shared.by}; your [~] was not recorded. Pick another task or ask ${shared.by}'s owner.`);
          continue;
        }
        lib.append(stateDir, { ...base, type: 'status', task: t.id, component: t.component, status: t.status, prev: before || 'pending' });
      }
    } else {
      const components = lib.componentsOf(plan, rel);
      lib.append(stateDir, { ...base, type: 'touch', file: rel, components });
      const view = lib.reduce(lib.readEvents(stateDir, now), now);
      for (const c of view.claims.filter(x => !lib.related(x.session, session) && components.includes(x.component))) {
        notes.push(`${rel} belongs to #${c.component}, where ${c.by} holds #${c.task}. Keep to files that task does not need, or coordinate.`);
      }
      const mine = view.sessions[session];
      const family = Object.values(view.sessions).filter(s => lib.related(s.id, session));
      if (components.length && mine && !components.some(c => family.some(s => s.planned.has(c)))) {
        notes.push(`You changed ${rel} (#${components.join(', #')}) without a task of that component marked [~] by you in PLAN.md. Mark the task you are working on.`);
      }
    }
    lib.syncPlan(root, stateDir, now);
    tell('PostToolUse', [...new Set(notes)].join('\n'));
  }
}

try { main(); } catch (e) {
  if (process.env.AGENTVIZ_DEBUG) process.stderr.write(`plan hook: ${e.stack}\n`);
}
