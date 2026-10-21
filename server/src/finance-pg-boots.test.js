import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg } from './finance-pg-harness.js';

// The harness runs one boot after another in a process, and what the app keeps in module memory outlives each
// boot (finance-pg-harness.js says so at the top). Finance holds who-may-do-what for 10 s (finance-access.js),
// and user ids start again from 1 in every new database, so without help the second boot's viewer would be
// served the first boot's viewer's grant. close() forgets the lot.
// Opt-in, because it boots two throwaway Postgres databases:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-boots.test.js
const gate = { skip: process.env.FINANCE_PG === '1' ? false : 'set FINANCE_PG=1' };

test('a second boot in the same process is not served the first boot\'s grants', gate, async () => {
  let viewerId, bookId, heldAt;
  const first = await finBootPg('boots-first');
  try {
    viewerId = first.users.viewer.id;
    bookId = (await first.db.one(`SELECT id FROM fin_books WHERE code = 'CI'`)).id;
    assert.equal((await first.call('GET', `/finance/books/${bookId}/groups`, null, 'viewer')).status, 200);   // the grant is now held
    heldAt = Date.now();
  } finally { await first.close(); }

  // The same ids, but no book and no grant at all.
  const second = await finBootPg('boots-second', { setup: false });
  try {
    assert.equal(second.users.viewer.id, viewerId, 'user ids repeat from one boot to the next: that is the trap');
    const r = await second.call('GET', `/finance/books/${bookId}/groups`, null, 'viewer');
    assert.ok(Date.now() - heldAt < 10_000, 'this machine took over 10 s between the boots, so the hold had run out anyway and this proves nothing');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FIN_FORBIDDEN');
  } finally { await second.close(); }
});
