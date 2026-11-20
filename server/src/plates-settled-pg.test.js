import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SETTLED_PR_SQL, settledMode, settledClause } from './plate-settled.js';

// Settled Plate PRs: history that the Plates list stops shipping by default.
// A PR is settled when its plates are back on the rack, its job card is closed
// or split, nothing has touched it for 14 days, and no plate of it is waiting on
// anyone (verification, a PR to raise, a replacement). Hidden rows are one click
// away (?settled=only) — nothing is gone.
//
// The SQL rule runs for real against a throwaway embedded Postgres:
//   PLATES_SETTLED_PG=1 node --test src/plates-settled-pg.test.js
// It never reads DATABASE_URL and never touches a shared or production database.

test('the mode parameter accepts hide and only; anything else is the legacy answer', () => {
  assert.equal(settledMode('hide'), 'hide');
  assert.equal(settledMode('only'), 'only');
  assert.equal(settledMode(undefined), 'all');
  assert.equal(settledMode('HIDE'), 'all');
  assert.equal(settledMode(['hide', 'only']), 'all');
  assert.equal(settledClause('all'), '');
  assert.equal(settledClause('hide'), `AND NOT (${SETTLED_PR_SQL})`);
  assert.equal(settledClause('only'), `AND (${SETTLED_PR_SQL})`);
});

const ENABLED = process.env.PLATES_SETTLED_PG === '1';
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('settled Plate PR rule on a real Postgres', {
  skip: ENABLED ? false : 'set PLATES_SETTLED_PG=1 to boot a throwaway Postgres',
  timeout: 180_000,
}, () => {
  let epg, dir, client;
  const ids = sql => client.query(sql).then(r => r.rows.map(row => row.id).sort((a, b) => a - b));
  const pick = mode => ids(`SELECT tr.id FROM tooling_requests tr JOIN job_cards jc ON jc.id=tr.job_card_id
    WHERE tr.family='plate' ${settledClause(mode)}`);
  const settled = async (id, why) => {
    assert.ok(!(await pick('hide')).includes(id), `${why}: must leave the default list`);
    assert.ok((await pick('only')).includes(id), `${why}: must be in the settled list`);
  };
  const kept = async (id, why) => {
    assert.ok((await pick('hide')).includes(id), `${why}: must stay in the default list`);
    assert.ok(!(await pick('only')).includes(id), `${why}: must not be called settled`);
  };
  let seq = 0;
  async function pr({ status = 'returned_to_rack', card = 'closed', days = 20, components = ['returned_to_rack'], family = 'plate', approval = 'converted', po = null } = {}) {
    const jc = (await client.query('INSERT INTO job_cards (status) VALUES ($1) RETURNING id', [card])).rows[0].id;
    const id = ++seq;
    await client.query(`INSERT INTO tooling_requests (id, family, status, job_card_id, updated_at, approval_status, po_number)
      VALUES ($1,$2,$3,$4, now() - make_interval(days => $5), $6, $7)`, [id, family, status, jc, days, approval, po]);
    for (const c of components) await client.query('INSERT INTO plate_request_components (tooling_request_id, status) VALUES ($1,$2)', [id, c]);
    return id;
  }

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const { default: pg } = await import('pg');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plates-settled-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' });
    await client.connect();
    await client.query(`
      CREATE TABLE job_cards (id serial PRIMARY KEY, status text);
      CREATE TABLE tooling_requests (id int PRIMARY KEY, family text, status text,
        job_card_id int REFERENCES job_cards(id), updated_at timestamptz,
        approval_status text, po_number text);
      CREATE TABLE plate_request_components (id serial PRIMARY KEY,
        tooling_request_id int REFERENCES tooling_requests(id), status text);`);
  });

  after(async () => {
    const within = (p, ms) => Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, ms).unref())]);
    if (client) await within(client.end(), 2000);
    if (epg) await within(epg.stop(), 10_000);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a returned PR on a closed card idle 14 days is settled', async () => {
    await settled(await pr(), 'returned, closed, 20 days');
  });

  test('a split card counts as finished too', async () => {
    await settled(await pr({ card: 'split' }), 'split card');
  });

  test('a settled-looking PR with a plate waiting on someone is kept', async () => {
    for (const waiting of ['verification_required', 'pr_required', 'replacement_required']) {
      await kept(await pr({ components: ['returned_to_rack', waiting] }), waiting);
    }
  });

  // returned_to_rack is stamped when the plates come OFF the press; each plate's own
  // status says where it really is. One still in the return queue, or not found,
  // is not "back on the rack" (found in review, 20 Nov 2026).
  test('a PR with a plate still awaiting verification or not found is kept', async () => {
    for (const where of ['returned_pending_verification', 'not_found']) {
      await kept(await pr({ components: ['returned_to_rack', where] }), where);
    }
  });

  test('a plate scrapped on return does not hold its PR open', async () => {
    await settled(await pr({ components: ['returned_to_rack', 'scrapped'] }), 'scrapped on return');
  });

  test('a returned PR on a card still in progress is kept', async () => {
    await kept(await pr({ card: 'in_progress' }), 'card in progress');
  });

  test('13 days is kept, 14 is settled', async () => {
    await kept(await pr({ days: 13 }), '13 days');
    await settled(await pr({ days: 14 }), '14 days');
  });

  // The Open view is the to-do list: !converted && !ready (PlatesLifecycle reqGroups).
  // Found on live data 20 Nov — a draft PR whose plates came back off the rack was
  // hidden, and Open dropped from 5 to 4. A PR never converted is never settled.
  test('a PR that was never converted stays — it is still on the Open list', async () => {
    await kept(await pr({ approval: 'draft' }), 'draft PR');
    await kept(await pr({ approval: 'saved' }), 'saved PR');
  });

  test('a PR with a PO number counts as converted', async () => {
    await settled(await pr({ approval: 'approved', po: 'PPO-0001' }), 'PO raised');
  });

  test('a ready PR on a closed card is kept — its plates may never have come back', async () => {
    await kept(await pr({ status: 'ready', components: ['issued'] }), 'ready on closed card');
  });

  test('hide and only split the legacy list exactly, with nothing in both', async () => {
    const all = await pick('all');
    const hide = await pick('hide');
    const only = await pick('only');
    assert.deepEqual([...hide, ...only].sort((a, b) => a - b), all);
    assert.equal(hide.filter(id => only.includes(id)).length, 0);
  });
});
