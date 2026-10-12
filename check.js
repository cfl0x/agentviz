#!/usr/bin/env node
'use strict';
/**
 * Checks PLAN.md against the repository and the shared agent state (npm run plan:check).
 *
 *   evidence   every [x] task names its evidence on the tech: line (files, line ranges, globs, test files). A cited
 *              path that does not exist, a line range beyond the end of the file, or (with --tests) a cited test file
 *              that fails turns the tick into [!] with a `check:` line saying why. When the evidence is back, the
 *              tick returns and the check: line goes. The check never ticks anything it did not un-tick itself.
 *   claims     live claims, claims released because their session ended or went quiet, the deploy lock.
 *   unplanned  sessions that changed files of a component without marking a task of it [~].
 *
 * Options: --write applies the evidence result to PLAN.md (default: report only), --tests also runs the cited test
 * files, --json prints the report as JSON. Exit code 1 when evidence fails, so CI can run it after a merge.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

const args = new Set(process.argv.slice(2));
const PATH_TOKEN = /(?:^|[\s(,`'"])((?:[\w@.-]+\/)*[\w@*.-]+\.(?:js|mjs|cjs|ts|tsx|cds|json|md|yaml|yml|css|sh|html)|(?:[\w@.-]+\/)+\*\*)(?::(\d+)(?:-(\d+))?)?(?=$|[\s),;`'"])/g;

/** Files that exist in the working tree: tracked and untracked, minus those deleted but not yet committed. */
function trackedFiles(root) {
  const run = a => { const r = spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }); return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []; };
  const deleted = new Set(run(['ls-files', '-d']));
  return run(['ls-files', '-co', '--exclude-standard']).filter(f => !deleted.has(f));
}

/** Evidence tokens of a tech: line: [{ token, path, from, to }] (path may be a glob or a bare file name). */
function evidenceOf(tech) {
  const out = [];
  for (const m of String(tech || '').matchAll(PATH_TOKEN)) out.push({ token: m[0].trim(), path: m[1], from: m[2] ? Number(m[2]) : null, to: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : null });
  return out;
}

/** Resolves one token against the repository: full path, glob, or a unique-enough file name / path suffix. */
function resolve(root, files, ev) {
  const p = ev.path.replace(/^\.\//, '');
  if (/[*?]/.test(p)) { const re = lib.globToRe(p); const hits = files.filter(f => re.test(f)); return hits.length ? hits : null; }
  if (files.includes(p) || fs.existsSync(path.join(root, p))) return [p];
  const hits = files.filter(f => f === p || f.endsWith('/' + p));
  return hits.length ? hits : null;
}

function checkEvidence(root, plan, { runTests }) {
  const files = trackedFiles(root);
  const results = {};
  const testRuns = {};
  const runTest = rel => {
    if (!(rel in testRuns)) {
      const r = spawnSync(process.execPath, ['--test', rel], { cwd: root, encoding: 'utf8', timeout: 300000, windowsHide: true, env: { ...process.env, AGENTVIZ_HOOK: 'off' } });
      testRuns[rel] = r.status === 0;
    }
    return testRuns[rel];
  };
  for (const t of plan.tasks) {
    if (t.status !== 'done' && !(t.status === 'blocked' && t.check)) continue;
    const problems = [];
    const evidence = evidenceOf(t.tech);
    for (const ev of evidence) {
      const hits = resolve(root, files, ev);
      if (!hits) { problems.push(`${ev.path} not found`); continue; }
      if (ev.from && hits.length === 1) {
        let n = 0;
        try { const text = fs.readFileSync(path.join(root, hits[0]), 'utf8'); n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0); } catch { /* unreadable */ }
        if (ev.to > n) problems.push(`${hits[0]} has ${n} lines, cited ${ev.from}-${ev.to}`);
      }
      if (runTests) for (const h of hits.filter(f => /^test\/.+\.test\.js$/.test(f))) if (!runTest(h)) problems.push(`${h} fails`);
    }
    results[t.id] = { task: t, evidence: evidence.length, problems };
  }
  return results;
}

