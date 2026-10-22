'use strict';
/**
 * What the board reads from Claude Code transcripts (activity, subagent briefs) and what it can do (claim, release,
 * start an agent), including the guard on its API.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');
const board = require('../board');
const activity = require('../activity');
const actions = require('../actions');

const PLAN = `# Demo

## Take in events {#ingest}
files: [src/ingest/**]
- [ ] Accept webhooks {#ingest-webhook}
- [x] Keep a history {#ingest-history}
  tech: src/ingest/history.js

## Run workflows {#engine}
files: [src/engine/**]
- [ ] Run steps {#engine-core}
`;

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentviz-act-'));
  const g = a => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']); g(['config', 'user.email', 't@example.com']); g(['config', 'user.name', 'Jane Doe']);
  fs.mkdirSync(path.join(dir, 'src', 'ingest'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PLAN.md'), PLAN);
  fs.writeFileSync(path.join(dir, 'src', 'ingest', 'history.js'), 'a\n');
  g(['add', '.']); g(['commit', '-q', '-m', 'first']);
  return dir;
}
const line = o => JSON.stringify(o) + '\n';
const at = ms => new Date(ms).toISOString();

test('activity: the last transcript entry says whether the agent thinks, edits, runs, delegates or waits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentviz-tr-'));
  const f = path.join(dir, 's.jsonl');
  const now = Date.now();
  const base = { cwd: dir, gitBranch: 'release/2.0', timestamp: at(now - 5e3) };
  const write = (...entries) => fs.writeFileSync(f, line({ type: 'custom-title', customTitle: 'Broker work' }) + entries.map(line).join(''));
  write({ ...base, type: 'user', message: { role: 'user', content: 'Build it' } });
  let a = activity.activityOf(f, now);
  assert.equal(a.kind, 'thinking'); assert.equal(a.title, 'Broker work'); assert.equal(a.branch, 'release/2.0');
  write({ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(dir, 'src', 'a.js') } }] } });
  a = activity.activityOf(f, now);
  assert.equal(a.kind, 'editing'); assert.equal(a.text, 'Editing src/a.js');
  write({ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cd /x && npm test 2>&1 | tail -5' } }] } });
  assert.equal(activity.activityOf(f, now).text, 'Running npm test | tail -5');
  write({ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Agent', input: { description: 'Lane: engine' } }] } });
  assert.equal(activity.activityOf(f, now).kind, 'delegating');
  write({ ...base, type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } });
  assert.equal(activity.activityOf(f, now).kind, 'waiting');
  // an edit nobody answered for three minutes waits for the human's approval
  write({ ...base, timestamp: at(now - 180e3), type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Write', input: { file_path: path.join(dir, 'b.js') } }] } });
  assert.match(activity.activityOf(f, now).text, /approval/);
  write({ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', id: 't5', name: 'Read', input: { file_path: path.join(dir, 'b.js') } }] } }, { ...base, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't5' }] } });
  assert.equal(activity.activityOf(f, now).text, 'Thinking about the result');
});

test('a subagent: its meta file and brief say what it works on and whether it finished', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentviz-sub-'));
  const parent = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(parent, '');
  fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
  const t = path.join(dir, 'sess', 'subagents', 'agent-a623f0.jsonl');
  fs.writeFileSync(t, line({ type: 'user', message: { content: 'You build lane #ingest, starting with #ingest-webhook.' } }));
  fs.writeFileSync(t.replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Lane: ingest', finished: false }));
  assert.equal(activity.subagentTranscript(parent, 'sess', 'agent-a623f0'), t);
  assert.equal(activity.subagentTranscript(parent, 'sess', 'a623f0'), t, 'with or without the agent- prefix');
  const info = activity.subagentInfo(t);
  assert.deepEqual(info, { type: 'general-purpose', description: 'Lane: ingest', finished: false, refs: ['ingest', 'ingest-webhook'] });
});

test('the owner claims a task on the board, an agent may take it over, the owner releases it', () => {
  const dir = repo();
  const loc = lib.locate(dir);
  const r = actions.claim(loc, 'ingest-webhook');
  assert.equal(r.ok, true); assert.equal(r.by, 'Jane Doe');
  assert.match(fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8'), /- \[~\] Accept webhooks \{#ingest-webhook\}\n  by: Jane Doe/);
  const later = Date.now() + 2 * lib.LEASE_MS;
  assert.equal(lib.reduce(lib.readEvents(loc.stateDir, later), later).claims.length, 1, "the owner's claim does not expire");
  assert.equal(actions.claim(loc, 'ingest-webhook').ok, false, 'a held task cannot be claimed twice');
  const s = board.build(loc);
  assert.ok(s.tasks.find(t => t.id === 'ingest-webhook').claim.session.startsWith('human:'));
  assert.equal(s.sessions.length, 0, 'the owner is not listed as an agent');
  assert.equal(actions.release(loc, 'ingest-webhook').ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8'), /- \[ \] Accept webhooks/);
  assert.equal(actions.claim(loc, 'ingest-history').ok, false, 'a done task cannot be claimed');
});

test('starting an agent writes its brief, records the launch and shows it as starting until the session appears', () => {
  const dir = repo();
  const loc = lib.locate(dir);
  const r = actions.start(loc, 'engine-core', { brief: 'Take #engine-core.', worktree: true, launch: false });
  assert.equal(r.ok, true); assert.equal(r.launched, false);
  assert.match(r.command, /claude '-n' '#engine-core Run steps' '--session-id' '[0-9a-f-]{36}' '-w' 'agentviz-engine-core'/);
  assert.equal(fs.readFileSync(r.brief, 'utf8'), 'Take #engine-core.\n');
  const s = board.build(loc);
  assert.deepEqual(s.launches.map(l => [l.task, l.session]), [['engine-core', r.session]]);
  lib.append(loc.stateDir, { session: r.session, agent: lib.agentLabel(r.session), type: 'start' });
  assert.equal(board.build(loc).launches.length, 0, 'once its session started, the launch is no longer pending');
});

test('the actions API answers only the page the server served', async () => {
  const dir = repo();
  const { server, url } = await board.serve(lib.locate(dir), { port: 0, open: false });
  try {
    const page = await (await fetch(url + '/')).text();
    const token = page.match(/name="agentviz-token" content="([0-9a-f]+)"/)[1];
    const post = (headers, body = { task: 'ingest-webhook' }) => fetch(url + '/api/claim', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 403, 'no token');
    assert.equal((await post({ 'x-agentviz-token': token, origin: 'https://evil.example' })).status, 403, 'another origin');
    const ok = await post({ 'x-agentviz-token': token });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal((await ok.json()).by, 'Jane Doe');
    assert.equal((await post({ 'x-agentviz-token': token })).status, 409, 'already held');
    assert.equal((await post({ 'x-agentviz-token': token }, { task: '../x' })).status, 400);
  } finally { server.close(); }
});
