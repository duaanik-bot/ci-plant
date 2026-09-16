// A change anywhere in the plant reaches every open screen at the same instant,
// and every screen used to wait the same fixed debounce and then refetch — so
// six screens asked the database for their whole page in the same millisecond.
// Measured on live prod 2026-09-16: one screen refreshing, Planning 431 ms and
// the Live Floor badge 65 ms; six at once, Planning 1,027 ms and the badge
// 1,039 ms, with the 2-core database pegged and not one lock or disk wait.
//
// refreshDelay() gives each listener its own random offset on top of its
// debounce, so the same refreshes arrive spread over about a second instead of
// stacked on one instant. Nothing refreshes less; it just stops arriving as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refreshDelay, REFRESH_JITTER_MS } from '../../client/src/lib/refreshDelay.js';

test('a refresh waits its debounce, plus at most the jitter window', () => {
  for (const r of [0, 0.25, 0.5, 0.999999]) {
    const d = refreshDelay(700, () => r);
    assert.ok(d >= 700, `never sooner than the debounce (${d})`);
    assert.ok(d < 700 + REFRESH_JITTER_MS, `never later than debounce + jitter (${d})`);
  }
  assert.equal(refreshDelay(250, () => 0), 250, 'the earliest a screen can refresh is unchanged');
});

test('two screens with different draws do not land on the same instant', () => {
  const a = refreshDelay(700, () => 0.1), b = refreshDelay(700, () => 0.9);
  assert.ok(Math.abs(a - b) >= REFRESH_JITTER_MS * 0.7, `spread apart (${a} vs ${b})`);
});

test('the jitter window is wide enough to break a stack, and short enough to feel live', () => {
  assert.ok(REFRESH_JITTER_MS >= 800 && REFRESH_JITTER_MS <= 1500, String(REFRESH_JITTER_MS));
});

test('a bad debounce falls back to zero rather than NaN', () => {
  assert.ok(Number.isFinite(refreshDelay(undefined, () => 0.5)));
  assert.ok(refreshDelay(-5, () => 0) >= 0);
});

test('the realtime hook actually schedules through refreshDelay', () => {
  const hook = readFileSync(new URL('../../client/src/lib/useRealtimeRefresh.js', import.meta.url), 'utf8');
  assert.match(hook, /import \{ refreshDelay \} from '\.\/refreshDelay\.js'/);
  assert.match(hook, /setTimeout\(run, refreshDelay\(debounceMs\)\)/,
    'schedule() must use the jittered delay, not the bare debounce');
  assert.equal(/setTimeout\(run, debounceMs\)/.test(hook), false, 'the unjittered schedule is gone');
});
