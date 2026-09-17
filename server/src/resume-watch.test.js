// When may the device have been away long enough for the realtime socket to die
// unnoticed? (client/src/lib/resumeWatch.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { watchResume, GAP_MS } from '../../client/src/lib/resumeWatch.js';

function rig() {
  let t = 1_000;
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  let tick = null;
  let fired = 0;
  const stop = watchResume({ win, doc, now: () => t, onResume: () => { fired++; }, every: fn => { tick = fn; return 0; } });
  return {
    win, doc, stop,
    advance: ms => { t += ms; },
    tick: () => tick(),
    fired: () => fired,
    visibility: state => { doc.visibilityState = state; doc.dispatchEvent(new Event('visibilitychange')); },
  };
}

test('a timer tick that arrives a sleep late is a wake-up; a punctual one is not', () => {
  const r = rig();
  r.advance(5_000); r.tick();
  assert.equal(r.fired(), 0);
  r.advance(GAP_MS + 1); r.tick();
  assert.equal(r.fired(), 1);
  r.stop();
});

test('network back, a thawed tab, and a bfcache restore are wake-ups', () => {
  const r = rig();
  r.win.dispatchEvent(new Event('online'));
  r.doc.dispatchEvent(new Event('resume'));
  const restored = new Event('pageshow'); restored.persisted = true;
  r.win.dispatchEvent(restored);
  r.win.dispatchEvent(new Event('pageshow'));   // a normal load is not
  assert.equal(r.fired(), 3);
  r.stop();
});

test('visible again after a long hide is a wake-up; a quick tab switch is not', () => {
  const r = rig();
  r.visibility('hidden'); r.advance(3_000); r.visibility('visible');
  assert.equal(r.fired(), 0);
  r.visibility('hidden'); r.advance(GAP_MS); r.visibility('visible');
  assert.equal(r.fired(), 1);
  r.stop();
  r.win.dispatchEvent(new Event('online'));
  assert.equal(r.fired(), 1, 'stop() removes every listener');
});
