'use strict';
/**
 * agentviz hooks and check: two Claude Code sessions are played against each other in a scratch git
 * repository by feeding hook events to agentviz/hook.js exactly as Claude Code does (JSON on stdin).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');
const check = require('../check');

const HOOK = path.join(__dirname, '..', 'hook.js');
const PLAN = `# Demo

## Take in events {#ingest}
files: [src/ingest/**]
- [ ] Accept webhooks {#ingest-webhook}
  tech: src/ingest/webhook.js
- [x] Keep a history {#ingest-history}
  tech: src/ingest/history.js:1-2

## Run workflows {#engine}
files: [src/engine/**]
- [ ] Run steps {#engine-core}

## decisions
- none yet
`;

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentviz-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src', 'ingest'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'engine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PLAN.md'), PLAN);
  fs.writeFileSync(path.join(dir, 'src', 'ingest', 'history.js'), 'a\nb\n');
  return dir;
}

function hook(dir, event, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: dir, ...event }), encoding: 'utf8', env: { ...process.env, AGENTVIZ_HOOK: '', AGENTVIZ_REQUIRE_CLAIM: '', ...env } });
  let out = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* plain */ }
  return { code: r.status, stderr: r.stderr, context: out?.hookSpecificOutput?.additionalContext || '' };
}

/** What an agent does when it follows the convention: edit PLAN.md, then the PostToolUse hook fires. */
function editPlan(dir, session, from, to) {
  const p = path.join(dir, 'PLAN.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to));
  return hook(dir, { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: p } });
}
const writeFile = (dir, session, rel, env = {}, extra = {}) => {
  const pre = hook(dir, { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) }, ...extra }, env);
  if (pre.code !== 0) return { pre };
  fs.writeFileSync(path.join(dir, rel), `// ${session}\n`);
  return { pre, post: hook(dir, { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) }, ...extra }, env) };
};
const planText = dir => fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8');

