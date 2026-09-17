// The plate warehouse's "Issue to job card" picker, and why it has its own route.
//
// The picker shows `jc_number · product_name` for every card that is not closed.
// It used to get them from GET /job-cards — the whole register, ~1.6 MB, with
// every stage row, the readiness pass, board and plate stamping — once per open
// of the warehouse, to read three fields off ~220 rows. GET /job-cards/open-picker
// answers the same question in ~25 KB.
//
// Same list, same order, same text — proved on live prod 2026-09-17: the lean
// query and JC_VIEW filtered to non-closed cards returned the same 223 rows with
// the same md5 over `id|jc_number|product_name|status` ordered id DESC. What can
// make them drift is pinned below: the joins that decide WHICH cards exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

// A pool that never touches a database: every statement is recorded and answered
// from `answer`, so a route handler runs for real and the SQL it sends is what
// the test inspects.
const sent = [];
let answer = () => [];
pg.Pool.prototype.query = async function fakeQuery(text, params) {
  sent.push({ text, params });
  return { rows: answer(text, params) };
};
process.env.DATABASE_URL = 'postgresql://fake:fake@127.0.0.1:1/fake';
const { connect } = await import('./db.js');
await connect();
const production = (await import('./routes/production.js')).default;
const { JOB_CARD_PICKER_SQL } = await import('./routes/production.js');
const helpers = await import('./helpers.js');

const getLayers = router => router.stack.filter(layer => layer.route?.methods?.get);
// The route Express would actually run for this path — the FIRST GET layer
// whose pattern matches, exactly as the router walks its stack.
const resolve = (router, path) => getLayers(router).find(layer => layer.match(path));

const run = async (router, path, req = {}) => {
  const layer = resolve(router, path);
  let body;
  let failed;
  await layer.route.stack.at(-1).handle(
    { query: {}, params: {}, ...req },
    { json: value => { body = value; }, status() { return this; } },
    error => { failed = error; },
  );
  if (failed) throw failed;
  return body;
};

test('/job-cards/open-picker is its own route, not a job card called "open-picker"', () => {
  // Registered after /job-cards/:id it would reach `WHERE jc.id=$1` with the
  // text 'open-picker', Postgres would refuse the integer cast, the route would
  // 500, and the warehouse's tolerant .catch would quietly empty the picker.
  const layer = resolve(production, '/job-cards/open-picker');
  assert.equal(layer?.route.path, '/job-cards/open-picker');
  assert.equal(resolve(production, '/job-cards/42').route.path, '/job-cards/:id',
    'a real card id still reaches the card');
});

test('the picker hands back exactly the rows its query returns', async () => {
  const rows = [
    { id: 391, jc_number: 'CI-JC-0391', product_name: 'Carton A', status: 'open' },
    { id: 388, jc_number: 'CI-JC-0388', product_name: 'CI-GANG-0051', status: 'split' },
  ];
  sent.length = 0;
  answer = () => rows;
  const body = await run(production, '/job-cards/open-picker');
  assert.deepEqual(body, rows);
  assert.equal(sent.length, 1, 'one statement — no stages, no readiness pass, no stamping');
  assert.equal(sent[0].text, JOB_CARD_PICKER_SQL);
});

// JC_VIEW's own source text — the body of `const JC_VIEW = \`…\`;`.
const jcViewSource = () => {
  const src = read('server/src/routes/production.js');
  const at = src.indexOf('const JC_VIEW = `');
  return src.slice(at, src.indexOf('`;', at));
};
// Top-level joins only: the view's FROM list sits at two spaces; joins inside a
// LATERAL body are indented deeper and cannot drop an outer row.
const topLevelJoins = source => source.split('\n')
  .filter(line => /^ {2}(FROM job_cards|(LEFT )?JOIN)/.test(line))
  .map(line => line.trim());

test('the picker decides WHICH cards exist by the same joins the register does', () => {
  const view = topLevelJoins(jcViewSource());
  const inner = view.filter(line => !line.startsWith('LEFT '));
  assert.deepEqual(inner, [
    'FROM job_cards jc',
    'JOIN products p ON p.id = jc.product_id',
    'JOIN materials bm ON bm.id = p.board_material_id',
  ], 'JC_VIEW gained or lost a row-dropping join — the picker must follow it');
  const picker = topLevelJoins(JOB_CARD_PICKER_SQL);
  assert.deepEqual(picker, inner,
    'an inner join drops a card with no product or board; the picker must drop exactly the same ones');
  // Every other join in the view is LEFT onto a key or a one-row LATERAL, so it
  // can neither drop nor repeat a card. The interpolated ones are LEFT too:
  for (const name of ['GANG_ANCHOR_LINE', 'GANG_RUN_MATES_LATERAL', 'BOARD_MIX_POSITION_LATERAL', 'MIX_CUTS_LATERAL']) {
    assert.match(helpers[name], /^\s*LEFT JOIN LATERAL/, `${name} must stay a LEFT join`);
    assert.doesNotMatch(helpers[name], /^ {0,2}JOIN /m, `${name} must not add a top-level inner join`);
  }
});

test('the picker keeps split cards, drops closed ones, newest first, and carries four fields', () => {
  const sql = JOB_CARD_PICKER_SQL;
  assert.match(sql, /SELECT jc\.id, jc\.jc_number, p\.name AS product_name, jc\.status\s/,
    'product_name is p.name, the same column JC_VIEW names it by');
  // `<>` and the client's `!== 'closed'` agree only because job_cards.status is
  // NOT NULL DEFAULT 'open' (checked on prod). A NULL status would pass JS and fail SQL.
  assert.match(sql, /WHERE jc\.status <> 'closed'/);
  assert.doesNotMatch(sql, /split/, 'a split card is still a job you can issue plates to');
  // The register orders `(jc.status='closed'), jc.id DESC`; with closed rows gone
  // that is id DESC.
  assert.match(sql, /ORDER BY jc\.id DESC\s*$/);
});

test('the plate warehouse reads the picker, not the register', () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  assert.doesNotMatch(page, /api\.get\('\/job-cards'\)/,
    'the whole register (1.6 MB) must not load to fill one dropdown');
  const at = page.indexOf("api.get('/job-cards/open-picker')");
  assert.ok(at >= 0, 'the issue picker fetches /job-cards/open-picker');
  const call = page.slice(at, page.indexOf(';', at));
  assert.match(call, /row\.status !== 'closed'/, 'the client-side belt stays');
  assert.match(call, /\.catch\(\(\) => setOpenJobs\(\[\]\)\)/,
    'a login without Job Cards still opens the warehouse');
});
