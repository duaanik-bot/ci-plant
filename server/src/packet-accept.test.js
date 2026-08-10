import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { packetPlan } from './packet-plan.js';

// ACCEPTING A PACKET SUGGESTION — Anik, 2026-08-10: "once I accept the
// suggestion, then take that complete quantity, whatever you are suggesting,
// so that I don't have to retype it. Still keep things editable."
//
// Picking an option was always a note; the planner then read the total off the
// card and typed it into the board row by hand. Accept writes it for them.
//
// The arithmetic claim that makes ONE click enough is CONVERGENCE: applying an
// option's total re-plans the row against that new figure, and the option must
// then land exactly on it. If it did not, accepting would immediately offer a
// second, different total — the planner would be chasing the panel instead of
// being done with it. That is what these tests hold.

const SRC = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(SRC, p), 'utf8');
const advice = read('../../client/src/components/PacketAdvice.jsx');
const boardMix = read('../../client/src/components/BoardMix.jsx');

const opt = (plan, key) => plan.options.find(o => o.key === key);
// Piles whose remainders sum to `loose` while holding whole packets too, so a
// case can name both figures. Mirrors packet-plan.test.js's helper in intent.
const lotsFor = (loose, intact, P) => {
  const lots = [];
  let left = loose;
  while (left > P - 1) { lots.push({ qty: P - 1 }); left -= P - 1; }
  if (left > 0) lots.push({ qty: left });
  for (let k = 0; k < intact; k++) lots.push({ qty: P });
  return lots;
};

// ── Convergence: accepting settles in ONE step ──────────────────────────────

const CASES = [
  { required: 910, P: 100, loose: 0, intact: 20 },    // Anik's Example 1
  { required: 910, P: 100, loose: 60, intact: 20 },   // the storeman's usual
  { required: 910, P: 100, loose: 200, intact: 20 },  // more loose than residue
  { required: 1000, P: 100, loose: 60, intact: 20 },  // already whole packets
  { required: 907, P: 144, loose: 30, intact: 15 },   // 144-sheet board
  { required: 2350, P: 150, loose: 120, intact: 40 }, // 150-sheet board
  { required: 1, P: 100, loose: 0, intact: 5 },       // a single sheet
];

for (const key of ['clear_loose', 'least_excess', 'packets_only']) {
  test(`accepting "${key}" lands exactly on the figure it proposed`, () => {
    for (const c of CASES) {
      const lots = lotsFor(c.loose, c.intact, c.P);
      const first = opt(packetPlan({ required: c.required, packetSize: c.P, lots }), key);
      const total = Math.round(first.total_issue);
      // Re-plan against what accepting wrote into the row.
      const again = opt(packetPlan({ required: total, packetSize: c.P, lots }), key);
      assert.equal(Math.round(again.total_issue), total,
        `${key} on ${JSON.stringify(c)}: accepting ${total} re-proposed ${again.total_issue}`);
      assert.equal(Math.round(again.excess), 0,
        `${key} on ${JSON.stringify(c)}: an accepted figure must leave no spare of its own`);
    }
  });
}

test('an accepted figure never asks the plant for FEWER sheets than the job needs', () => {
  for (const c of CASES) {
    const lots = lotsFor(c.loose, c.intact, c.P);
    const plan = packetPlan({ required: c.required, packetSize: c.P, lots });
    for (const o of plan.options) {
      assert.ok(Math.round(o.total_issue) >= Math.round(plan.required),
        `${o.key} on ${JSON.stringify(c)} proposed ${o.total_issue} against ${plan.required}`);
    }
  }
});

// ── The wiring: where an accepted figure lands, and when it is offered ───────

test('the advice panel offers Accept only with a pick, and only when it would CHANGE the figure', () => {
  assert.match(advice, /required, board, lots = \[\], chosen = null, onChoose, onAccept, compact = false,/,
    'PacketAdvice must take an onAccept from the caller that owns the figure');
  assert.match(advice, /const canAccept = typeof onAccept === 'function' && selected\s*\n\s*&& acceptTotal !== Math\.round\(plan\.required\);/,
    'Accept needs a selection AND a total that differs — otherwise one click would not settle it');
  assert.match(advice, /onAccept\(acceptTotal, selected\)/,
    'the button must hand back the rounded total it displayed, never a raw float');
});

test('over-issue is stated on the button, never refused', () => {
  assert.match(advice, /acceptDelta > 0 &&/,
    'the bar must say when the accepted figure exceeds the requirement');
  assert.match(advice, /cutting will ask for a reason/,
    'the zero-tolerance cutting variance is the consequence — name it where the choice is made');
  assert.doesNotMatch(advice, /disabled=\{.*acceptDelta/,
    'a variance is a warning, not a gate — nothing here may block the accept');
});

test('an accepted suggestion lands on the board row that owns the sheets, and stays editable', () => {
  assert.match(boardMix, /onAccept=\{typeof onChange === 'function'\s*\n\s*\? total => set\(i, \{ sheets: total \}\)/,
    'accept must write through the SAME set() the number box uses — that is what keeps it editable');
  // A panel with nowhere to write must not grow a button that does nothing —
  // the same rule the leftover chip and the option chips already follow.
  assert.match(boardMix, /: undefined\} \/>/,
    'an unwired mix must pass no onAccept at all');
});