test('a claim made in PLAN.md becomes shared state; a second session is told and cannot take it over', () => {
  const dir = scratchRepo();
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'SessionStart' });
  editPlan(dir, 'aaaa1111', '- [ ] Accept webhooks', '- [~] Accept webhooks');
  const b = hook(dir, { session_id: 'bbbb2222', hook_event_name: 'SessionStart' });
  assert.match(b.context, /claude#aaaa holds #ingest-webhook/);
  const taken = editPlan(dir, 'bbbb2222', '  by: claude#aaaa', '  by: claude#bbbb');
  assert.equal(taken.context, '', 'rewriting the by: line alone records nothing');
  assert.match(planText(dir), /- \[~\] Accept webhooks \{#ingest-webhook\}\n  tech: src\/ingest\/webhook.js\n  by: claude#aaaa/, 'the sync restores the real claimant');
});

test('the same file is refused to a second live session; a different file of the same component only warns', () => {
  const dir = scratchRepo();
  editPlan(dir, 'aaaa1111', '- [ ] Accept webhooks', '- [~] Accept webhooks');
  assert.equal(writeFile(dir, 'aaaa1111', 'src/ingest/webhook.js').pre.code, 0);
  const clash = writeFile(dir, 'bbbb2222', 'src/ingest/webhook.js');
  assert.equal(clash.pre.code, 2);
  assert.match(clash.pre.stderr, /changed .* ago by claude#aaaa, which is still working/);
  // the claim requirement is its own rule (next test); relaxed to a reminder here, a different file only warns
  const near = writeFile(dir, 'bbbb2222', 'src/ingest/router.js', { AGENTVIZ_REQUIRE_CLAIM: 'warn' });
  assert.equal(near.pre.code, 0);
  assert.match(near.post.context, /claude#aaaa holds #ingest-webhook/);
  assert.match(near.post.context, /without a task of that component marked \[~\] by you/);
});

test('a file of a component is only written by an agent that holds a [~] task of that component', () => {
  const dir = scratchRepo();
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'SessionStart' });
  // nothing claimed yet: refused, with the way out
  const none = writeFile(dir, 'aaaa1111', 'src/ingest/webhook.js');
  assert.equal(none.pre.code, 2);
  assert.match(none.pre.stderr, /belongs to component #ingest, and you hold no task of it/);
  assert.match(none.pre.stderr, /mark the task you are working on \[~\], add an indented "by: claude#aaaa" line/);
  assert.match(none.pre.stderr, /#ingest-webhook Accept webhooks/);
  assert.doesNotMatch(none.pre.stderr, /Keep a history/, 'only open tasks are offered');
  // a claim in another component does not help
  editPlan(dir, 'aaaa1111', '- [ ] Run steps', '- [~] Run steps');
  assert.equal(writeFile(dir, 'aaaa1111', 'src/ingest/webhook.js').pre.code, 2);
  assert.equal(writeFile(dir, 'aaaa1111', 'src/engine/core.js').pre.code, 0, 'the claimed component is open');
  // PLAN.md itself and files no component owns are never refused
  assert.equal(hook(dir, { session_id: 'cccc3333', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'PLAN.md') } }).code, 0);
  assert.equal(writeFile(dir, 'cccc3333', 'README.md').pre.code, 0);
  // claim, then edit
  editPlan(dir, 'aaaa1111', '- [ ] Accept webhooks', '- [~] Accept webhooks');
  assert.equal(writeFile(dir, 'aaaa1111', 'src/ingest/webhook.js').pre.code, 0);
  // finishing the task ends the permission: the next edit needs a new claim
  editPlan(dir, 'aaaa1111', '- [~] Accept webhooks', '- [x] Accept webhooks');
  assert.equal(writeFile(dir, 'aaaa1111', 'src/ingest/router.js').pre.code, 2);
});

test('a subagent may edit what its parent session claimed; a sibling session may not', () => {
  const dir = scratchRepo();
  editPlan(dir, 'aaaa1111', '- [ ] Accept webhooks', '- [~] Accept webhooks');
  assert.equal(writeFile(dir, 'aaaa1111', 'src/ingest/webhook.js', {}, { agent_id: 'a623' }).pre.code, 0, 'the parent\'s claim covers its subagent');
  assert.equal(writeFile(dir, 'bbbb2222', 'src/ingest/other.js').pre.code, 2, 'another session holds no claim there');
});

test('AGENTVIZ_REQUIRE_CLAIM relaxes the claim rule: warn only reminds afterwards, off says nothing', () => {
  const dir = scratchRepo();
  const warn = writeFile(dir, 'aaaa1111', 'src/ingest/webhook.js', { AGENTVIZ_REQUIRE_CLAIM: 'warn' });
  assert.equal(warn.pre.code, 0);
  assert.match(warn.post.context, /without a task of that component marked \[~\] by you/);
  assert.equal(writeFile(dir, 'aaaa1111', 'src/ingest/more.js', { AGENTVIZ_REQUIRE_CLAIM: 'off' }).pre.code, 0);
});

test('the session start tells every agent to claim before editing', () => {
  const dir = scratchRepo();
  assert.match(hook(dir, { session_id: 'aaaa1111', hook_event_name: 'SessionStart' }).context, /BEFORE you edit any file/);
});

test('a claim ends with its session or after the lease, and the task falls back to its previous status', () => {
  const dir = scratchRepo();
  editPlan(dir, 'aaaa1111', '- [ ] Accept webhooks', '- [~] Accept webhooks');
  const { stateDir } = lib.locate(dir);
  const later = Date.now() + lib.LEASE_MS + 60e3;
  const quiet = lib.reduce(lib.readEvents(stateDir), later);
  assert.equal(quiet.claims.length, 0);
  assert.equal(quiet.statuses['ingest-webhook'].status, 'pending');
  assert.match(quiet.released[0].reason, /no activity/);
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'SessionEnd' });
  assert.match(planText(dir), /- \[ \] Accept webhooks/);
  assert.equal(lib.reduce(lib.readEvents(stateDir)).claims.length, 0);
});

test('finishing a claimed task is recorded and survives the sync', () => {
  const dir = scratchRepo();
  editPlan(dir, 'aaaa1111', '- [ ] Run steps', '- [~] Run steps');
  editPlan(dir, 'aaaa1111', '- [~] Run steps', '- [x] Run steps');
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'SessionEnd' });
  assert.match(planText(dir), /- \[x\] Run steps/);
});

