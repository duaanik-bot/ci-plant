// The plate movement ledger loads when somebody opens it — and not before.
//
// GET /plates/history is ~1 MB (1,261 movement rows on prod, 2026-09-17), and the
// Plates screen fetched it on open AND on every realtime change to any operations
// table, whatever tab was showing. Only the History tab draws it; the one other
// reader was that tab's count badge.
//
// So the badge asks GET /plates/history/count — LEAST(count, 2000) over the SAME
// joins, which is the number history.length always showed — and the rows load
// while the History tab is open. A tablet still running an old bundle keeps
// calling /plates/history with no parameter; that answer must not change by a
// byte, so the default SQL is pinned verbatim below and the slimmer gang_members
// is opt-in (?members=slim).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

// A pool that never touches a database: every statement is recorded and answered
// from `answer`, so the route handler runs for real and its SQL is what is checked.
const sent = [];
let answer = () => [];
pg.Pool.prototype.query = async function fakeQuery(text, params) {
  sent.push({ text, params });
  return { rows: answer(text, params) };
};
process.env.DATABASE_URL = 'postgresql://fake:fake@127.0.0.1:1/fake';
const { connect } = await import('./db.js');
await connect();
const plates = (await import('./routes/plates.js')).default;
const { HISTORY_GANG_MEMBERS_SLIM } = await import('./routes/plates.js');

const resolve = path => plates.stack.find(layer => layer.route?.methods?.get && layer.match(path));
const run = async (path, query = {}) => {
  const layer = resolve(path);
  assert.equal(layer?.route.path, path, `GET ${path} must be its own route`);
  let body;
  let failed;
  sent.length = 0;
  await layer.route.stack.at(-1).handle({ query, params: {} },
    { json: value => { body = value; }, status() { return this; } },
    error => { failed = error; });
  if (failed) throw failed;
  return body;
};

// What GET /plates/history sent on base ff94decc, captured through this same fake
// pool. Old bundles read this answer; it is the contract.
const HISTORY_SQL_BEFORE = `SELECT pam.*,pa.product_id,pa.asset_number,pa.component_label,pa.artwork_version,
        pm.plate_size,
        COALESCE(NULLIF(tr.specification->>'product_name',''),p.name) AS product_name,
        COALESCE(NULLIF(tr.specification->>'product_code',''),p.code) AS product_code,
        COALESCE(
  NULLIF(pa.output_number,''),
  NULLIF(tr.specification->>'output_number',''),
  CASE WHEN COALESCE((tr.specification->>'is_gang')::boolean,false)
       THEN NULL ELSE NULLIF(p.output_number,'') END) AS output_number,
        COALESCE((tr.specification->>'is_gang')::boolean,false) AS is_gang,
        tr.specification->'gang_members' AS gang_members,
        jc.jc_number,m.name AS machine_name
      FROM plate_asset_movements pam JOIN plate_assets pa ON pa.id=pam.plate_asset_id
      JOIN plate_masters pm ON pm.id=pa.plate_master_id JOIN products p ON p.id=pa.product_id
      LEFT JOIN tooling_requests tr ON tr.id=pam.tooling_request_id
      LEFT JOIN job_cards jc ON jc.id=pam.job_card_id LEFT JOIN machines m ON m.id=pam.machine_id
      ORDER BY pam.id DESC LIMIT 2000`;

const FULL_MEMBERS = "tr.specification->'gang_members' AS gang_members";
// FROM … up to ORDER BY (the ledger has one; a count has none).
const joinsOf = sql => {
  const end = sql.indexOf('ORDER BY');
  return sql.slice(sql.indexOf('FROM plate_asset_movements'), end < 0 ? undefined : end).trim();
};

// ── Server ──────────────────────────────────────────────────────────────────
test('an old bundle asking /plates/history gets exactly what it always got', async () => {
  const rows = [{ id: 9, asset_number: 'PL-9', gang_members: [{ product_name: 'A', customer_name: 'X', order_line_id: 4 }] }];
  answer = () => rows;
  const body = await run('/plates/history');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, HISTORY_SQL_BEFORE, 'the default statement must not change by a character');
  assert.deepEqual(sent[0].params, []);
  assert.equal(body, rows, 'and its rows go out untouched');
});

