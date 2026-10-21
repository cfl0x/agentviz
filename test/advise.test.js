'use strict';
/**
 * agentviz advise: the verdict on whether a plan qualifies for multi-agent work, derived from the board's lane count.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');
const board = require('../board');
const { advise, render } = require('../advise');

function repo(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentviz-advise-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  if (plan != null) fs.writeFileSync(path.join(dir, 'PLAN.md'), plan);
  return dir;
}
const verdictOf = dir => advise(board.build(lib.locate(dir)));

const INDEPENDENT = `# Demo

## Take in events {#ingest}
files: [src/ingest/**]
- [ ] Accept webhooks {#ingest-webhook}
- [ ] Dead-letter failures {#ingest-dlq}

## Run workflows {#engine}
files: [src/engine/**]
- [ ] Run steps {#engine-core}

## Show results {#ui}
files: [src/ui/**]
- [ ] List runs {#ui-runs}

## decisions
- none
`;

test('two or more free lanes and enough planned work: multi-agent, one agent per lane', () => {
  const a = verdictOf(repo(INDEPENDENT));
  assert.equal(a.verdict, 'multi-agent');
  assert.equal(a.agents, 3);
  assert.deepEqual(a.start.map(l => l.component).sort(), ['engine', 'ingest', 'ui']);
  assert.equal(a.start.find(l => l.component === 'ingest').planned, 2);
  const text = render(a);
  assert.match(text, /RECOMMENDED\. Run up to 3 agents in parallel/);
  assert.match(text, /lane #ingest: 2 planned tasks, next #ingest-webhook "Accept webhooks"/);
});

test('coupled components do not count as separate lanes: single agent, with the reason', () => {
  const coupled = INDEPENDENT.replace('files: [src/engine/**]', 'files: [src/engine/**]\nlinks: [ingest]').replace('files: [src/ui/**]', 'files: [src/ui/**]\nneeds: [engine]');
  const a = verdictOf(repo(coupled));
  assert.equal(a.verdict, 'single-agent');
  assert.equal(a.agents, 1);
  assert.ok(a.reasons.some(r => /only one free lane/.test(r)), a.reasons.join(' | '));
  assert.ok(a.held.length >= 1);
  assert.match(render(a), /NOT recommended for this plan\. Use one agent\./);
});

test('too little planned work is not worth a second agent even with free lanes', () => {
  const small = `# Demo

## One {#one}
files: [src/one/**]
- [ ] A {#one-a}

## Two {#two}
files: [src/two/**]
- [ ] B {#two-b}

## decisions
- none
`;
  const a = verdictOf(repo(small));
  assert.equal(a.verdict, 'single-agent');
  assert.ok(a.reasons.some(r => /only 2 planned tasks: below 3/.test(r)), a.reasons.join(' | '));
});

test('a claimed component is busy: the running agent counts, the lanes shrink', () => {
  const claimed = INDEPENDENT.replace('- [ ] Run steps {#engine-core}', '- [~] Run steps {#engine-core}\n  by: claude#aaaa');
  const dir = repo(claimed);
  const { stateDir } = lib.locate(dir);
  lib.append(stateDir, { session: 'aaaa1111', agent: 'claude#aaaa', type: 'start' });
  lib.append(stateDir, { session: 'aaaa1111', agent: 'claude#aaaa', type: 'status', task: 'engine-core', component: 'engine', status: 'active', prev: 'pending' });
  const a = verdictOf(dir);
  assert.equal(a.running, 1);
  assert.deepEqual(a.start.map(l => l.component).sort(), ['ingest', 'ui']);
  assert.equal(a.verdict, 'multi-agent');
  assert.equal(a.agents, 3, 'one running plus two free lanes');
});

test('no plan, no components or only the skeleton: not ready, backfill first', () => {
  assert.equal(verdictOf(repo(null)).verdict, 'not-ready');
  const skeleton = `# demo

## Set up the project {#setup}
files: [**]
- [ ] Describe the first component {#setup-first}
  from: agent

## decisions
- created
`;
  const a = verdictOf(repo(skeleton));
  assert.equal(a.verdict, 'not-ready');
  assert.match(a.next, /backfill PLAN\.md from the code/);
});

test('the command prints the advice, and JSON with --json', () => {
  const dir = repo(INDEPENDENT);
  const cli = path.join(__dirname, '..', 'cli.js');
  const text = spawnSync(process.execPath, [cli, 'advise'], { cwd: dir, encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Multi-agent work: RECOMMENDED/);
  const json = JSON.parse(spawnSync(process.execPath, [cli, 'advise', '--json'], { cwd: dir, encoding: 'utf8' }).stdout);
  assert.equal(json.verdict, 'multi-agent');
  assert.equal(json.agents, 3);
});