test('a status changed in PLAN.md by a shell command is recorded like an edit', () => {
  const dir = scratchRepo();
  const p = path.join(dir, 'PLAN.md');
  editPlan(dir, 'aaaa1111', '- [ ] Run steps', '- [~] Run steps');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('- [~] Run steps', '- [x] Run steps'));
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'node update-plan.js' } });
  hook(dir, { session_id: 'bbbb2222', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'engine', 'x.js') } });
  assert.match(planText(dir), /- \[x\] Run steps/, 'another session\'s sync must not turn the finished task back into a claim');
  assert.equal(lib.reduce(lib.readEvents(lib.locate(dir).stateDir)).statuses['engine-core'].status, 'done');
});

test('the lab deployment is one at a time', () => {
  const dir = scratchRepo();
  const deploy = s => hook(dir, { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cf deploy mta_archives/x.mtar -f' } });
  assert.equal(deploy('aaaa1111').code, 0);
  const second = deploy('bbbb2222');
  assert.equal(second.code, 2);
  assert.match(second.stderr, /locked by claude#aaaa/);
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cf deploy mta_archives/x.mtar -f' } });
  assert.equal(deploy('bbbb2222').code, 0);
  assert.equal(hook(dir, { session_id: 'cccc3333', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cf apps' } }).code, 0, 'other cf commands are not locked');
});

test('the evidence check un-ticks a claim whose cited file is gone, and re-ticks it when the file is back', () => {
  const dir = scratchRepo();
  const planPath = path.join(dir, 'PLAN.md');
  const run = () => check.writeEvidence(planPath, check.checkEvidence(dir, lib.parsePlan(planText(dir)), { runTests: false }));
  assert.equal(run(), false, 'all evidence present: nothing changes');
  fs.writeFileSync(path.join(dir, 'src', 'ingest', 'history.js'), 'a\n');
  assert.equal(run(), true);
  assert.match(planText(dir), /- \[!\] Keep a history \{#ingest-history\}\n  tech: src\/ingest\/history.js:1-2\n  check: evidence failed .*src\/ingest\/history.js has 1 lines, cited 1-2/);
  fs.unlinkSync(path.join(dir, 'src', 'ingest', 'history.js'));
  run();
  assert.match(planText(dir), /check: evidence failed .*src\/ingest\/history.js not found/);
  fs.writeFileSync(path.join(dir, 'src', 'ingest', 'history.js'), 'a\nb\nc\n');
  run();
  assert.match(planText(dir), /- \[x\] Keep a history \{#ingest-history\}\n  tech: src\/ingest\/history.js:1-2\n\n## Run/);
  assert.match(planText(dir), /- \[ \] Accept webhooks/, 'an open task is never ticked by the check');
});

test('evidence tokens: paths, line ranges, globs and bare file names', () => {
  const ev = check.evidenceOf('srv/ingress/webhook.js:36-53, srv/cpi/generator/** and Palette.tsx (0.6.4), test/x.test.js; EngineSettings.appTitle');
  assert.deepEqual(ev.map(e => [e.path, e.from, e.to]), [['srv/ingress/webhook.js', 36, 53], ['srv/cpi/generator/**', null, null], ['Palette.tsx', null, null], ['test/x.test.js', null, null]]);
});

test('the PLAN.md of the repository agentviz is installed in passes its own evidence check', { skip: !fs.existsSync(path.join(__dirname, '..', '..', '..', 'PLAN.md')) && 'no host repository around this package' }, () => {
  // installed as node_modules/agentviz, the host repository is three levels up
  const root = path.join(__dirname, '..', '..', '..');
  const results = check.checkEvidence(root, lib.parsePlan(fs.readFileSync(path.join(root, 'PLAN.md'), 'utf8')), { runTests: false });
  const failed = Object.values(results).filter(r => r.problems.length).map(r => `#${r.task.id}: ${r.problems.join('; ')}`);
  assert.deepEqual(failed, []);
});

// ---------- subagents: one agent per subagent inside a session ----------
const subWrite = (dir, session, agentId, rel) => {
  const ev = k => ({ session_id: session, ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}), hook_event_name: k, tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) } });
  const pre = hook(dir, ev('PreToolUse'));
  if (pre.code !== 0) return { pre };
  fs.writeFileSync(path.join(dir, rel), `// ${session} ${agentId}\n`);
  return { pre, post: hook(dir, ev('PostToolUse')) };
};
const subPlan = (dir, session, agentId, from, to) => {
  const p = path.join(dir, 'PLAN.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to));
  return hook(dir, { session_id: session, agent_id: agentId, agent_type: 'general-purpose', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: p } });
};

test('each subagent is an agent of its own: siblings are guarded against each other, parent and child are not', () => {
  const dir = scratchRepo();
  hook(dir, { session_id: 'aaaa1111', agent_id: 'agent-a623f0', agent_type: 'general-purpose', hook_event_name: 'SubagentStart' });
  assert.equal(subWrite(dir, 'aaaa1111', 'agent-a623f0', 'src/ingest/webhook.js').pre.code, 2, 'claim first');
  subPlan(dir, 'aaaa1111', 'agent-a623f0', '- [ ] Accept webhooks', '- [~] Accept webhooks');
  assert.equal(subWrite(dir, 'aaaa1111', 'agent-a623f0', 'src/ingest/webhook.js').pre.code, 0);
  const sibling = subWrite(dir, 'aaaa1111', 'agent-b7c1d2', 'src/ingest/webhook.js');
  assert.equal(sibling.pre.code, 2, 'a sibling subagent may not write the same file');
  assert.match(sibling.pre.stderr, /by claude#aaaa › a623, which is still working/);
  assert.equal(subWrite(dir, 'aaaa1111', null, 'src/ingest/webhook.js').pre.code, 0, 'the parent session may');
  assert.equal(subWrite(dir, 'aaaa1111', 'agent-a623f0', 'src/ingest/webhook.js').pre.code, 0, 'and so may the subagent after its parent');
  const { stateDir } = lib.locate(dir);
  const view = lib.reduce(lib.readEvents(stateDir));
  const sub = view.sessions['aaaa1111~agent-a623f0'];
  assert.equal(sub.agent, 'claude#aaaa › a623');
  assert.equal(sub.parent, 'aaaa1111');
  assert.equal(sub.subagentType, 'general-purpose');
});

test('subagents claim apart, SubagentStop releases only that subagent, SessionEnd ends the rest', () => {
  const dir = scratchRepo();
  subPlan(dir, 'aaaa1111', 'agent-a623f0', '- [ ] Accept webhooks', '- [~] Accept webhooks');
  const taken = subPlan(dir, 'aaaa1111', 'agent-b7c1d2', '  by: claude#aaaa › a623', '  by: claude#aaaa › b7c1');
  assert.equal(taken.context, '', 'rewriting the by: line records nothing');
  subPlan(dir, 'aaaa1111', 'agent-b7c1d2', '- [ ] Run steps', '- [~] Run steps');
  const { stateDir } = lib.locate(dir);
  let view = lib.reduce(lib.readEvents(stateDir));
  assert.deepEqual(view.claims.map(c => [c.task, c.by]).sort(), [['engine-core', 'claude#aaaa › b7c1'], ['ingest-webhook', 'claude#aaaa › a623']]);
  assert.equal(view.sessions.aaaa1111, undefined, 'the parent did nothing itself yet');
  hook(dir, { session_id: 'aaaa1111', agent_id: 'agent-a623f0', agent_type: 'general-purpose', hook_event_name: 'SubagentStop', agent_transcript_path: path.join(dir, 'agent-a623f0.jsonl') });
  view = lib.reduce(lib.readEvents(stateDir));
  assert.deepEqual(view.claims.map(c => c.task), ['engine-core'], 'the finished subagent gave its claim back');
  assert.equal(view.sessions['aaaa1111~agent-a623f0'].ended, true);
  assert.match(planText(dir), /- \[ \] Accept webhooks/);
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'SessionEnd' });
  view = lib.reduce(lib.readEvents(stateDir));
  assert.equal(view.claims.length, 0, 'the session took its other subagent along');
  assert.equal(view.sessions['aaaa1111~agent-b7c1d2'].ended, true);
});

test('a session working in a linked worktree without a subagent id is keyed by the worktree', () => {
  const dir = scratchRepo();
  const g = a => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g(['config', 'user.email', 't@example.com']); g(['config', 'user.name', 't']);
  g(['add', '.']); g(['commit', '-q', '-m', 'first']);
  const wt = path.join(path.dirname(dir), path.basename(dir) + '-wave');
  g(['worktree', 'add', '-q', wt]);
  assert.equal(lib.locate(wt).worktree, path.basename(wt));
  assert.equal(lib.locate(dir).worktree, null);
  fs.mkdirSync(path.join(wt, 'src', 'engine'), { recursive: true });
  subPlan(wt, 'aaaa1111', null, '- [ ] Run steps', '- [~] Run steps');
  const r = subWrite(wt, 'aaaa1111', null, 'src/engine/core.js');
  assert.equal(r.pre.code, 0);
  const view = lib.reduce(lib.readEvents(lib.locate(dir).stateDir));
  const key = `aaaa1111~wt-${path.basename(wt)}`;
  assert.ok(view.sessions[key], Object.keys(view.sessions).join());
  assert.equal(view.sessions[key].agent, `claude#aaaa › wt-${path.basename(wt)}`.slice(0, `claude#aaaa › `.length + 16));
  assert.ok(view.sessions[key].files.has('src/engine/core.js'), 'the path counts relative to the worktree');
});

test('init registers SubagentStart and SubagentStop', () => {
  const dir = scratchRepo();
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).hooks;
  for (const ev of ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop']) assert.ok(hooks[ev], ev);
});

test('init moves hooks an earlier install left at another copy of agentviz', () => {
  const dir = scratchRepo();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const old = 'node "$CLAUDE_PROJECT_DIR/agentviz/hook.js"';
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: old }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] } }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 hook moved to/);
  const text = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
  assert.ok(!text.includes('$CLAUDE_PROJECT_DIR/agentviz/hook.js'), 'the old copy is no longer called');
  assert.match(text, /echo unrelated/, 'hooks of other tools stay');
  assert.equal(JSON.parse(text).hooks.PreToolUse.length, 1, 'no second agentviz entry');
});

