import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWaitText, fetchQueuedText } from '../../client/src/lib/enquiryUi.js';

// What the desk says while a Fetch waits (owner, 14 Nov 2026, "Cloud trigger instead"). The office computer is Windows,
// with no watcher: a company-mailbox Fetch starts at once only through the company's cloud routine, and without it the
// office AVS's next run reads it — the desk never promises "within a minute" for it.

test('a company-mailbox fetch waiting for the office says when the office reads it, never "within a minute"', () => {
  const t = fetchWaitText({ mailbox: 'business', fire_status: 'office' }, { business: { linked: false } });
  assert.match(t, /office computer's next AVS run/);
  assert.match(t, /7:30 am, 1 pm, 3:30 pm or 5:30 pm/);
  assert.doesNotMatch(t, /within a minute/);
});

test('a fetch started in the cloud says so; one whose start failed says what happens next for its own mailbox', () => {
  assert.match(fetchWaitText({ mailbox: 'business', fire_status: 'cloud', fired_at: '2026-11-14T08:00:00Z' }, {}),
    /started in the cloud .* land here in a few minutes/);
  const biz = fetchWaitText({ mailbox: 'business', fire_status: 'cloud_failed', fire_error: 'rate limited' }, { business: { linked: true } });
  assert.match(biz, /did not start: rate limited/);
  assert.match(biz, /office computer's next AVS run/);
  assert.doesNotMatch(biz, /link Claude/);
  const trial = fetchWaitText({ mailbox: 'trial', fire_status: 'cloud_failed', fire_error: '' }, { trial: { linked: false } });
  assert.match(trial, /did not start: no answer/);
  assert.match(trial, /link Claude in Settings/);
  assert.doesNotMatch(trial, /office/);
});

test('a trial-mailbox fetch waits for the Mac, which starts within a minute', () => {
  assert.equal(fetchWaitText({ mailbox: 'trial', fire_status: 'waiting' }, {}), 'Waiting for the Mac — its Claude starts within a minute when the Mac is on.');
});

test('pressing Fetch says who reads the mail and when', () => {
  assert.equal(fetchQueuedText('business', 51), "Fetch queued (job 51) — the office computer's next AVS run reads it (7:30 am, 1 pm, 3:30 pm or 5:30 pm)");
  assert.match(fetchQueuedText('trial', 52), /^Fetch queued \(job 52\) — the Mac starts within a minute when it is on/);
});
