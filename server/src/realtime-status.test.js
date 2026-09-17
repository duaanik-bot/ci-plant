// Broadcast has no replay on a public channel, so a reconnect must reload every
// live screen once — and only a RE-connect, never the first join.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusTracker } from '../../client/src/lib/realtimeStatus.js';

test('the first SUBSCRIBED is not a catch-up', () => {
  const t = createStatusTracker();
  assert.equal(t.next('SUBSCRIBED').catchUp, false);
});

test('SUBSCRIBED after any break is a catch-up, exactly once', () => {
  for (const broken of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) {
    const t = createStatusTracker();
    t.next('SUBSCRIBED');
    t.next(broken);
    assert.equal(t.next('SUBSCRIBED').catchUp, true, broken);
    assert.equal(t.next('SUBSCRIBED').catchUp, false, `${broken}: a repeat without a new break is not`);
  }
});

test('failures before the first join do not count as a break to catch up from', () => {
  const t = createStatusTracker();
  t.next('TIMED_OUT'); t.next('CHANNEL_ERROR');
  assert.equal(t.next('SUBSCRIBED').catchUp, false);
});