test("init registers its hooks next to another tool's hook that is also called hook.js", () => {
  const dir = scratchRepo();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const other = 'node "$CLAUDE_PROJECT_DIR/scripts/cf-route-hook.js"';
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: other }] }] } }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const post = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).hooks.PostToolUse;
  const commands = post.flatMap(g => g.hooks.map(h => h.command));
  assert.ok(commands.includes(other), "the other tool's hook stays");
  assert.ok(commands.some(c => /agentviz/i.test(c) && /hook\.js/.test(c)), 'agentviz registers its own PostToolUse hook');
  // a second init changes nothing and says so
  const again = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'init'], { cwd: dir, encoding: 'utf8' });
  assert.match(again.stdout, /nothing to do: already initialised/);
});

test('init adds the plan:* scripts in place: the rest of package.json keeps its layout and line endings', () => {
  for (const eol of ['\n', '\r\n']) {
    const dir = scratchRepo();
    const original = ['{', '    "name": "demo",', '    "scripts": {', '        "test": "node --test"', '    },', '    "cds": { "requires": { "db": { "kind": "sqlite" } } }', '}', ''].join(eol);
    fs.writeFileSync(path.join(dir, 'package.json'), original);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'init'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(text).scripts), ['test', 'plan:board', 'plan:check', 'plan:check:tests']);
    assert.ok(text.includes('"cds": { "requires": { "db": { "kind": "sqlite" } } }'), 'one-line objects stay one line');
    assert.ok(text.includes('        "test": "node --test",'), 'the indent of the scripts is kept');
    assert.equal(text.split(eol).length, original.split(eol).length + 3, 'exactly three lines were added');
    if (eol === '\r\n') assert.ok(!/[^\r]\n/.test(text), 'no bare LF in a CRLF file');
  }
});

