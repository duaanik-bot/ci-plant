// The Live Floor badge counts — the numbers behind the sidebar pills.
//
// These used to be derived on the client from /floor, which ships every card
// with its readiness gates, tooling, gang members and board mix (730 KB on live
// prod for 65 jobs) so the badge could keep ten integers. /floor/counts answers
// the same question from five columns. The point of this file is that the two
// keep answering it IDENTICALLY — hence the parity test at the bottom, which
// buckets the same fixture the way /floor does and asserts the totals agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousOf } from './stage-runs.js';
import { countsBySection, frontierState, SECTIONS } from './routes/floor.js';

// A lean stage row — exactly the five columns /floor/counts selects.
const st = (o) => ({ id: o.id, job_card_id: o.job_card_id ?? 1, seq: o.seq, stage: o.stage, status: o.status });

// How /floor itself buckets a card's stages, transcribed from the loop in the
// route: skip completed, classify, push into one of four arrays. The badge sums
// running + held + queued and ignores incoming.
const badgeTotalTheFloorWay = (stages) => {
  const byJc = new Map();
  for (const s of stages) {
    if (!byJc.has(s.job_card_id)) byJc.set(s.job_card_id, []);
    byJc.get(s.job_card_id).push(s);
  }
  const sections = Object.fromEntries(
    SECTIONS.map(s => [s, { running: [], held: [], queued: [], incoming: [] }]));
  for (const list of byJc.values()) {
    list.sort((a, b) => a.seq - b.seq);
    for (const s of list) {
      if (s.status === 'completed') continue;
      const state = frontierState(s, previousOf(list, s));
      if (state === 'running' || state === 'partial') sections[s.stage].running.push(s);
      else if (state === 'hold') sections[s.stage].held.push(s);
      else if (state === 'queued') sections[s.stage].queued.push(s);
      else sections[s.stage].incoming.push(s);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(
    ([k, v]) => [k, v.running.length + v.held.length + v.queued.length]));
};

test('every section is present and zero when the plant is empty', () => {
  const counts = countsBySection([]);
  assert.deepEqual(Object.keys(counts).sort(), [...SECTIONS].sort());
  assert.equal(Object.values(counts).every(n => n === 0), true);
});

test('running, partial and hold all count as active work', () => {
  const counts = countsBySection([
    st({ id: 1, job_card_id: 1, seq: 1, stage: 'printing', status: 'in_progress' }),
    st({ id: 2, job_card_id: 2, seq: 1, stage: 'printing', status: 'partially_completed' }),
    st({ id: 3, job_card_id: 3, seq: 1, stage: 'printing', status: 'hold' }),
  ]);
  assert.equal(counts.printing, 3);
});

test('a pending first stage is queued and counts', () => {
  const counts = countsBySection([
    st({ id: 1, seq: 1, stage: 'cutting', status: 'pending' }),
  ]);
  assert.equal(counts.cutting, 1);
});

test('pending behind a completed upstream is queued and counts', () => {
  const counts = countsBySection([
    st({ id: 1, seq: 1, stage: 'cutting', status: 'completed' }),
    st({ id: 2, seq: 2, stage: 'printing', status: 'pending' }),
  ]);
  assert.equal(counts.cutting, 0, 'the completed stage itself is not active work');
  assert.equal(counts.printing, 1);
});

test('pending behind an UNFINISHED upstream is incoming and does NOT count', () => {
  const counts = countsBySection([
    st({ id: 1, seq: 1, stage: 'cutting', status: 'in_progress' }),
    st({ id: 2, seq: 2, stage: 'printing', status: 'pending' }),
  ]);
  assert.equal(counts.cutting, 1);
  assert.equal(counts.printing, 0, 'still waiting upstream — not this station\'s work yet');
});

test('QC is skipped when looking upstream, so a stage after QC reads past it', () => {
  // printing done → qc pending → coating pending. QC inspects, it does not hand
  // material on, so coating's upstream is printing (completed) and it is queued.
  const counts = countsBySection([
    st({ id: 1, seq: 1, stage: 'printing', status: 'completed' }),
    st({ id: 2, seq: 2, stage: 'qc', status: 'pending' }),
    st({ id: 3, seq: 3, stage: 'coating', status: 'pending' }),
  ]);
  assert.equal(counts.coating, 1, 'coating looks past QC to the completed printing stage');
  assert.equal(counts.qc, 1, 'QC itself is queued behind completed printing');
});

test('counts are per section, not per card', () => {
  const counts = countsBySection([
    st({ id: 1, job_card_id: 1, seq: 1, stage: 'sorting', status: 'in_progress' }),
    st({ id: 2, job_card_id: 2, seq: 1, stage: 'sorting', status: 'pending' }),
    st({ id: 3, job_card_id: 3, seq: 1, stage: 'die_cutting', status: 'hold' }),
  ]);
  assert.equal(counts.sorting, 2);
  assert.equal(counts.die_cutting, 1);
});

test('a stage on an unknown section is ignored rather than crashing', () => {
  const counts = countsBySection([
    st({ id: 1, seq: 1, stage: 'not_a_section', status: 'pending' }),
  ]);
  assert.equal(Object.values(counts).reduce((s, n) => s + n, 0), 0);
});

// ── The anti-drift guard ────────────────────────────────────────────────────
test('countsBySection matches how /floor buckets the very same stages', () => {
  // A deliberately awkward plant: several cards, every status, QC mid-route,
  // completed stages interleaved, and work at both ends of the flow.
  const stages = [
    // card 1 — cutting done, printing running, coating waiting behind it
    st({ id: 1, job_card_id: 1, seq: 1, stage: 'cutting', status: 'completed' }),
    st({ id: 2, job_card_id: 1, seq: 2, stage: 'printing', status: 'in_progress' }),
    st({ id: 3, job_card_id: 1, seq: 3, stage: 'coating', status: 'pending' }),
    // card 2 — printing done, QC pending, die-cutting queued past QC
    st({ id: 4, job_card_id: 2, seq: 1, stage: 'printing', status: 'completed' }),
    st({ id: 5, job_card_id: 2, seq: 2, stage: 'qc', status: 'pending' }),
    st({ id: 6, job_card_id: 2, seq: 3, stage: 'die_cutting', status: 'pending' }),
    // card 3 — held at sorting, pasting stuck behind the hold
    st({ id: 7, job_card_id: 3, seq: 1, stage: 'sorting', status: 'hold' }),
    st({ id: 8, job_card_id: 3, seq: 2, stage: 'pasting', status: 'pending' }),
    // card 4 — part-run at lamination, nothing upstream
    st({ id: 9, job_card_id: 4, seq: 1, stage: 'lamination', status: 'partially_completed' }),
    // card 5 — wholly finished
    st({ id: 10, job_card_id: 5, seq: 1, stage: 'cutting', status: 'completed' }),
    st({ id: 11, job_card_id: 5, seq: 2, stage: 'embossing', status: 'completed' }),
  ];
  assert.deepEqual(countsBySection(stages), badgeTotalTheFloorWay(stages));

  // and it is not vacuously equal — the fixture really does have work in it
  const total = Object.values(countsBySection(stages)).reduce((s, n) => s + n, 0);
  assert.equal(total, 5, 'printing + lamination + die_cutting + sorting + qc');
});

test('the parity fixture counts exactly the stages it should', () => {
  const stages = [
    st({ id: 1, job_card_id: 1, seq: 1, stage: 'cutting', status: 'completed' }),
    st({ id: 2, job_card_id: 1, seq: 2, stage: 'printing', status: 'in_progress' }),
    st({ id: 3, job_card_id: 1, seq: 3, stage: 'coating', status: 'pending' }),
    st({ id: 4, job_card_id: 2, seq: 1, stage: 'printing', status: 'completed' }),
    st({ id: 5, job_card_id: 2, seq: 2, stage: 'qc', status: 'pending' }),
    st({ id: 6, job_card_id: 2, seq: 3, stage: 'die_cutting', status: 'pending' }),
    st({ id: 7, job_card_id: 3, seq: 1, stage: 'sorting', status: 'hold' }),
    st({ id: 8, job_card_id: 3, seq: 2, stage: 'pasting', status: 'pending' }),
    st({ id: 9, job_card_id: 4, seq: 1, stage: 'lamination', status: 'partially_completed' }),
    st({ id: 10, job_card_id: 5, seq: 1, stage: 'cutting', status: 'completed' }),
    st({ id: 11, job_card_id: 5, seq: 2, stage: 'embossing', status: 'completed' }),
  ];
  assert.deepEqual(countsBySection(stages), {
    cutting: 0,        // both completed
    printing: 1,       // card 1 running (card 2's is completed)
    coating: 0,        // incoming — printing still running
    lamination: 1,     // partial
    foiling: 0,
    embossing: 0,      // completed
    die_cutting: 1,    // queued past QC, printing done
    sorting: 1,        // hold
    pasting: 0,        // incoming — sorting is held, not completed
    qc: 1,             // queued behind completed printing
  });
});
