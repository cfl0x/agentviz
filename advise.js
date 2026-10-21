'use strict';
/**
 * agentviz advise: does this plan qualify for multi-agent work, and with how many agents?
 *
 * The answer comes from the same lane count as the board's "Parallel agents" panel (board.capacity), plus two sanity
 * rules, so the board, this command and the advice an agent gives always agree:
 *
 *   multi-agent   two or more free lanes AND at least three planned tasks in total. One agent per free lane, at most six.
 *   single-agent  fewer than two free lanes, or fewer than three planned tasks: the coordination costs more than it saves.
 *   not-ready     no PLAN.md, no components, or only the skeleton `agentviz init` writes: backfill the plan first.
 *
 * A free lane is a component with planned, unclaimed work where nobody works, nothing is in conflict, every component it
 * needs has started and no edge (needs:/links:) leads to a busy or already chosen component.
 *
 *   agentviz advise [--json]
 */
const lib = require('./lib');
const board = require('./board');

const MAX_AGENTS = 6;
const MIN_PLANNED = 3;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const HELD = {
  waits: h => `#${h.component} waits for #${h.on}, which has not finished`,
  conflict: h => `#${h.component} has a conflict that must be resolved first`,
  busy: h => `#${h.component} is next to #${h.on}, where an agent works (shared needs:/links: edge)`,
  coupled: h => `#${h.component} is coupled to #${h.on}, which another agent would take (shared needs:/links: edge)`,
};

/** The advice for a board state (board.build). Pure: no I/O. */
function advise(state) {
  const { components, tasks, summary, capacity: cap } = state;
  const title = id => (tasks.find(t => t.id === id) || {}).title || '';
  const lanes = cap.lanes.map(l => ({ component: l.component, planned: l.planned, next: l.next, title: title(l.next) }));
  const held = cap.held.map(h => ({ ...h, text: (HELD[h.reason] || (x => `#${x.component} is held back`))(h) }));
  const base = { running: cap.running, planned: summary.planned, components: components.length, lanes, held };

  const skeleton = tasks.length === 1 && tasks[0].id === 'setup-first';
  if (!components.length || !tasks.length || skeleton) {
    return { ...base, verdict: 'not-ready', agents: 1, reasons: [!components.length ? 'PLAN.md is missing or has no components' : 'PLAN.md is only the skeleton'],
      next: 'Let one agent backfill PLAN.md from the code (5-9 components with files:, tasks with evidence), then run advise again.' };
  }

  const reasons = [];
  if (lanes.length >= 2 && summary.planned >= MIN_PLANNED) {
    const room = Math.max(0, MAX_AGENTS - cap.running);
    const start = lanes.slice(0, room);
    return { ...base, verdict: 'multi-agent', agents: Math.min(MAX_AGENTS, cap.running + lanes.length), start,
      reasons: [`${plural(lanes.length, 'free lane')} with ${plural(summary.planned, 'planned task')}: components own disjoint files and do not depend on each other`],
      next: `Start one agent per lane (${start.map(l => `#${l.component}`).join(', ')}); give each its task brief from the board. The orchestrator owns PLAN.md structure, CHANGELOG, README and the other shared files. Merge one agent at a time and run \`agentviz check\` after each merge.` };
  }
  if (!summary.planned) reasons.push(summary.roadmap ? `nothing is planned for now (${plural(summary.roadmap, 'roadmap task')} would need to be pulled in)` : 'there are no open planned tasks');
  else if (summary.planned < MIN_PLANNED) reasons.push(`only ${plural(summary.planned, 'planned task')}: below ${MIN_PLANNED}, a second agent costs more in coordination than it saves`);
  if (lanes.length === 1) reasons.push(`only one free lane (#${lanes[0].component})`);
  if (!lanes.length && summary.planned) reasons.push('no free lane: all components with planned work are busy, waiting or coupled');
  for (const h of held) reasons.push(h.text);
  return { ...base, verdict: 'single-agent', agents: 1, start: lanes.slice(0, 1), reasons,
    next: lanes.length ? `Work on #${lanes[0].component} (next: #${lanes[0].next}) with one agent. Re-run advise when coupled components have finished or the plan gets more independent components.` : 'Use one agent, or change the plan: split the work along disjoint files, remove needless needs:/links: edges, or add planned tasks.' };
}

const HEADLINE = {
  'multi-agent': a => `Multi-agent work: RECOMMENDED. Run up to ${plural(a.agents, 'agent')} in parallel${a.running ? ` (${a.running} running now)` : ''}.`,
  'single-agent': () => 'Multi-agent work: NOT recommended for this plan. Use one agent.',
  'not-ready': () => 'Multi-agent work: plan NOT READY.',
};

function render(a) {
  const out = [HEADLINE[a.verdict](a), ''];
  out.push(...a.reasons.map(r => `  - ${r}`));
  if (a.verdict === 'multi-agent') for (const l of a.start) out.push(`  lane #${l.component}: ${plural(l.planned, 'planned task')}, next #${l.next}${l.title ? ` "${l.title}"` : ''}`);
  out.push('', `Next: ${a.next}`);
  return out.join('\n');
}

function main() {
  const loc = lib.locate(process.cwd());
  if (!loc) { console.error('agentviz advise: run it inside a git repository'); process.exit(2); }
  const a = advise(board.build(loc));
  console.log(process.argv.includes('--json') ? JSON.stringify(a, null, 2) : render(a));
}

module.exports = { advise, render, main, MAX_AGENTS, MIN_PLANNED };