test('the claim refusal says when agentviz is not registered for PostToolUse, so the claim could never be recorded', () => {
  const dir = scratchRepo();
  const env = { HOME: dir, USERPROFILE: dir };
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'SessionStart' }, env);
  const without = writeFile(dir, 'aaaa1111', 'src/ingest/webhook.js', env);
  assert.equal(without.pre.code, 2);
  assert.match(without.pre.stderr, /not registered for PostToolUse/);
  spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'init'], { cwd: dir, encoding: 'utf8' });
  const withHook = writeFile(dir, 'aaaa1111', 'src/ingest/webhook.js', env);
  assert.equal(withHook.pre.code, 2, 'still refused: nothing is claimed');
  assert.doesNotMatch(withHook.pre.stderr, /not registered for PostToolUse/);
});

test('[I] marks a task in progress like [~], and a sync keeps the character', () => {
  const text = '## A {#a}\n- [I] One {#one}\n- [i] Two {#two}\n- [~] Three {#three}\n- [ ] Four {#four}\n';
  assert.deepEqual(lib.parsePlan(text).tasks.map(t => t.status), ['active', 'active', 'active', 'pending']);
  assert.equal(lib.applyStatuses(text, { one: { status: 'active' } }), text);
  assert.match(lib.applyStatuses(text, { one: { status: 'done' } }), /- \[x\] One \{#one\}/);
});

test("an agent takes over a task the owner marked in progress on the board", () => {
  const dir = scratchRepo();
  spawnSync('git', ['config', 'user.name', 'Jane Doe'], { cwd: dir });
  const actions = require('../actions');
  const loc = lib.locate(dir);
  assert.equal(actions.claim(loc, 'ingest-webhook').ok, true);
  assert.match(planText(dir), /  by: Jane Doe/);
  editPlan(dir, 'aaaa1111', '  by: Jane Doe', '  by: claude#aaaa');
  const view = lib.reduce(lib.readEvents(loc.stateDir));
  assert.deepEqual(view.claims.map(c => [c.task, c.by]), [['ingest-webhook', 'claude#aaaa']]);
  assert.match(planText(dir), /  by: claude#aaaa/);
});

test('update names the release it would install and how, without installing with --dry-run', () => {
  const dir = scratchRepo();
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'update', '9.9.9', '--dry-run'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /asked for v9\.9\.9/);
  assert.match(r.stdout, /> npm install -g github:cfl0x\/agentviz#v9\.9\.9/, 'outside a vendored copy it reinstalls globally');
  assert.match(r.stdout, /> agentviz init/);
  const vend = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'setup', '--no-board'], { cwd: dir, encoding: 'utf8' });
  assert.equal(vend.status, 0, vend.stderr);
  const u = spawnSync(process.execPath, [path.join(dir, '.agentviz', 'cli.js'), 'update', '9.9.9', '--dry-run'], { cwd: dir, encoding: 'utf8' });
  assert.match(u.stdout, /> npx -y github:cfl0x\/agentviz#v9\.9\.9 setup --no-board/, 'a vendored copy runs that release\'s setup');
});

test('uninstall takes out what setup put in, keeps PLAN.md and the hooks of other tools', () => {
  const dir = scratchRepo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc' } }));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project\n\nOur own rules.\n');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } }));
  const cli = path.join(__dirname, '..', 'cli.js');
  assert.equal(spawnSync(process.execPath, [cli, 'setup', '--no-board'], { cwd: dir, encoding: 'utf8' }).status, 0);
  hook(dir, { session_id: 'aaaa1111', hook_event_name: 'SessionStart' });
  const { stateDir } = lib.locate(dir);
  assert.ok(fs.existsSync(stateDir));
  const dry = spawnSync(process.execPath, [path.join(dir, '.agentviz', 'cli.js'), 'uninstall', '--dry-run'], { cwd: dir, encoding: 'utf8' });
  assert.match(dry.stdout, /dry run: nothing changed/);
  assert.ok(fs.existsSync(path.join(dir, '.agentviz')), 'a dry run changes nothing');
  const r = spawnSync(process.execPath, [path.join(dir, '.agentviz', 'cli.js'), 'uninstall'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.agentviz')));
  assert.ok(!fs.existsSync(stateDir));
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')), 'AGENTS.md held only the convention');
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Project\n\nOur own rules.\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts, { build: 'tsc' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } });
  assert.ok(fs.existsSync(path.join(dir, 'PLAN.md')), 'PLAN.md stays');
});
