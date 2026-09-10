import test from 'node:test';
import assert from 'node:assert/strict';
import * as rule from './over-issue.js';
import * as client from '../../client/src/lib/overIssue.js';
import { OVER_ISSUE, ackMatches, overIssueAuditText, overIssueRefusal } from './over-issue-gate.js';

const { overIssueLevel, overIssueVerdict, childCountSlip, sheetYield, OVER_ISSUE_CONFIRM_PCT, OVER_ISSUE_DOUBLE_PCT } = rule;

// ── The job this was built for ────────────────────────────────────────────
// CI-GANG-0051: METGAIN-G2 (2,000 @ 4 up) + Q MET 500 (1,000 @ 1 up), co-printed
// on one 12.66×25" print sheet, cut 3 to a 25×38" parent. The run needed
// 1,000 print sheets + 200 wastage = 1,200 print sheets = 400 parent sheets.
// 1,200 was typed into "Parent sheets to issue", saved on 26 Aug, locked on
// 2 Sep — and 1,200 parents were cut and printed on 5 Sep.
const QMET = { required: 400, issuing: 1200, childSheets: 1200, cpp: 3 };

test('CI-GANG-0051 — 1,200 typed against 400 — raises the two-step alarm', () => {
  const j = overIssueLevel(QMET);
  assert.equal(j.level, 'double');
  assert.equal(j.required, 400);
  assert.equal(j.issuing, 1200);
  assert.equal(j.excess, 800);
  assert.equal(j.pct, 200);
  assert.equal(j.ratio, 3);
});

test('CI-GANG-0051 — 1,200 is recognised as the print-sheet count typed into the parent box', () => {
  assert.equal(childCountSlip(QMET), true);
});

test('CI-GANG-0051 — the yields say the loss in cartons', () => {
  // Q MET 500 at 1 up: the engine's 400 parents make the order; 1,200 make 3,400.
  assert.equal(sheetYield({ parents: 400, cpp: 3, ups: 1, wastage: 200 }), 1000);
  assert.equal(sheetYield({ parents: 1200, cpp: 3, ups: 1, wastage: 200 }), 3400);
  // METGAIN-G2 rides the very same sheets at 4 up.
  assert.equal(sheetYield({ parents: 400, cpp: 3, ups: 4, wastage: 200 }), 4000);
  assert.equal(sheetYield({ parents: 1200, cpp: 3, ups: 4, wastage: 200 }), 13600);
});

test('thresholds: anything more than 15% over asks twice — the second time by typing the number', () => {
  // Anik's second pass (2026-09-10): "instead of 100%, we should reduce that to
  // 15%". The full two-step form now starts where the alarm starts, so the
  // one-step tier is retired — the dial for it stays, set level with the other.
  assert.equal(OVER_ISSUE_CONFIRM_PCT, 15);
  assert.equal(OVER_ISSUE_DOUBLE_PCT, 15);
  const at = issuing => overIssueLevel({ required: 400, issuing }).level;
  assert.equal(at(400), 'none', 'exactly the engine figure');
  assert.equal(at(460), 'none', 'exactly 15% over is inside the rule');
  assert.equal(at(461), 'double', 'past 15% — the full two-step form');
  assert.equal(at(799), 'double');
  assert.equal(at(800), 'double');
  assert.equal(at(5000), 'double');
  let n = 0;
  for (let i = 401; i <= 5000; i += 7, n++) assert.notEqual(at(i), 'confirm', `no one-step alarm is left (${i} vs 400)`);
  assert.ok(n > 600, 'the sweep must actually run');
});

test('exactly 15% over never trips on floating-point dust', () => {
  // 60 / 400 * 100 is 15.000000000000002 in JS — a float compare would fire here.
  for (const r of [20, 100, 400, 1000, 2600, 10620]) {
    const edge = r * 115 / 100;
    assert.ok(Number.isInteger(edge), `test setup: ${r} must have an integer 15% edge`);
    assert.equal(overIssueLevel({ required: r, issuing: edge }).level, 'none', `${edge} against ${r}`);
    assert.equal(overIssueLevel({ required: r, issuing: edge + 1 }).level, 'double', `${edge + 1} against ${r}`);
  }
});

test('an alarm never shows its figure rounded DOWN onto the line it crossed', () => {
  // 11,501 against 10,000 is 15.01% — "+15%" beside "more than 15%" reads as
  // inside the rule, on the very dialog saying it is not.
  const j = overIssueLevel({ required: 10000, issuing: 11501 });
  assert.equal(j.level, 'double');
  assert.ok(j.pct > 15, `shown as ${j.pct}%`);
  assert.equal(overIssueLevel({ required: 400, issuing: 500 }).pct, 25, 'an ordinary figure is left alone');
  assert.equal(overIssueLevel({ required: 400, issuing: 1200 }).pct, 200);
});

