'use strict';
/**
 * What an agent is doing right now, read from the tail of its Claude Code transcript (never the whole file):
 *
 *   thinking    the model works on a prompt or on a tool result
 *   editing     Edit / Write / MultiEdit / NotebookEdit
 *   running     Bash / PowerShell (its description, else the command)
 *   reading     Read
 *   searching   Grep / Glob
 *   delegating  Agent / Task: a subagent works for it
 *   researching WebFetch / WebSearch
 *   planning    TodoWrite and the task tools
 *   tool        any other tool (MCP servers)
 *   waiting     the turn ended, or a question / approval is pending: the agent waits for its human
 *
 * plus the session's title (custom title, agent name or generated title), git branch and working directory. A
 * subagent writes its own transcript next to its parent's: <parent>/subagents/agent-<id>.jsonl.
 */
const fs = require('fs');
const path = require('path');

const TAIL = 384 * 1024;
const cache = new Map();   // file -> { mtime, size, entries }

/** The parsed JSON lines at the end of a transcript (cached per modification time). */
function tailOf(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.entries;
  const len = Math.min(TAIL, st.size);
  const buf = Buffer.alloc(len);
  try { const fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); } catch { return null; }
  const lines = buf.toString('utf8').split('\n');
  if (len < st.size) lines.shift();              // the first line is cut
  const entries = [];
  for (const l of lines) { if (!l.trim()) continue; try { entries.push(JSON.parse(l)); } catch { /* torn line */ } }
  cache.set(file, { mtime: st.mtimeMs, size: st.size, entries });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return entries;
}

const short = (s, n = 70) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function relTo(cwd, file) {
  if (!file) return '';
  const f = String(file);
  if (cwd) { const r = path.relative(cwd, f); if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/'); }
  return f.split(/[\\/]/).slice(-2).join('/');
}

/** A shell command as a person would name it: without a leading `cd …;`, a heredoc or redirections, first line only. */
function commandText(cmd) {
  let c = String(cmd || '').split('\n')[0];
  c = c.replace(/^\s*(cd|Set-Location)\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/i, '');
  if (/^\s*(cd|Set-Location)\s/i.test(c) && !/(&&|;)/.test(c)) return 'Changing directory';
  c = c.replace(/<<-?\s*'?\w+'?.*$/, '').replace(/\s+\d?>&?\s*\S+/g, '').replace(/\s*(\|\||&&|\|)\s*$/, '').trim();
  return c ? `Running ${short(c, 60)}` : 'Running a command';
}

/** One tool call as { kind, text, tool }. */
function describe(t, cwd) {
  const n = t.name || '';
  const i = t.input || {};
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) return { kind: 'editing', text: `Editing ${relTo(cwd, i.file_path || i.notebook_path)}` };
  if (/^(Bash|PowerShell)$/.test(n)) return { kind: 'running', text: i.description ? short(i.description) : commandText(i.command) };
  if (n === 'Read') return { kind: 'reading', text: `Reading ${relTo(cwd, i.file_path)}` };
  if (n === 'Grep' || n === 'Glob') return { kind: 'searching', text: `Searching ${short(i.pattern, 40)}` };
  if (n === 'Agent' || n === 'Task') return { kind: 'delegating', text: `Delegating: ${short(i.description || i.prompt, 60)}` };
  if (n === 'WebFetch' || n === 'WebSearch') return { kind: 'researching', text: n === 'WebSearch' ? `Searching the web: ${short(i.query, 40)}` : `Reading ${short(i.url, 50)}` };
  if (/^(TodoWrite|TaskCreate|TaskUpdate|TaskList)$/.test(n)) return { kind: 'planning', text: 'Planning its next steps' };
  if (n === 'AskUserQuestion') return { kind: 'waiting', text: 'Asks you a question' };
  if (n === 'ExitPlanMode') return { kind: 'waiting', text: 'Waits for you to approve its plan' };
  const m = n.match(/^mcp__(.+?)__(.+)$/);
  if (m) return { kind: 'tool', text: `Using ${m[2]} (${m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')})` };
  return { kind: 'tool', text: `Using ${n}` };
}

/**
 * The activity of one transcript: { kind, text, at, title, branch, cwd } or null when there is no transcript. A tool
 * call without a result for two minutes (other than a command or a subagent, which may run long) most likely waits
 * for the human's approval.
 */