test('?members=slim changes the gang member list and nothing else', async () => {
  answer = () => [];
  await run('/plates/history', { members: 'slim' });
  assert.equal(sent.length, 1);
  assert.ok(HISTORY_SQL_BEFORE.includes(FULL_MEMBERS));
  assert.equal(sent[0].text,
    HISTORY_SQL_BEFORE.replace(FULL_MEMBERS, `${HISTORY_GANG_MEMBERS_SLIM} AS gang_members`));
  // Anything else stays the default — a typo must not half-slim a response.
  await run('/plates/history', { members: 'lean' });
  assert.equal(sent[0].text, HISTORY_SQL_BEFORE);
});

test('a slim member is still an OBJECT carrying the names and codes people read and search', () => {
  const slim = HISTORY_GANG_MEMBERS_SLIM;
  // gangMemberNames reads member.product_name; an array of bare strings would
  // print nothing. PlateProductIdentity reads members.length.
  assert.match(slim, /jsonb_agg\(jsonb_build_object\(/);
  // The DataTable search stringifies every value on the row — a member's codes
  // are what somebody types into it.
  for (const key of ['product_name', 'product_code', 'party_item_code', 'party_artwork_code']) {
    assert.match(slim, new RegExp(`'${key}', g\\.member->>'${key}'`), `${key} must survive`);
  }
  assert.match(slim, /WITH ORDINALITY/, 'members keep their order');
  assert.match(slim, /ORDER BY g\.ord/);
  // No gang_members, or one that is not a list, passes through as it was; an
  // empty list stays [] rather than becoming NULL (jsonb_agg of nothing).
  assert.match(slim, /jsonb_typeof\(tr\.specification->'gang_members'\) = 'array'/);
  assert.match(slim, /'\[\]'::jsonb/);
  assert.match(slim, /ELSE tr\.specification->'gang_members' END/);
});

test('the History badge counts what the ledger would show — same joins, same 2,000 cap', async () => {
  answer = () => [{ count: 1261 }];
  const body = await run('/plates/history/count');
  assert.deepEqual(body, { count: 1261 });
  assert.equal(sent.length, 1);
  const sql = sent[0].text;
  assert.match(sql, /SELECT LEAST\(count\(\*\), 2000\)::int AS count/);
  assert.equal(joinsOf(sql), joinsOf(HISTORY_SQL_BEFORE),
    'an inner join drops movements from the ledger; the badge must drop the same ones');
});

test('the count route sits after the history route, so the ledger\'s source slice still ends where it did', () => {
  const route = read('server/src/routes/plates.js');
  const history = route.indexOf("r.get('/plates/history'");
  const count = route.indexOf("r.get('/plates/history/count'");
  assert.ok(history >= 0 && count > history);
});

// ── Client ──────────────────────────────────────────────────────────────────
const page = () => read('client/src/components/PlatesLifecycle.jsx');
const loadBody = () => {
  const src = page();
  const at = src.indexOf('const load = async () => {');
  return src.slice(at, src.indexOf('\n  };', at));
};

test('opening Plates, and every realtime refresh, no longer pulls the ledger', () => {
  const load = loadBody();
  assert.doesNotMatch(load, /api\.get\('\/plates\/history'\)/,
    'the ~1 MB ledger must not ride along on every refresh of every tab');
  assert.match(load, /api\.get\('\/plates\/history\/count'\)/, 'the badge still gets its number');
  // …but a refresh WHILE the ledger is open — a realtime event, or load() after
  // an issue/retire/verify — must bring it up to date too.
  assert.match(load, /tabRef\.current === 'history' \? loadHistory\(\)/);
});

test('the History tab fetches its rows when it opens, slim, and drops a stale answer', () => {
  const src = page();
  assert.match(src, /useEffect\(\(\) => \{\s*if \(tab === 'history'\) loadHistory\(\)/);
  assert.match(src, /api\.get\('\/plates\/history\?members=slim'\)/);
  const at = src.indexOf('const loadHistory = async () => {');
  assert.ok(at >= 0);
  // The gate's own behaviour (a failed newer fetch must not veto an older success)
  // is tested in plates-history-newest-answer.test.js.
  assert.match(src.slice(at, src.indexOf('\n  };', at)), /historyGate\.current\.accept\(seq\)/,
    'two overlapping fetches must not let the older answer land last');
});

test('the badge number is the server count, not the length of rows nobody loaded', () => {
  const src = page();
  const at = src.indexOf("{ key: 'history', label: 'History'");
  const stage = src.slice(at, src.indexOf('},', at));
  assert.match(stage, /count: \(\) => historyCount/);
});
