'use strict';
/**
 * The plan board (agentviz/board.js): the state it derives from PLAN.md, the hook events, git and the evidence
 * check, and the conflicts it reports. Two sessions are played in a scratch repository as in plan-tooling.test.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');
const board = require('../board');

const PLAN = `# Demo

## Take in events {#ingest}
tech: webhook and broker ingress
files: [src/ingest/**]
needs: [engine]
- [ ] Accept webhooks {#ingest-webhook}
  tech: src/ingest/webhook.js
- [x] Keep a history {#ingest-history}
  tech: src/ingest/history.js

## Run workflows {#engine}
tech: the state machine
files: [src/engine/**]
links: [ingest]
- [ ] Run steps {#engine-core}

## decisions
- first
`;

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-board-'));
  const g = a => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']); g(['config', 'user.email', 't@example.com']); g(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'src', 'ingest'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'engine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PLAN.md'), PLAN);
  fs.writeFileSync(path.join(dir, 'src', 'ingest', 'history.js'), 'a\n');
  g(['add', '.']); g(['commit', '-q', '-m', 'Release 0.0.1: first']);
  return dir;
}
const touch = (stateDir, session, file, components, at) => lib.append(stateDir, { at, session, agent: lib.agentLabel(session), type: 'touch', file, components });
const claim = (stateDir, session, task, component, at) => lib.append(stateDir, { at, session, agent: lib.agentLabel(session), type: 'status', task, component, status: 'active', prev: 'pending' });

test('the state carries components with counts, edges, last commit and evidence', () => {
  const dir = repo();
  const s = board.build(lib.locate(dir));
  assert.equal(s.components.length, 2);
  const ingest = s.components.find(c => c.id === 'ingest');
  assert.deepEqual(ingest.counts, { done: 1, active: 0, blocked: 0, open: 1, total: 2 });
  assert.deepEqual(ingest.needs, ['engine']);
  assert.equal(ingest.tech, 'webhook and broker ingress');
  assert.match(ingest.lastCommit.subject, /first/);
  assert.equal(s.conflicts.length, 0);
  assert.equal(s.changes.length, 0, 'clean working tree');
});

test('a ticked task whose evidence is gone is reported on the task and the component', () => {
  const dir = repo();
  fs.unlinkSync(path.join(dir, 'src', 'ingest', 'history.js'));
  const s = board.build(lib.locate(dir));
  assert.deepEqual(s.components.find(c => c.id === 'ingest').evidenceFailed, ['ingest-history']);
  assert.match(s.tasks.find(t => t.id === 'ingest-history').problems[0], /not found/);
  assert.equal(s.changes[0].file, 'src/ingest/history.js', 'the deletion shows as an uncommitted change');
});

test('two live sessions in one file is a high conflict, in one component a medium one, unplanned work a low one', () => {
  const dir = repo();
  const { stateDir } = lib.locate(dir);
  const now = Date.now();
  claim(stateDir, 'aaaa1111', 'ingest-webhook', 'ingest', now - 60e3);
  touch(stateDir, 'aaaa1111', 'src/ingest/webhook.js', ['ingest'], now - 50e3);
  touch(stateDir, 'bbbb2222', 'src/ingest/webhook.js', ['ingest'], now - 20e3);
  touch(stateDir, 'cccc3333', 'src/engine/x.js', ['engine'], now - 10e3);
  const s = board.build(lib.locate(dir), { now });
  const kinds = s.conflicts.map(c => c.kind + ':' + c.severity);
  assert.ok(kinds.includes('file:high'), kinds.join());
  assert.ok(kinds.includes('claim:medium'), 'bbbb changes #ingest while aaaa holds a task there');
  assert.ok(kinds.includes('unplanned:low'), 'cccc changed #engine without a claim');
  assert.equal(s.components.find(c => c.id === 'ingest').conflict, 'high');
  assert.deepEqual(s.components.find(c => c.id === 'ingest').agents.sort(), ['claude#aaaa', 'claude#bbbb']);
  assert.deepEqual(s.components.find(c => c.id === 'ingest').claims, [{ task: 'ingest-webhook', by: 'claude#aaaa' }]);
  assert.equal(s.sessions.length, 3);
});

test('a session is active, open, ended or gone depending on its hooks and its Claude Code transcript', () => {
  const dir = repo();
  const { stateDir } = lib.locate(dir);
  const now = Date.now();
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  // open: edits are old, but the transcript was written just now
  lib.append(stateDir, { at: now - 2 * lib.LEASE_MS, session: 'oooo1111', agent: 'claude#oooo', type: 'touch', file: 'src/engine/a.js', components: ['engine'], transcript });
  // gone: edits are old and the transcript does not exist any more
  lib.append(stateDir, { at: now - 2 * lib.LEASE_MS, session: 'gggg2222', agent: 'claude#gggg', type: 'touch', file: 'src/engine/b.js', components: ['engine'], transcript: path.join(dir, 'missing.jsonl') });
  // ended: said goodbye
  lib.append(stateDir, { at: now - 3 * lib.LEASE_MS, session: 'eeee3333', agent: 'claude#eeee', type: 'end', transcript });
  // active: edited a moment ago
  touch(stateDir, 'aaaa4444', 'src/engine/c.js', ['engine'], now - 5e3);
  // too old to show at all
  touch(stateDir, 'zzzz5555', 'src/engine/d.js', ['engine'], now - 30 * 3600e3);
  const s = board.build(lib.locate(dir), { now });
  const states = Object.fromEntries(s.sessions.map(x => [x.id, x.state]));
  assert.deepEqual(states, { aaaa4444: 'active', oooo1111: 'open', gggg2222: 'gone', eeee3333: 'ended' });
  assert.equal(s.sessions[0].id, 'aaaa4444', 'active sessions come first');
  assert.equal(s.sessions.find(x => x.id === 'gggg2222').transcript.exists, false);
});

test('a session carries the name Claude Code gave it: the custom title next to the transcript, else the transcript summary', () => {
  const dir = repo();
  const projects = path.join(dir, 'projects');
  fs.mkdirSync(path.join(projects, 'sess-a'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'sess-a.jsonl'), '{"type":"queue-operation"}\n');
  fs.writeFileSync(path.join(projects, 'sess-a', 'custom-title.json'), JSON.stringify({ customTitle: 'AI Platform' }));
  fs.writeFileSync(path.join(projects, 'sess-b.jsonl'), '{"type":"summary","summary":"Fix the broker topic matching","leafUuid":"x"}\n{"type":"user"}\n');
  fs.writeFileSync(path.join(projects, 'sess-c.jsonl'), '{"type":"user"}\n');
  assert.equal(board.sessionName(path.join(projects, 'sess-a.jsonl'), 'sess-a'), 'AI Platform');
  assert.equal(board.sessionName(path.join(projects, 'sess-b.jsonl'), 'sess-b'), 'Fix the broker topic matching');
  assert.equal(board.sessionName(path.join(projects, 'sess-c.jsonl'), 'sess-c'), null);
  assert.equal(board.sessionName(null, 'x'), null);
  const { stateDir } = lib.locate(dir);
  lib.append(stateDir, { at: Date.now(), session: 'sess-a', agent: 'claude#sess', type: 'touch', file: 'src/engine/a.js', components: ['engine'], transcript: path.join(projects, 'sess-a.jsonl') });
  assert.equal(board.build(lib.locate(dir)).sessions[0].name, 'AI Platform');
});

test('an ended session leaves the conflicts and shows as ended in the lanes', () => {
  const dir = repo();
  const { stateDir } = lib.locate(dir);
  const now = Date.now();
  touch(stateDir, 'aaaa1111', 'src/ingest/webhook.js', ['ingest'], now - 50e3);
  lib.append(stateDir, { at: now - 40e3, session: 'aaaa1111', agent: 'claude#aaaa', type: 'end' });
  touch(stateDir, 'bbbb2222', 'src/ingest/webhook.js', ['ingest'], now - 20e3);
  const s = board.build(lib.locate(dir), { now });
  assert.equal(s.conflicts.filter(c => c.kind === 'file').length, 0);
  assert.equal(s.sessions.find(x => x.id === 'aaaa1111').ended, true);
});

test('the server answers the page, the state and a first SSE event, and a change to PLAN.md is pushed', async () => {
  const dir = repo();
  const { server, url } = await board.serve(lib.locate(dir), { port: 0, open: false });
  try {
    const page = await fetch(url + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>AgentViz<\/title>/);
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.components.length, 2);
    const res = await fetch(url + '/events');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = dec.decode((await reader.read()).value);
    assert.match(buf, /^event: state\n/);
    fs.appendFileSync(path.join(dir, 'PLAN.md'), '\n## Decide {#inbox}\nfiles: [src/inbox/**]\nneeds: [engine]\n- [ ] Approve {#inbox-approve}\n');
    const until = Date.now() + 8000;
    let pushed = false;
    while (Date.now() < until && !pushed) {
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null, done: false }), 1000))]);
      if (done) break;
      if (value) { buf += dec.decode(value); pushed = /"id":"inbox"/.test(buf); }
    }
    assert.ok(pushed, 'the new component arrived over SSE');
    reader.cancel();
  } finally { server.close(); }
});