function activityOf(file, now = Date.now()) {
  const entries = file ? tailOf(file) : null;
  if (!entries) return null;
  let title = null, last = null, pending = null;
  const results = new Set();
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k];
    if (!title && (e.type === 'custom-title' || e.type === 'agent-name' || e.type === 'ai-title' || e.type === 'summary')) title = e.customTitle || e.agentName || e.aiTitle || e.summary || null;
    if (e.type === 'user' && Array.isArray(e.message?.content)) for (const b of e.message.content) if (b.type === 'tool_result') results.add(b.tool_use_id);
    if (!last && (e.type === 'assistant' || e.type === 'user') && !e.isMeta) last = e;
    if (last && title) break;
  }
  // a custom title anywhere in the tail wins over a generated one
  for (const e of entries) if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
  if (!last) return { kind: 'waiting', text: 'Started, no prompt yet', at: null, title, branch: null, cwd: null };
  const at = Date.parse(last.timestamp) || null;
  const cwd = last.cwd || null;
  const base = { at, title: title ? short(title, 80) : null, branch: last.gitBranch || null, cwd };
  const content = Array.isArray(last.message?.content) ? last.message.content : [{ type: 'text', text: String(last.message?.content || '') }];
  if (last.type === 'assistant') {
    const tools = content.filter(b => b.type === 'tool_use');
    if (tools.length) {
      pending = tools[tools.length - 1];
      const d = describe(pending, cwd);
      const open = !results.has(pending.id);
      if (open && d.kind !== 'waiting' && !/^(Bash|PowerShell|Agent|Task)$/.test(pending.name) && at && now - at > 120e3) return { ...base, kind: 'waiting', text: `Probably waits for your approval: ${d.text}`, tool: pending.name };
      return { ...base, ...d, tool: pending.name };
    }
    if (last.message?.stop_reason === 'end_turn' || content.some(b => b.type === 'text')) return { ...base, kind: 'waiting', text: 'Finished its turn' };
    return { ...base, kind: 'thinking', text: 'Thinking' };
  }
  const text = content.filter(b => b.type === 'text').map(b => b.text).join(' ');
  if (/\[Request interrupted/.test(text)) return { ...base, kind: 'waiting', text: 'Interrupted, waits for you' };
  if (content.some(b => b.type === 'tool_result')) return { ...base, kind: 'thinking', text: 'Thinking about the result' };
  return { ...base, kind: 'thinking', text: 'Thinking about your prompt' };
}

const infos = new Map();
/**
 * What a subagent was asked to do: its meta file next to its transcript ({ agentType, description, finished }) and the
 * first prompt it got (at most 8 KB of it). `refs` are the #ids the description and prompt mention.
 */
function subagentInfo(file) {
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  const metaFile = file.replace(/\.jsonl$/, '.meta.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* older Claude Code: no meta file */ }
  const hit = infos.get(file);
  let prompt = hit?.prompt;
  if (prompt === undefined) {
    prompt = '';
    try {
      const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(Math.min(65536, st.size)); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      const first = JSON.parse(buf.toString('utf8').split('\n')[0]);
      const c = first.message?.content;
      prompt = (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : String(c || '')).slice(0, 8000);
    } catch { /* torn or empty */ }
    infos.set(file, { prompt });
  }
  const refs = [...new Set([...`${meta.description || ''} ${prompt}`.matchAll(/#([a-z0-9][a-z0-9-]*)/gi)].map(m => m[1]))];
  return { type: meta.agentType || null, description: meta.description || null, finished: meta.finished === true, refs };
}

/** The transcript of a subagent, next to its parent's transcript. */
function subagentTranscript(parentTranscript, parentId, agentId) {
  if (!parentTranscript || !agentId) return null;
  const id = String(agentId).replace(/^agent-/, '');
  const f = path.join(path.dirname(parentTranscript), parentId, 'subagents', `agent-${id}.jsonl`);
  return fs.existsSync(f) ? f : null;
}

const versions = new Map();
/** The version of the project a directory belongs to: the nearest package.json up to the repository root. */
function projectVersion(dir, root) {
  if (!dir) return null;
  const key = `${dir}|${root}`;
  const hit = versions.get(key);
  if (hit && Date.now() - hit.at < 30e3) return hit.v;
  let v = null;
  let d = path.resolve(dir);
  const stop = root ? path.resolve(root) : null;
  for (let i = 0; i < 6; i++) {
    try { const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); if (p.version) { v = p.version; break; } } catch { /* none here */ }
    if (stop && d.toLowerCase() === stop.toLowerCase()) break;
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  versions.set(key, { v, at: Date.now() });
  return v;
}

module.exports = { activityOf, subagentTranscript, subagentInfo, projectVersion, describe, tailOf };