test('under, equal, or nothing to judge against — never an alarm', () => {
  const cases = [[400, 300], [400, 0], [400, 400], [0, 900], [null, 900], [undefined, 900],
    [NaN, 900], ['', 900], [400, NaN], [400, null], [400, undefined]];
  for (const [required, issuing] of cases) {
    assert.equal(overIssueLevel({ required, issuing }).level, 'none', `${required} / ${issuing}`);
  }
});

test('numeric strings and fractions are rounded the way the routes round them', () => {
  assert.equal(overIssueLevel({ required: '400', issuing: '1200' }).level, 'double');
  assert.equal(overIssueLevel({ required: 399.6, issuing: 460.4 }).level, 'none');   // 400 vs 460
});

test('a print count typed as parents is named as one, and always takes the two-step form', () => {
  // A 6,867-sheet run at 2 per parent is 3,434 parents (the odd sheet rounds a
  // parent up), so its print count typed as parents is double LESS ONE. Under
  // the first rule (two steps only at double) the percentage alone asked once;
  // the slip escalates, so it asks twice whatever the dials are set to.
  const v = overIssueVerdict({ required: 3434, issuing: 6867, childSheets: 6867, cpp: 2 });
  assert.equal(v.slip, true);
  assert.equal(v.level, 'double');
  assert.equal(overIssueVerdict(QMET).level, 'double');
  assert.equal(overIssueVerdict({ ...QMET, issuing: 400 }).level, 'none', 'inside the rule stays inside');
  assert.equal(overIssueVerdict({ required: 400, issuing: 500 }).slip, false, 'no print count known, no slip');
});

test('the print-sheet slip is only named when it means something', () => {
  assert.equal(childCountSlip({ ...QMET, cpp: 1 }), false, 'at 1 per parent the two counts are the same number');
  assert.equal(childCountSlip({ ...QMET, issuing: 800 }), false, 'a different number altogether');
  assert.equal(childCountSlip({ ...QMET, issuing: 400 }), false, 'not over at all');
  assert.equal(childCountSlip({ ...QMET, childSheets: null }), false, 'no print count known');
  // CI-GANG-0013: 2,600 parents at 2 per parent, 5,200 typed — a 5,199-sheet
  // run retyped as a round number is still the same slip.
  assert.equal(childCountSlip({ required: 2600, issuing: 5200, childSheets: 5199, cpp: 2 }), true);
});

test('yield never goes negative and shrugs off garbage', () => {
  assert.equal(sheetYield({ parents: 10, cpp: 2, ups: 4, wastage: 200 }), 0, 'all of it spent on make-ready');
  assert.equal(sheetYield({ parents: 'x', cpp: 2, ups: 4 }), 0);
  assert.equal(sheetYield({ parents: 100, cpp: 0, ups: 0 }), 100, 'an unsized cut degrades to 1:1 at one up');
});

// ── client twin parity ───────────────────────────────────────────────────
// The run engine shows the alarm's verdict live while the planner types, off
// client/src/lib/overIssue.js. If the two ever judged differently the screen
// would promise one thing and the save do another.
test('client twin: the planning screen judges by the same rule as the server', () => {
  assert.deepEqual(Object.keys(client).sort(), Object.keys(rule).sort());
  assert.equal(client.OVER_ISSUE_CONFIRM_PCT, rule.OVER_ISSUE_CONFIRM_PCT);
  assert.equal(client.OVER_ISSUE_DOUBLE_PCT, rule.OVER_ISSUE_DOUBLE_PCT);
  let n = 0;
  for (const required of [0, 1, 7, 100, 400, 725, 2600, 10000, 10626]) {
    for (const f of [0, 0.5, 1, 1.15, 1.1501, 1.151, 1.5, 1.99, 2, 3, 4.33]) {
      const c = { required, issuing: Math.round(required * f) };
      assert.deepEqual(client.overIssueLevel(c), rule.overIssueLevel(c), JSON.stringify(c));
      for (const cpp of [1, 2, 3, 4]) {
        for (const childSheets of [required * cpp, required * cpp - 1]) {
          const s = { ...c, childSheets, cpp };
          assert.equal(client.childCountSlip(s), rule.childCountSlip(s), JSON.stringify(s));
          assert.deepEqual(client.overIssueVerdict(s), rule.overIssueVerdict(s), JSON.stringify(s));
        }
      }
      n++;
    }
  }
  assert.ok(n >= 90, 'the spread must actually run');
  for (const y of [{ parents: 400, cpp: 3, ups: 1, wastage: 200 }, { parents: 0, cpp: 2, ups: 4 },
    { parents: 77.5, cpp: 2, ups: 3, wastage: 5 }, { parents: 'x' }]) {
    assert.equal(client.sheetYield(y), rule.sheetYield(y), JSON.stringify(y));
  }
});

