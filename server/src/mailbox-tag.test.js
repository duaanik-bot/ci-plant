import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailboxTag } from '../../client/src/lib/enquiryUi.js';

// How the desk names a mailbox (owner, 12–13 Nov 2026: "Get rid of this also: this trial thing" → "Address customers
// too"). A mailbox whose replies go to the customer is shown by its address; "Trial" only ever describes a mailbox
// whose replies go back to itself. Invented addresses.

test('a mailbox that replies to the customer is shown by its address, with no trial word and no amber', () => {
  const t = mailboxTag({ key: 'trial', label: 'Trial', email: 'owner@plant.test', send_to: 'customers' });
  assert.equal(t.text, 'owner@plant.test');
  assert.doesNotMatch(`${t.text} ${t.title}`, /trial/i);
  assert.doesNotMatch(t.tone, /amber/);
  assert.equal(t.title, 'Replies go to the customer');
});

test('a mailbox that replies only to itself still says so, in amber', () => {
  const t = mailboxTag({ key: 'business', label: 'Business', email: 'office@plant.test', send_to: 'own' });
  assert.equal(t.text, 'TRIAL · office@plant.test · replies go only to itself');
  assert.match(t.tone, /amber/);
});

test('no mailbox in use says that', () => {
  assert.equal(mailboxTag(null).text, 'No mailbox in use');
});
