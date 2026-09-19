import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The document-number race, run for real: two transactions minting on the same
// prefix at the same time, against a real Postgres, through the app's own tx().
// doc-number-lock.test.js pins the contract with a stub; this proves the lock
// actually serialises the minters.
//
// Opt-in, because the server suite is otherwise pure unit tests and CI has no
// database (.github/workflows/ci.yml). It boots its OWN throwaway embedded
// Postgres in a temp dir on a free port and deletes it afterwards — it never
// reads DATABASE_URL and never touches :5439, a shared dev DB or production.
//
//   DOC_NUMBER_RACE_PG=1 node --test src/doc-number-race-pg.test.js

const ENABLED = process.env.DOC_NUMBER_RACE_PG === '1';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('document numbers under real concurrency', {
  skip: ENABLED ? false : 'set DOC_NUMBER_RACE_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, nextNumber, nextRunNumber, nextToolCode, nextProductCode, lockProductCodeSeries;

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-number-race-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({
      databaseDir: dir, port, user: 'postgres', password: 'postgres',
      persistent: false, onLog: () => {}, onError: () => {},
    });
    await epg.initialise();
    await epg.start();
    // db.js reads DATABASE_URL on connect(); point it at the throwaway cluster
    // only, then use the real tx() the routes use.
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    db = await import('./db.js');
    await db.connect();
    ({ nextNumber, nextProductCode, lockProductCodeSeries } = await import('./helpers.js'));
    ({ nextRunNumber } = await import('./routes/gangs.js'));
    ({ nextToolCode } = await import('./routes/tooling.js'));
    await db.q(`CREATE TABLE grns (id serial PRIMARY KEY, grn_number text NOT NULL UNIQUE)`);
    await db.q(`CREATE TABLE gang_runs (id serial PRIMARY KEY, gang_number text NOT NULL UNIQUE)`);
    await db.q(`CREATE TABLE tools (id serial PRIMARY KEY, family text NOT NULL, code text NOT NULL UNIQUE)`);
    await db.q(`CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL)`);
    await db.q(`CREATE TABLE products (id serial PRIMARY KEY, customer_id int REFERENCES customers(id), code text UNIQUE)`);
  });

  after(async () => {
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // Wait until some OTHER backend is blocked on a lock — the second minter has
  // reached its wait (on the prefix lock when fixed; on the first transaction's
  // uncommitted unique key when not). Deterministic, no sleeps to tune.
  async function untilSomeoneWaits() {
    for (let i = 0; i < 200; i++) {
      const row = await db.one(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
      if (row.n > 0) return;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('the second transaction never blocked');
  }

  // The production failure, step for step: A mints and inserts but has not yet
  // committed; B mints on the same prefix meanwhile; A commits. Unfixed, B read
  // the same highest number, minted the same next one, and its INSERT dies on
  // the unique index once A commits. `mintA` lets A take its number another way
  // (a typed product code) while B mints.
  async function race({ mint, mintA = mint, insert }) {
    let letACommit;
    const aMayCommit = new Promise(r => { letACommit = r; });
    let aMinted;
    const aHasMinted = new Promise(r => { aMinted = r; });

    const a = db.tx(async (qc, oc) => {
      const n = await mintA(oc, qc);
      await insert(qc, n);
      aMinted();
      await aMayCommit;
      return n;
    });
    await aHasMinted;
    const b = db.tx(async (qc, oc) => {
      const n = await mint(oc, qc);
      await insert(qc, n);
      return n;
    });
    await untilSomeoneWaits();
    letACommit();
    return Promise.all([a, b]);
  }

  test('two GRNs posted at once get consecutive numbers — neither hits the unique index', async () => {
    await db.q(`INSERT INTO grns (grn_number) VALUES ('CI-GRN-0104')`);
    const [a, b] = await race({
      mint: oc => nextNumber('CI-GRN-', 'grns', 'grn_number', oc),
      insert: (qc, n) => qc(`INSERT INTO grns (grn_number) VALUES ($1)`, [n]),
    });
    assert.deepEqual([a, b], ['CI-GRN-0105', 'CI-GRN-0106']);
  });

  test('two gang runs created at once get consecutive run numbers', async () => {
    const [a, b] = await race({
      mint: oc => nextRunNumber('CI-GANG-', oc),
      insert: (qc, n) => qc(`INSERT INTO gang_runs (gang_number) VALUES ($1)`, [n]),
    });
    assert.deepEqual([a, b], ['CI-GANG-0001', 'CI-GANG-0002']);
  });

  test('two dies registered at once get consecutive tool codes', async () => {
    const [a, b] = await race({
      mint: oc => nextToolCode('die', oc),
      insert: (qc, n) => qc(`INSERT INTO tools (family, code) VALUES ('die', $1)`, [n]),
    });
    assert.deepEqual([a, b], ['DIE-0001', 'DIE-0002']);
  });

  // Each test below mints on its own prefix, so a failure in one cannot shift
  // the numbers another expects.
  // Product Internal Codes (SW-768…) are a series of their own, minted the
  // same way — PO-import quick-create, Masters create / edit / migrate.
  test('two products created at once for one customer get consecutive codes', async () => {
    const { id: cust } = await db.one(`INSERT INTO customers (name) VALUES ('Swiss Garnier') RETURNING id`);
    await db.q(`INSERT INTO products (customer_id, code) VALUES ($1, 'SW-767')`, [cust]);
    const [a, b] = await race({
      mint: (oc, qc) => nextProductCode(cust, qc, oc),
      insert: (qc, code) => qc(`INSERT INTO products (customer_id, code) VALUES ($1, $2)`, [cust, code]),
    });
    assert.deepEqual([a, b], ['SW-768', 'SW-769']);
  });

  // The Masters form prefills the code, so most creates arrive TYPED. Unlocked,
  // a typed HRB-004 mid-save was invisible to a minter, which minted HRB-004
  // too and lost on the unique index when the typed one committed.
  test('a typed code mid-save makes a minted create wait and take the next code', async () => {
    const { id: cust } = await db.one(`INSERT INTO customers (name) VALUES ('Hindustan Rubber') RETURNING id`);
    await db.q(`INSERT INTO products (customer_id, code) VALUES ($1, 'HRB-003')`, [cust]);
    const [a, b] = await race({
      mintA: async oc => { await lockProductCodeSeries('HRB-004', oc); return 'HRB-004'; },
      mint: (oc, qc) => nextProductCode(cust, qc, oc),
      insert: (qc, code) => qc(`INSERT INTO products (customer_id, code) VALUES ($1, $2)`, [cust, code]),
    });
    assert.deepEqual([a, b], ['HRB-004', 'HRB-005']);
  });

  test('a burst of simultaneous posts (double-clicks, two storekeepers) all succeed with no gaps', async () => {
    await db.q(`INSERT INTO grns (grn_number) VALUES ('CI-BURST-0299')`);
    // allSettled, not all: a rejected minter must not leave its siblings still
    // writing into the next test.
    const settled = await Promise.allSettled(Array.from({ length: 12 }, () => db.tx(async (qc, oc) => {
      const n = await nextNumber('CI-BURST-', 'grns', 'grn_number', oc);
      await qc(`INSERT INTO grns (grn_number) VALUES ($1)`, [n]);
      return n;
    })));
    assert.deepEqual(settled.filter(r => r.status === 'rejected').map(r => r.reason.message), []);
    const want = Array.from({ length: 12 }, (_, i) => `CI-BURST-${String(300 + i).padStart(4, '0')}`);
    assert.deepEqual(settled.map(r => r.value).sort(), want);
  });

  test('a minter that rolls back gives its number back — the next one reuses it, no gap', async () => {
    await db.q(`INSERT INTO grns (grn_number) VALUES ('CI-RB-0499')`);
    await assert.rejects(db.tx(async (qc, oc) => {
      const n = await nextNumber('CI-RB-', 'grns', 'grn_number', oc);
      assert.equal(n, 'CI-RB-0500');
      await qc(`INSERT INTO grns (grn_number) VALUES ($1)`, [n]);
      throw new Error('validation failed after minting');
    }), /validation failed/);
    const n = await db.tx((_qc, oc) => nextNumber('CI-RB-', 'grns', 'grn_number', oc));
    assert.equal(n, 'CI-RB-0500');
  });

  test('different prefixes do not wait on each other', async () => {
    let letACommit;
    const aMayCommit = new Promise(r => { letACommit = r; });
    let aMinted;
    const aHasMinted = new Promise(r => { aMinted = r; });
    const a = db.tx(async (qc, oc) => {
      const n = await nextNumber('CI-HOLD-', 'grns', 'grn_number', oc);
      await qc(`INSERT INTO grns (grn_number) VALUES ($1)`, [n]);
      aMinted();
      await aMayCommit;
      return n;
    });
    await aHasMinted;
    // A still holds the CI-HOLD- lock; a gang run must not queue behind it.
    const b = await db.tx(async (qc, oc) => {
      const n = await nextRunNumber('CI-MRG-', oc);
      await qc(`INSERT INTO gang_runs (gang_number) VALUES ($1)`, [n]);
      return n;
    });
    assert.equal(b, 'CI-MRG-0001');
    letACommit();
    await a;
  });
});