/** Applies the evidence result: [x] -> [!] with a check: line, and back when the check: line was ours. */
function writeEvidence(planPath, results) {
  const lines = fs.readFileSync(planPath, 'utf8').split('\n');
  let changed = false;
  for (const { task: t, problems } of Object.values(results).sort((a, b) => b.task.line - a.task.line)) {
    const m = lines[t.line].match(/^(\s*[-*]\s+\[)( |x|X|~|!)(\].*)$/);
    if (!m) continue;
    let j = t.line + 1;
    let checkAt = -1;
    while (j < lines.length && /^\s+(tech|by|from|horizon|check):/i.test(lines[j])) { if (/^\s+check:/i.test(lines[j])) checkAt = j; j++; }
    const indent = (lines[t.line].match(/^\s*/)[0]) + '  ';
    if (problems.length) {
      const note = `${indent}check: evidence failed ${new Date().toISOString().slice(0, 10)}: ${problems.join('; ')}`;
      if (m[2] !== '!') { lines[t.line] = m[1] + '!' + m[3]; changed = true; }
      if (checkAt >= 0) { if (lines[checkAt] !== note) { lines[checkAt] = note; changed = true; } }
      else { lines.splice(j, 0, note); changed = true; }
    } else if (m[2] === '!' && checkAt >= 0) {
      lines[t.line] = m[1] + 'x' + m[3];
      lines.splice(checkAt, 1);
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(planPath, lines.join('\n'));
  return changed;
}

function main() {
  const loc = lib.locate(process.cwd());
  if (!loc) { console.error('not inside a git repository'); process.exit(2); }
  const { root, stateDir } = loc;
  const planPath = path.join(root, 'PLAN.md');
  const plan = lib.parsePlan(fs.readFileSync(planPath, 'utf8'));
  const now = Date.now();
  const results = checkEvidence(root, plan, { runTests: args.has('--tests') });
  const failed = Object.values(results).filter(r => r.problems.length);
  const unproven = Object.values(results).filter(r => !r.evidence && r.task.status === 'done');
  const view = lib.reduce(lib.readEvents(stateDir, now), now);
  const unplanned = [];
  for (const s of Object.values(view.sessions)) {
    const loose = [...s.components].filter(c => !s.planned.has(c));
    if (loose.length) unplanned.push({ agent: s.agent, alive: s.alive, components: loose, files: [...s.files.keys()].slice(-5) });
  }
  const locks = lib.locksOf(stateDir).filter(l => l.expiresAt > now);
  const written = args.has('--write') ? writeEvidence(planPath, results) : false;
  if (args.has('--write')) lib.syncPlan(root, stateDir, now);

  if (args.has('--json')) {
    console.log(JSON.stringify({ checked: Object.keys(results).length, failed: failed.map(r => ({ task: r.task.id, problems: r.problems })), unproven: unproven.map(r => r.task.id), claims: view.claims, released: view.released, unplanned, locks, written }, null, 2));
  } else {
    const out = [];
    out.push(`Evidence: ${Object.keys(results).length} ticked tasks checked${args.has('--tests') ? ' (cited tests run)' : ''}, ${failed.length} failed, ${unproven.length} without evidence on the tech: line.`);
    for (const r of failed) out.push(`  [!] #${r.task.id}: ${r.problems.join('; ')}`);
    for (const r of unproven) out.push(`  [?] #${r.task.id}: ticked without a cited file`);
    out.push(`Claims: ${view.claims.length} live${view.claims.length ? '' : '.'}`);
    for (const c of view.claims) out.push(`  [~] #${c.task} by ${c.by} since ${new Date(c.at).toISOString().slice(11, 16)} UTC`);
    for (const r of view.released) out.push(`  released #${r.task} (${r.by}): ${r.reason}`);
    if (unplanned.length) { out.push('Changed without a claimed task:'); for (const u of unplanned) out.push(`  ${u.agent}${u.alive ? ' (live)' : ''}: #${u.components.join(', #')} — ${u.files.join(', ')}`); }
    if (locks.length) for (const l of locks) out.push(`Lock ${l.name}: ${l.agent} since ${new Date(l.at).toISOString().slice(11, 16)} UTC — ${l.note}`);
    if (written) out.push('PLAN.md updated.');
    else if (failed.length && !args.has('--write')) out.push('Run with --write to mark the failed ticks [!] in PLAN.md.');
    console.log(out.join('\n'));
  }
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { evidenceOf, resolve, checkEvidence, writeEvidence, main };
