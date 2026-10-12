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

function hook(dir, event) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: dir, ...event }), encoding: 'utf8', env: { ...process.env, AGENTVIZ_HOOK: '' } });
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
const writeFile = (dir, session, rel) => {
  const pre = hook(dir, { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) } });
  if (pre.code !== 0) return { pre };
  fs.writeFileSync(path.join(dir, rel), `// ${session}\n`);
  return { pre, post: hook(dir, { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) } }) };
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
  const near = writeFile(dir, 'bbbb2222', 'src/ingest/router.js');
  assert.equal(near.pre.code, 0);
  assert.match(near.post.context, /claude#aaaa holds #ingest-webhook/);
  assert.match(near.post.context, /without a task of that component marked \[~\] by you/);
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
