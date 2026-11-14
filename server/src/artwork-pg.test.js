import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The artwork register through the REAL app against a real Postgres (Artwork Manager P1): the office AVS files artwork
// mails into avs.artwork_intake, CI Plant copies them into the register, and the Artwork page reads it. Invented names,
// codes and addresses throughout.
//
// Opt-in: boots its OWN throwaway Postgres in a temp dir on a free port, PG_POOL_MAX=1.
//
//   ARTWORK_PG=1 node --test src/artwork-pg.test.js

const ENABLED = process.env.ARTWORK_PG === '1';
const ROBOT_KEY = 'test-robot-key-0000';
const BOX = 'office@plant.test';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

describe('Artwork register — through the real app', {
  skip: ENABLED ? false : 'set ARTWORK_PG=1 to boot a throwaway Postgres',
}, () => {
  let epg, dir, db, server, base;
  const tokens = {};

  before(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwork-pg-'));
    const port = await freePort();
    epg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
    await epg.initialise();
    await epg.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.PG_POOL_MAX = '1';
    db = await import('./db.js');
    await db.connect();
    await db.init();
    const { seedIfEmpty } = await import('./seed.js');
    await seedIfEmpty();
    // AVS lives only on production; here, just what the intake needs.
    await db.q(`CREATE SCHEMA IF NOT EXISTS avs`);
    await db.q(`CREATE TABLE IF NOT EXISTS avs.settings (key text PRIMARY KEY, value text, note text)`);
    await db.q(`INSERT INTO avs.settings (key, value) VALUES ('robot_key', $1)`, [ROBOT_KEY]);
    await db.q(fs.readFileSync(new URL('../../supabase/migrations/20261115100100_avs_artwork_intake.sql', import.meta.url), 'utf8'));
    await db.q(`INSERT INTO customers (name, segment) VALUES ('Example Pharma Ltd', 'pharma')`);

    const { default: jwt } = await import('jsonwebtoken');
    const { JWT_SECRET: secret } = await import('./auth.js');
    const mk = async (key, role, modules) => {
      const u = await db.one(`INSERT INTO users (name, email, password_hash, role, modules) VALUES ($1, $2, 'x', $3, $4) RETURNING id, name, role`,
        [`Art ${key}`, `art-${key}@test.local`, role, modules && JSON.stringify(modules)]);
      tokens[key] = jwt.sign({ id: u.id, name: u.name, role: u.role }, secret);
    };
    await mk('admin', 'admin', null);
    await mk('artist', 'planner', ['artwork']);
    await mk('plain', 'dispatch', ['dispatch']);

    const { default: app } = await import('./app.js');
    server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    server?.close();
    try { await (await db?.connect())?.end(); } catch {}
    try { await epg?.stop(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const fileMails = async list => (await db.one('SELECT avs.file_artwork_mails($1::jsonb) AS out', [JSON.stringify(list)])).out;
  const code = async fn => { try { await fn(); return null; } catch (e) { return e.code; } };

  // ── Task 2: the register's tables ─────────────────────────────────────────────────────────────────────────────
  test('the five register tables exist after init()', async () => {
    for (const t of ['artwork_mails', 'artwork_jobs', 'artwork_versions', 'artwork_files', 'artwork_events']) {
      assert.ok((await db.one(`SELECT to_regclass($1) AS r`, [`public.${t}`])).r, `${t} is missing`);
    }
  });

  test('a version is unique by job, revision and receipt number, and has only the P1 statuses', async () => {
    const job = await db.one(`INSERT INTO artwork_jobs (job_no, job_key, customer_name) VALUES ('CI-AW-T001', 't|schema', 'T') RETURNING id`);
    const add = (rev, n, status = 'received') => db.q(
      `INSERT INTO artwork_versions (job_id, client_rev, receipt_no, label, status) VALUES ($1, $2, $3, 'x', $4)`, [job.id, rev, n, status]);
    await add('R0', 1);
    assert.equal(await code(() => add('R0', 1)), '23505');
    await add('R0', 2);
    await add('', 1);
    assert.equal(await code(() => add('', 1)), '23505');
    assert.equal(await code(() => add('R1', 1, 'approved')), '23514');
    await db.q(`DELETE FROM artwork_versions WHERE job_id = $1`, [job.id]);
    await db.q(`DELETE FROM artwork_jobs WHERE id = $1`, [job.id]);
  });

  // ── Task 3: avs.artwork_intake and avs.file_artwork_mails ─────────────────────────────────────────────────────
  test('AVS files a run\'s artwork mails in one call; a mail filed before is left alone', async () => {
    const mails = [
      { mailbox_email: ' Office@Plant.Test ', gmail_message_id: 'f-001', subject: 'one', items: [{ client_item_code: 'PCS-X900' }] },
      { mailbox_email: BOX, gmail_message_id: 'f-002', subject: 'two', kind: 'to_sort' },
    ];
    const first = await fileMails(mails);
    assert.deepEqual(first.map(r => r.filed), [true, true]);
    assert.ok(first.every(r => Number(r.intake_id) > 0));
    const again = await fileMails(mails);
    assert.deepEqual(again.map(r => r.filed), [false, false]);
    const rows = await db.q(`SELECT mailbox_email, kind, status, items FROM avs.artwork_intake WHERE gmail_message_id IN ('f-001', 'f-002') ORDER BY gmail_message_id`);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].mailbox_email, BOX);
    assert.deepEqual(rows.map(r => r.kind), ['artwork', 'to_sort']);
    assert.deepEqual(rows.map(r => r.status), ['new', 'new']);
    assert.deepEqual(rows[1].items, []);
    // one object alone is a list of one
    const single = await fileMails({ mailbox_email: BOX, gmail_message_id: 'f-003' });
    assert.deepEqual(single.map(r => r.filed), [true]);
    await db.q(`DELETE FROM avs.artwork_intake WHERE gmail_message_id IN ('f-001', 'f-002', 'f-003')`);
  });

  // ── Task 4: the copier, avs.artwork_intake → the register ─────────────────────────────────────────────────────
  const sync = async () => (await import('./artwork-intake.js')).syncIntakeArtwork();
  const intake = id => db.one('SELECT status, result FROM avs.artwork_intake WHERE gmail_message_id = $1', [id]);
  const f = (name, sha, extra = {}) => ({ file_name: name, size_bytes: 1000, sha256: sha, drive_file_id: `drv-${sha}`, drive_url: `https://drive.test/${sha}`, ...extra });
  const mailOf = (id, items, over = {}) => ({
    mailbox_email: BOX, gmail_message_id: id, gmail_thread_id: `t-${id}`, subject: `Artwork ${id}`, from_name: 'Asha Rao',
    from_email: 'artwork@example-pharma.test', received_at: '2026-11-10T09:00:00Z', body_text: 'Please find the artwork.',
    view_url: `https://mail.google.com/mail/u/0/#all/${id}`, customer_name: 'example pharma ltd', items, ...over,
  });
  const versionsOf = async code => db.q(`
    SELECT v.id, v.label, v.status, v.source_print, v.variant, j.job_no, j.to_sort, j.customer_name, j.customer_id, j.product_id, j.pack_type
      FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id WHERE j.client_item_code = $1 ORDER BY v.id`, [code]);

  test('the same code and revision with different bytes are two versions, R0.1 and R0.2 — nothing is overwritten', async () => {
    await fileMails([mailOf('a-001', [{ client_item_code: 'PCS-X101', client_rev: 'R0', product_name: 'ALPHA 10 TAB CARTON', pack_type: 'carton', files: [f('PCS-X101-R0.cdr', 'aa01'), f('PCS-X101-R0.pdf', 'aa02')] }])]);
    const out1 = await sync();
    assert.equal(out1.filed.length, 1);
    await fileMails([mailOf('a-002', [{ client_item_code: 'PCS-X101', client_rev: 'R0', product_name: 'ALPHA-NEW 10 TAB CARTON', files: [f('PCS-X101-R0.cdr', 'bb01'), f('PCS-X101-R0.pdf', 'bb02')] }], { received_at: '2026-11-12T09:00:00Z' })]);
    await sync();
    const vs = await versionsOf('PCS-X101');
    assert.deepEqual(vs.map(v => v.label), ['R0.1', 'R0.2']);
    assert.deepEqual(vs.map(v => v.source_print), ['aa01|aa02', 'bb01|bb02']);
    assert.equal(new Set(vs.map(v => v.job_no)).size, 1);
    assert.match(vs[0].job_no, /^CI-AW-\d{4}$/);
    assert.equal(vs[0].customer_name, 'Example Pharma Ltd');   // resolved to the customer master
    assert.ok(vs[0].customer_id);
    assert.equal(vs[0].pack_type, 'carton');
    const files = await db.q(`SELECT file_name, ext, sha256, drive_file_id FROM artwork_files WHERE version_id = $1 ORDER BY id`, [vs[0].id]);
    assert.deepEqual(files.map(x => x.ext), ['cdr', 'pdf']);
    assert.equal(files[0].drive_file_id, 'drv-aa01');
    assert.deepEqual((await intake('a-002')).result.versions, ['R0.2']);
  });

  test('the same bytes sent again are not a new version: the mail joins that version\'s history', async () => {
    await fileMails([mailOf('a-003', [{ client_item_code: 'PCS-X101', client_rev: 'R0', files: [f('reminder copy.pdf', 'aa02'), f('reminder copy.cdr', 'aa01')] }], { subject: 'REMINDER' })]);
    await sync();
    const vs = await versionsOf('PCS-X101');
    assert.equal(vs.length, 2);
    assert.equal((await db.q(`SELECT 1 FROM artwork_mails WHERE gmail_message_id IN ('a-001', 'a-002', 'a-003')`)).length, 3);
    const ev = await db.q(`SELECT e.action, e.version_id FROM artwork_events e JOIN artwork_mails m ON m.id = e.mail_id WHERE m.gmail_message_id = 'a-003'`);
    assert.deepEqual(ev, [{ action: 'received_again', version_id: vs[0].id }]);
    assert.equal((await intake('a-003')).status, 'filed');
  });

  test('a mail AVS could not classify is filed "to sort", never dropped — with or without items', async () => {
    await fileMails([
      mailOf('a-004', [{ product_name: 'something attached', files: [f('scan0001.pdf', 'cc01')] }], { kind: 'to_sort', subject: 'Fwd: pls see' }),
      mailOf('a-005', [], { subject: 'kit artwork final' }),
    ]);
    await sync();
    const jobs = await db.q(`SELECT j.job_no, j.to_sort, j.product_name, v.label, v.status FROM artwork_jobs j JOIN artwork_versions v ON v.job_id = j.id
                              JOIN artwork_mails m ON m.id = v.first_mail_id WHERE m.gmail_message_id IN ('a-004', 'a-005') ORDER BY j.id`);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every(j => j.to_sort === true));
    assert.equal(jobs[1].product_name, 'kit artwork final');
    assert.equal(jobs[0].label, 'v1');
    assert.deepEqual([(await intake('a-004')).status, (await intake('a-005')).status], ['filed', 'filed']);
  });

  test('artwork sent only as a link is a version waiting for its file, with the link kept', async () => {
    await fileMails([mailOf('a-006', [{ client_item_code: 'PCS-X202', client_rev: 'R1', product_name: 'BETA RANGE CARTON', links: ['https://files.example.test/sites/art/batch-7'] }])]);
    await sync();
    const [v] = await versionsOf('PCS-X202');
    assert.equal(v.status, 'file_to_fetch');
    assert.equal(v.label, 'R1.1');
    assert.equal(v.to_sort, false);
    const files = await db.q(`SELECT link_url, sha256, drive_file_id FROM artwork_files WHERE version_id = $1`, [v.id]);
    assert.deepEqual(files, [{ link_url: 'https://files.example.test/sites/art/batch-7', sha256: null, drive_file_id: null }]);
    // a second link-only mail for the same revision cannot be told apart by bytes: it is the next receipt
    await fileMails([mailOf('a-007', [{ client_item_code: 'PCS-X202', client_rev: 'R1', links: ['https://files.example.test/sites/art/batch-8'] }])]);
    await sync();
    assert.deepEqual((await versionsOf('PCS-X202')).map(x => x.label), ['R1.1', 'R1.2']);
  });

  test('one mail carrying five jobs is five jobs, one mail, one alert; batch artwork is marked', async () => {
    const { notifyNewArtwork } = await import('./artwork-intake.js');
    await notifyNewArtwork();                                   // clear what earlier tests filed
    const items = [1, 2, 3, 4, 5].map(n => ({ files: [f(`PMC-X30${n}-R0 - GAMMA ${n} - Carton.cdr`, `dd0${n}`)], ...(n === 5 ? { variant: 'batch' } : {}) }));
    await fileMails([mailOf('a-008', items)]);
    await sync();
    const jobs = await db.q(`SELECT j.client_item_code, j.pack_type, v.label, v.variant FROM artwork_jobs j JOIN artwork_versions v ON v.job_id = j.id
                              WHERE j.client_item_code LIKE 'PMC-X30%' ORDER BY j.client_item_code`);
    assert.deepEqual(jobs.map(j => j.client_item_code), ['PMC-X301', 'PMC-X302', 'PMC-X303', 'PMC-X304', 'PMC-X305']);
    assert.ok(jobs.every(j => j.label === 'R0.1' && j.pack_type === 'carton'));   // read from the file names
    assert.equal(jobs[4].variant, 'batch');
    assert.equal((await db.q(`SELECT 1 FROM artwork_mails WHERE gmail_message_id = 'a-008'`)).length, 1);
    const told = await notifyNewArtwork();
    assert.equal(told.announced, 1);
    assert.ok(told.users >= 2);                                 // admin + the Artwork tick; not the dispatch login
    const bell = await db.one(`SELECT title, link FROM notifications WHERE ref_table = 'artwork_mails' ORDER BY id DESC LIMIT 1`);
    assert.equal(bell.title, 'New artwork: Example Pharma Ltd — 5 items');
    assert.equal(bell.link, '/artwork?tab=register');
    assert.equal((await notifyNewArtwork()).announced, 0);      // announced once
  });

  test('a job whose code AVS has mapped to exactly one product is linked to it; two candidates leave it for a person', async () => {
    const [p1, p2] = await db.q(`SELECT id, name FROM products ORDER BY id LIMIT 2`);
    await db.q(`CREATE TABLE IF NOT EXISTS avs.artwork_codes (id serial PRIMARY KEY, product_id integer, item_code text)`);
    await db.q(`INSERT INTO avs.artwork_codes (product_id, item_code) VALUES ($1, 'pcs-x401'), ($1, 'PCS-X401'), ($1, 'PCS-X402'), ($2, 'PCS-X402')`, [p1.id, p2.id]);
    await fileMails([mailOf('a-009', [{ client_item_code: 'PCS-X401', client_rev: 'R0', files: [f('one.cdr', 'ee01')] }, { client_item_code: 'PCS-X402', client_rev: 'R0', files: [f('two.cdr', 'ee02')] }])]);
    await sync();
    assert.equal((await versionsOf('PCS-X401'))[0].product_id, p1.id);
    assert.equal((await db.one(`SELECT product_name FROM artwork_jobs WHERE client_item_code = 'PCS-X401'`)).product_name, p1.name);
    assert.equal((await versionsOf('PCS-X402'))[0].product_id, null);
  });

  test('a size AVS wrote as words, or an item that is not an object, does not stop a mail being filed', async () => {
    await fileMails([mailOf('a-010', [{ client_item_code: 'PCS-X501', files: [{ file_name: 'big.cdr', sha256: 'ff01', size_bytes: '4.1 MB', drive_file_id: 'd1' }] }, null, 'oops'])]);
    await sync();
    assert.equal((await intake('a-010')).status, 'filed');
    const [v] = await versionsOf('PCS-X501');
    assert.equal((await db.one(`SELECT size_bytes FROM artwork_files WHERE version_id = $1`, [v.id])).size_bytes, null);
  });

  test('a mail whose items cannot be written is still put in front of a person, "to sort", with the reason — and the rows after it are filed', async () => {
    await db.q(`CREATE FUNCTION pg_temp_explode() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.file_name = 'explode.cdr' THEN RAISE EXCEPTION 'test: this file cannot be written'; END IF; RETURN NEW; END $f$`);
    await db.q(`CREATE TRIGGER explode BEFORE INSERT ON artwork_files FOR EACH ROW EXECUTE FUNCTION pg_temp_explode()`);
    await fileMails([
      mailOf('a-010b', [{ client_item_code: 'PCS-X503', files: [f('explode.cdr', 'ff03')] }], { subject: 'Artwork that breaks' }),
      mailOf('a-011', [{ client_item_code: 'PCS-X502', files: [f('good.cdr', 'ff02')] }]),
    ]);
    const out = await sync();
    await db.q(`DROP TRIGGER explode ON artwork_files`);
    const bad = await intake('a-010b');
    assert.equal(bad.status, 'filed');
    assert.match(bad.result.problem, /cannot be written/);
    assert.equal((await versionsOf('PCS-X503')).length, 0);       // nothing half-written under the real job
    const job = await db.one(`SELECT j.to_sort, j.product_name, v.status, e.detail FROM artwork_mails m JOIN artwork_versions v ON v.first_mail_id = m.id
                                JOIN artwork_jobs j ON j.id = v.job_id JOIN artwork_events e ON e.version_id = v.id WHERE m.gmail_message_id = 'a-010b'`);
    assert.equal(job.to_sort, true);
    assert.equal(job.product_name, 'Artwork that breaks');
    assert.equal(job.status, 'file_to_fetch');
    assert.match(job.detail.problem, /cannot be written/);
    assert.equal((await intake('a-011')).status, 'filed');
    assert.equal(out.filed.length, 2);
  });

  test('in a mail of several items, one without a code is never filed under the code in the subject', async () => {
    await fileMails([mailOf('a-013', [
      { files: [f('PCS-X701-R0 - EPSILON CARTON.cdr', 'hh01')] },
      { files: [f('scan of leaflet.pdf', 'hh02')] },
    ], { subject: 'RE: PCS-X701 EPSILON artwork' })]);
    await sync();
    const vs = await versionsOf('PCS-X701');
    assert.deepEqual(vs.map(v => v.source_print), ['hh01']);
    const stray = await db.one(`SELECT j.to_sort, j.client_item_code FROM artwork_files f JOIN artwork_versions v ON v.id = f.version_id JOIN artwork_jobs j ON j.id = v.job_id WHERE f.sha256 = 'hh02'`);
    assert.deepEqual(stray, { to_sort: true, client_item_code: null });
  });

  test('an address that is not a web link is never stored as one', async () => {
    await fileMails([mailOf('a-014', [{ client_item_code: 'PCS-X801', links: ['javascript:alert(1)', 'https://files.example.test/ok'],
      files: [{ file_name: 'a.cdr', sha256: 'ii01', drive_file_id: 'd9', drive_url: 'javascript:alert(2)' }] }], { view_url: 'javascript:alert(3)' })]);
    await sync();
    const [v] = await versionsOf('PCS-X801');
    const rows = await db.q(`SELECT link_url, drive_url FROM artwork_files WHERE version_id = $1 ORDER BY id`, [v.id]);
    assert.deepEqual(rows, [{ link_url: null, drive_url: null }, { link_url: 'https://files.example.test/ok', drive_url: null }]);
    assert.equal((await db.one(`SELECT view_url FROM artwork_mails WHERE gmail_message_id = 'a-014'`)).view_url, null);
  });

  test('the database\'s call is behind the robot key, and files what waits', async () => {
    const post = (key) => fetch(base + '/avs/robot/artwork-notify', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-avs-robot-key': key } : {}) }, body: '{}' });
    assert.equal((await post(null)).status, 401);
    assert.equal((await post('wrong')).status, 401);
    await (await import('./artwork-intake.js')).notifyNewArtwork();   // announce what earlier tests filed
    await fileMails([mailOf('a-012', [{ client_item_code: 'PCS-X601', client_rev: 'R0', files: [f('x.cdr', 'gg01')] }])]);
    const res = await post(ROBOT_KEY);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.filed.length, 1);
    assert.equal(body.alert.announced, 1);
    assert.equal((await versionsOf('PCS-X601')).length, 1);
  });

  // ── Task 5: the register, as the Artwork page reads it ────────────────────────────────────────────────────────
  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const jobOf = async code => (await db.one(`SELECT id FROM artwork_jobs WHERE client_item_code = $1`, [code])).id;

  test('the register is behind the Artwork tick, and lists each job with its latest version', async () => {
    assert.equal((await call('plain', 'GET', '/artwork/register')).status, 403);
    const list = await call('artist', 'GET', '/artwork/register');
    assert.equal(list.status, 200);
    const x101 = list.body.jobs.find(j => j.client_item_code === 'PCS-X101');
    assert.equal(x101.versions, 2);
    assert.equal(x101.latest.label, 'R0.2');
    assert.equal(x101.latest.status, 'received');
    assert.equal(x101.customer_name, 'Example Pharma Ltd');
    assert.equal(x101.to_sort, false);
    assert.ok(Number.isInteger(x101.waiting_days) && x101.waiting_days >= 0);
    assert.match(x101.job_no, /^CI-AW-\d{4}$/);
    // newest activity first
    const ids = list.body.jobs.map(j => j.latest.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  });

  test('the chips and the search narrow the list', async () => {
    const sort = (await call('artist', 'GET', '/artwork/register?status=to_sort')).body.jobs;
    assert.ok(sort.length >= 2 && sort.every(j => j.to_sort));
    const fetchIt = (await call('artist', 'GET', '/artwork/register?status=file_to_fetch')).body.jobs;
    assert.ok(fetchIt.some(j => j.client_item_code === 'PCS-X202') && fetchIt.every(j => j.latest.status === 'file_to_fetch'));
    const found = (await call('artist', 'GET', '/artwork/register?q=' + encodeURIComponent('  GAMMA   x303 '))).body.jobs;
    assert.deepEqual(found.map(j => j.client_item_code), ['PMC-X303']);
    assert.equal((await call('artist', 'GET', '/artwork/register?q=pcs-x601')).body.jobs.length, 1);
    assert.equal((await call('artist', 'GET', '/artwork/register?customer=' + encodeURIComponent('nobody at all'))).body.jobs.length, 0);
  });

  test('a job opens with every version, its files and every mail that carried it', async () => {
    const res = await call('artist', 'GET', `/artwork/register/${await jobOf('PCS-X101')}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.job.client_item_code, 'PCS-X101');
    assert.deepEqual(res.body.versions.map(v => v.label), ['R0.2', 'R0.1']);          // newest first
    const first = res.body.versions[1];
    assert.deepEqual(first.files.map(x => x.file_name), ['PCS-X101-R0.cdr', 'PCS-X101-R0.pdf']);
    assert.equal(first.files[0].drive_url, 'https://drive.test/aa01');
    assert.deepEqual(first.mails.map(m => m.subject), ['Artwork a-001', 'REMINDER']);   // sent, then sent again
    assert.match(first.mails[0].view_url, /a-001$/);
    assert.ok(res.body.events.some(e => e.action === 'received_again'));
    assert.equal((await call('artist', 'GET', '/artwork/register/99999999')).status, 404);
    assert.equal((await call('plain', 'GET', `/artwork/register/${await jobOf('PCS-X101')}`)).status, 403);
  });

  test('a "to sort" job is mapped to a product by a person, and leaves the to-sort list', async () => {
    const p = await db.one(`SELECT id, name FROM products ORDER BY id LIMIT 1`);
    const job = (await call('artist', 'GET', '/artwork/register?status=to_sort')).body.jobs[0];
    assert.equal((await call('artist', 'POST', `/artwork/register/${job.id}/map`, { product_id: 99999999 })).status, 400);
    const res = await call('artist', 'POST', `/artwork/register/${job.id}/map`, { product_id: p.id });
    assert.equal(res.status, 200);
    const after = (await call('artist', 'GET', `/artwork/register/${job.id}`)).body;
    assert.equal(after.job.to_sort, false);
    assert.equal(after.job.product_id, p.id);
    assert.equal(after.job.product_name, p.name);
    const ev = after.events.find(e => e.action === 'mapped');
    assert.equal(ev.by_name, 'Art artist');
    assert.equal((await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'artwork_job' AND entity_id = $1 AND action = 'map'`, [job.id])).n, 1);
  });

  test('a version that is not artwork is marked so with a reason, and can be put back', async () => {
    const v = (await versionsOf('PCS-X601'))[0];
    assert.equal((await call('artist', 'POST', `/artwork/register/versions/${v.id}/not-artwork`, { reason: '  ' })).status, 400);
    assert.equal((await call('plain', 'POST', `/artwork/register/versions/${v.id}/not-artwork`, { reason: 'x' })).status, 403);
    assert.equal((await call('artist', 'POST', `/artwork/register/versions/${v.id}/not-artwork`, { reason: 'A purchase order, not artwork' })).status, 200);
    assert.equal((await versionsOf('PCS-X601'))[0].status, 'not_artwork');
    const ev = await db.one(`SELECT detail, by_name FROM artwork_events WHERE version_id = $1 AND action = 'not_artwork'`, [v.id]);
    assert.equal(ev.detail.reason, 'A purchase order, not artwork');
    assert.equal((await call('artist', 'POST', `/artwork/register/versions/${v.id}/restore`)).status, 200);
    assert.equal((await versionsOf('PCS-X601'))[0].status, 'received');
    // a link-only version goes back to waiting for its file
    const link = (await versionsOf('PCS-X202'))[0];
    await call('artist', 'POST', `/artwork/register/versions/${link.id}/not-artwork`, { reason: 'test' });
    await call('artist', 'POST', `/artwork/register/versions/${link.id}/restore`);
    assert.equal((await versionsOf('PCS-X202'))[0].status, 'file_to_fetch');
  });

  test('a customer renamed in the master keeps its jobs: the next file for a code joins the job it had', async () => {
    await db.q(`UPDATE customers SET name = 'Example Pharma Limited' WHERE name = 'Example Pharma Ltd'`);
    await fileMails([mailOf('a-015', [{ client_item_code: 'PCS-X101', client_rev: 'R1', files: [f('PCS-X101-R1.cdr', 'jj01')] }], { customer_name: 'example pharma limited' })]);
    await sync();
    const vs = await versionsOf('PCS-X101');
    assert.deepEqual(vs.map(v => v.label), ['R0.1', 'R0.2', 'R1.1']);
    assert.equal(new Set(vs.map(v => v.job_no)).size, 1);
  });
});
