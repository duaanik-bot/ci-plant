// The Job Cards timeline — presets, the planned-date anchor, and the counts
// the chips promise. Pure client logic, tested here the same way boardUsed and
// boardMath are: the browser has no test runner in this repo, and this rule is
// too easy to get wrong by a day to leave unpinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isoDay, dayOf, presetRange, inTimeline, timelineCounts, unplannedCount, TIMELINE_PRESETS,
} from '../../client/src/lib/jobCardTimeline.js';

// A Wednesday, mid-afternoon. Wednesday matters: 'week' has to reach back to
// Monday and stop at today, so a preset that returned seven rolling days or ran
// forward to Sunday both fail here.
const WED = new Date(2026, 7, 5, 15, 30); // 2026-08-05, month is 0-based
const jc = (planned_date, extra = {}) => ({ id: 1, planned_date, ...extra });

test('isoDay reads the LOCAL calendar day, not the UTC one', () => {
  // 23:30 local on the 5th is already the 6th in UTC. toISOString() would file
  // this evening job under tomorrow for every plant east of Greenwich.
  assert.equal(isoDay(new Date(2026, 7, 5, 23, 30)), '2026-08-05');
  assert.equal(isoDay(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
});

test('dayOf takes the day off a bare date or a full timestamp, and nothing off null', () => {
  assert.equal(dayOf('2026-08-05'), '2026-08-05');
  assert.equal(dayOf('2026-08-05T00:00:00.000Z'), '2026-08-05');
  assert.equal(dayOf(null), null);
  assert.equal(dayOf(undefined), null);
  assert.equal(dayOf(''), null);
});

test('today and yesterday are single days', () => {
  assert.deepEqual(presetRange('today', WED), { from: '2026-08-05', to: '2026-08-05' });
  assert.deepEqual(presetRange('yesterday', WED), { from: '2026-08-04', to: '2026-08-04' });
});

test('this week is Monday → today, NOT a rolling seven days', () => {
  // Wednesday the 5th: the week began Monday the 3rd. A rolling 7-day window
  // would have started on 2026-07-30 and swept in last week's work.
  assert.deepEqual(presetRange('week', WED), { from: '2026-08-03', to: '2026-08-05' });
});

test('on a Monday, this week is that one day', () => {
  const mon = new Date(2026, 7, 3, 9, 0);
  assert.deepEqual(presetRange('week', mon), { from: '2026-08-03', to: '2026-08-03' });
});

test('on a Sunday, this week counts BACK to its own Monday', () => {
  // getDay() is 0 on Sunday. A naive `-getDay()` would return Sunday→Sunday and
  // hide the entire working week the plant just finished.
  const sun = new Date(2026, 7, 9, 11, 0);
  assert.deepEqual(presetRange('week', sun), { from: '2026-08-03', to: '2026-08-09' });
});

test('this week crosses a month boundary intact', () => {
  // Tuesday 1 Sep 2026 — Monday is 31 Aug, the previous month.
  const tue = new Date(2026, 8, 1, 10, 0);
  assert.deepEqual(presetRange('week', tue), { from: '2026-08-31', to: '2026-09-01' });
});

test('all and custom derive no range at all', () => {
  assert.equal(presetRange('all', WED), null);
  assert.equal(presetRange('custom', WED), null);
});

test('a null range accepts everything, including an unplanned card', () => {
  assert.equal(inTimeline(jc('2026-08-05'), null), true);
  assert.equal(inTimeline(jc(null), null), true);
  // Custom with both inputs still empty is the same as no filter — typing has
  // not started, so nothing should have vanished yet.
  assert.equal(inTimeline(jc(null), { from: '', to: '' }), true);
});

test('an UNPLANNED card is outside every real window', () => {
  const r = presetRange('today', WED);
  assert.equal(inTimeline(jc(null), r), false);
  assert.equal(inTimeline(jc(''), r), false);
  assert.equal(inTimeline(jc(undefined), r), false);
});

test('the window is inclusive at both ends', () => {
  const r = { from: '2026-08-03', to: '2026-08-05' };
  assert.equal(inTimeline(jc('2026-08-03'), r), true);
  assert.equal(inTimeline(jc('2026-08-05'), r), true);
  assert.equal(inTimeline(jc('2026-08-02'), r), false);
  assert.equal(inTimeline(jc('2026-08-06'), r), false);
});

test('a half-typed custom range bounds only the side it was given', () => {
  // From filled, To still empty: everything on or after From. Without this the
  // list would blank between the two keystrokes.
  assert.equal(inTimeline(jc('2026-09-01'), { from: '2026-08-01', to: '' }), true);
  assert.equal(inTimeline(jc('2026-07-01'), { from: '2026-08-01', to: '' }), false);
  assert.equal(inTimeline(jc('2026-07-01'), { from: '', to: '2026-08-01' }), true);
  assert.equal(inTimeline(jc('2026-09-01'), { from: '', to: '2026-08-01' }), false);
});

test('a timestamped planned_date lands on its own day, not the next one', () => {
  const r = presetRange('today', WED);
  assert.equal(inTimeline(jc('2026-08-05T18:45:00.000Z'), r), true);
});

test('chip counts are computed with the SAME rule the list filters by', () => {
  const jobs = [
    jc('2026-08-05'),            // today
    jc('2026-08-05'),            // today
    jc('2026-08-04'),            // yesterday
    jc('2026-08-03'),            // Monday — in the week, not today/yesterday
    jc('2026-07-28'),            // last month
    jc(null),                    // unplanned
  ];
  const c = timelineCounts(jobs, WED);
  assert.equal(c.all, 6);        // all counts EVERY card, unplanned included
  assert.equal(c.today, 2);
  assert.equal(c.yesterday, 1);
  assert.equal(c.week, 4);       // 2 today + 1 yesterday + 1 Monday
  // 'custom' has no derivable count and must not invent one.
  assert.equal(c.custom, undefined);
  // Every counted chip's number equals what the list would actually show.
  for (const p of TIMELINE_PRESETS) {
    if (p.key === 'all' || p.key === 'custom') continue;
    const shown = jobs.filter(j => inTimeline(j, presetRange(p.key, WED))).length;
    assert.equal(c[p.key], shown, `${p.key} chip promises a count the list does not deliver`);
  }
});

test('unplannedCount names exactly the cards no preset can show', () => {
  const jobs = [jc('2026-08-05'), jc(null), jc(''), jc(undefined)];
  assert.equal(unplannedCount(jobs), 3);
  assert.equal(unplannedCount([]), 0);
});

// ── The one-layout rule ─────────────────────────────────────────────────────
// The whole point of extracting JobCardSheet was that a card printed alone and
// the same card printed inside a batch are the same paper. Nothing enforces
// that at runtime, so it is asserted on the source: neither print page may grow
// a traveler of its own.
const src = p => readFileSync(new URL(`../../client/src/${p}`, import.meta.url), 'utf8');

test('both print pages render the SHARED sheet and build no layout of their own', () => {
  for (const page of ['pages/JobCardPrint.jsx', 'pages/JobCardBatchPrint.jsx']) {
    const s = src(page);
    assert.match(s, /import JobCardSheet from '\.\.\/components\/JobCardSheet\.jsx'/,
      `${page} must render the shared traveler`);
    assert.match(s, /<JobCardSheet jc=/, `${page} must render the shared traveler`);
    // "Board & cutting plan" is the traveler's own heading. If it appears in a
    // page file, that page has started keeping a second copy of the sheet.
    assert.ok(!/Board &amp; cutting plan/.test(s),
      `${page} is re-implementing the traveler — it must render JobCardSheet instead`);
  }
});

test('the batch page breaks the page between sheets, and the CSS defines that break', () => {
  assert.match(src('pages/JobCardBatchPrint.jsx'), /print-page-break/);
  const css = src('index.css');
  assert.match(css, /\.print-page-break\s*\{\s*break-after:\s*page/,
    'print-page-break must be a real print rule, not a dead class name');
});