// ── the server gate ──────────────────────────────────────────────────────
test('gate: inside the rule — nothing thrown, nothing to audit', () => {
  const out = overIssueRefusal({ required: 400, issuing: 440 });
  assert.equal(out.acked, false);
  assert.equal(out.judged.level, 'none');
});

test('gate: over the line with no answer — a structured 409 that carries the figures', () => {
  let err = null;
  try {
    overIssueRefusal({ required: 400, issuing: 1200,
      context: { where: 'run', ref: 'CI-GANG-0051', child_sheets: 1200, cpp: 3 } });
  } catch (e) { err = e; }
  assert.ok(err, 'must refuse');
  assert.equal(OVER_ISSUE, 'OVER_ISSUE');
  assert.equal(err.status, 409);
  assert.equal(err.body.code, OVER_ISSUE);
  const a = err.body.over_issue;
  assert.equal(a.level, 'double');
  assert.equal(a.required, 400);
  assert.equal(a.issuing, 1200);
  assert.equal(a.slip, true);
  assert.equal(a.ref, 'CI-GANG-0051');
  assert.equal(a.where, 'run');
  // A tablet still on an old bundle has only the central toast to show this,
  // so the sentence must stand on its own: both figures and the percentage.
  assert.match(err.message, /1,200/);
  assert.match(err.message, /400/);
  assert.match(err.message, /200%/);
});

test('gate: 16% over is refused too — the alarm now starts at the two-step form', () => {
  assert.throws(() => overIssueRefusal({ required: 400, issuing: 464 }),
    e => e.status === 409 && e.body?.over_issue?.level === 'double');
});

test('gate: an answer is bound to the exact figures it was given for', () => {
  const ok = overIssueRefusal({ required: 400, issuing: 1200, ack: { required: 400, issuing: 1200 } });
  assert.equal(ok.acked, true);
  assert.equal(ok.judged.level, 'double');
  // A yes to "1,200 against 400" is not a yes to 1,100, nor to a plan whose
  // requirement moved underneath it — and a bare truthy flag is not an answer.
  for (const ack of [{ required: 400, issuing: 1100 }, { required: 350, issuing: 1200 }, true, 'yes', {}, null]) {
    assert.throws(() => overIssueRefusal({ required: 400, issuing: 1200, ack }),
      e => e.status === 409 && e.body?.code === OVER_ISSUE, JSON.stringify(ack));
  }
});

test('ackMatches rounds the way the routes round', () => {
  assert.equal(ackMatches({ required: '400', issuing: '1200' }, 400, 1200), true);
  assert.equal(ackMatches({ required: 400.4, issuing: 1199.6 }, 400, 1200), true);
  assert.equal(ackMatches({ required: 400, issuing: 1201 }, 400, 1200), false);
});

test('audit text: the two-step answer reads as twice, and a raised wastage is named', () => {
  const two = overIssueRefusal({ required: 400, issuing: 1200, ack: { required: 400, issuing: 1200 } });
  const t2 = overIssueAuditText({ ref: 'CI-GANG-0051', judged: two.judged, action: 'plan locked' });
  assert.match(t2, /CI-GANG-0051/);
  assert.match(t2, /1,200/);
  assert.match(t2, /400/);
  assert.match(t2, /twice/);
  // The one-step tier is only a dial now, but the sentence still tells them apart.
  const t1 = overIssueAuditText({ ref: 'CI-JC-0001', action: 'plan locked',
    judged: { ...two.judged, level: 'confirm', issuing: 500, excess: 100, pct: 25, ratio: 1.25 } });
  assert.match(t1, /\+25%/);
  assert.doesNotMatch(t1, /twice/);
  const tw = overIssueAuditText({ ref: 'CI-JC-0002', judged: two.judged, action: 'plan saved',
    via: 'wastage', wastage: 800, standard: 200 });
  assert.match(tw, /wastage 800/);
  assert.match(tw, /standard 200/);
});
