// One-off migration: freeze the board that jobs already in the pipeline are
// holding, so the warehouse stops over-showing them.
//
//   DATABASE_URL=… node scripts/backfill-board-freeze.mjs                        # report
//   DATABASE_URL=… node scripts/backfill-board-freeze.mjs --apply --prod-i-mean-it
//
// WHY THIS EXISTS. Until the plan-lock freeze, locking a plan reserved nothing:
// "committed" on the warehouse screen was derived demand, not a claim. Every job
// locked before that change therefore holds no board at all. Switching the
// screen over without this would read tens of thousands of sheets as FREE that
// live jobs are already eating, and planners would promise them.
//
// WHAT IT WILL AND WILL NOT TOUCH. It writes board_allocations rows and nothing
// else — no stock_batches, no stock_movements, no order_lines. The shelf count,
// the sheets already issued to the floor and what each job needs are all
// somebody else's job to change. That is the plant owner's own condition on this
// work, and board-hold-origin.test.js enforces it in the application code.
//
// THE PREDICATE THAT MUST NOT BE OMITTED is the drawn-board exclusion.
// 'in_production' is a live status, so a naive query picks up jobs whose board
// has ALREADY left the warehouse. Freezing those double-counts them: `available`
// was reduced by the past draw, and a fresh active hold subtracts the same
// sheets again. That is the single biggest way this could disturb something
// already issued, which is the one thing the owner asked never to happen.
import pg from 'pg';
// ONE spelling of "drawn", imported rather than retyped.
//
// helpers.js exports BOARD_DRAWN_EXISTS precisely so a caller that aggregates by
// BOARD instead of by a list of line ids reuses the rule instead of copying it,
// and its own comment names the failure: "a second hand-written copy of this
// predicate is how 'drawn' starts meaning two different things." The leg every
// copy drops is the second one — a GANG or MERGE run's board is consumed against
// the RUN's parent card, which carries no order_line_id of its own (the
// GANG_ANCHOR_LINE trap), so matching only on jc.order_line_id = ol.id finds
// nothing for a run member and every member survives the exclusion.
// replenishment.js records what that omission cost on the live plant: six boards
// inflated by 18,082 sheets, and a red "+3,000 over" on a board the run had
// already emptied and paid for (CI-JC-0050 / CI-MRG-0001). There it only wronged
// a number on a screen. Here it would write the double-count into
// board_allocations, against the one thing the owner asked never to happen.
//
// Importing helpers.js pulls in server/src/db.js, whose only module-level effect
// is two pg type parsers (numeric and int8 arrive as JS numbers). It opens no
// connection — db.js connects only inside connect(), which nothing here calls —
// and every quantity below already goes through Number(), so it reads the same
// either way.
import { BOARD_DRAWN_EXISTS } from '../server/src/helpers.js';

const APPLY = process.argv.includes('--apply');
const MEANT = process.argv.includes('--prod-i-mean-it');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL. This script never guesses a database — a confident report\n'
    + 'about the wrong one is worse than no report.');
  process.exit(2);
}
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (APPLY && isRemote && !MEANT) {
  console.error('REFUSING: --apply against a REMOTE database also needs --prod-i-mean-it.');
  process.exit(2);
}

// ONE predicate, shared by the count, the listing and the write, so the report
// and the apply can never describe different sets of rows.
const CANDIDATES = `
  SELECT ol.id,
         ol.status,
         COALESCE(ol.parent_sheets_required, ol.sheets_required) AS need,
         COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS material_id,
         p.name AS product_name,
         o.po_number,
         c.name AS customer_name
    FROM order_lines ol
    JOIN products  p ON p.id = ol.product_id
    JOIN orders    o ON o.id = ol.order_id
    JOIN customers c ON c.id = o.customer_id
   WHERE ol.status IN ('planned','ready','in_production')
     AND COALESCE(ol.parent_sheets_required, ol.sheets_required) > 0
     AND COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) IS NOT NULL
     -- The parking board is a real row named 'Unspecified board', NOT the
     -- lowest-id board. Resolving it by id clears exactly the rows to keep.
     -- Qualified category='board' the way helpers.placeholderBoardId qualifies
     -- it, so a material named e.g. 'Unspecified ink' cannot join the set. Every
     -- name match is excluded rather than the first — this plant carries TWO
     -- placeholder boards and both are parking, not planning.
     AND COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
         NOT IN (SELECT id FROM materials WHERE category = 'board' AND name ILIKE '%unspecified%')
     -- Already drawn: the sheets are on the floor and out of \`available\`.
     -- Freezing them would bill the same board twice. Both legs — the plain card
     -- and the gang run's parent card — come from helpers.BOARD_DRAWN_EXISTS.
     AND NOT ${BOARD_DRAWN_EXISTS}
     -- Anything already holding board is either a mix, a hand commit or an
     -- organic freeze. All three are current; leave them alone.
     AND NOT EXISTS (
       SELECT 1 FROM board_allocations ba
        WHERE ba.order_line_id = ol.id AND ba.status = 'active' AND ba.source = 'stock')
   ORDER BY ol.planned_date NULLS LAST, o.delivery_date, ol.id`;

const c = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await c.connect();
try {
  // The body lives in a function so a refusal can `return` instead of calling
  // process.exit() from inside the try — an exit there skips the finally and
  // drops the socket without c.end(), which is exactly what you do not do to a
  // PgBouncer-fronted database.
  await report(c);
} catch (e) {
  console.error('FAILED:', e.message);
  try { await c.query('ROLLBACK'); } catch {}
  process.exitCode = 1;
} finally {
  await c.end();
}

async function report(c) {
  await c.query('BEGIN');

  console.log(isRemote ? '*** REMOTE DATABASE ***' : 'local database');
  console.log(APPLY ? 'mode: APPLY (will write)' : 'mode: REPORT (writes nothing)\n');

  const { rows: candidates } = await c.query(CANDIDATES);

  // Free stock per board, read once: available − the RAW sum of active stock
  // holds. Deliberately uncapped, and so NOT identical to boardPosition(), which
  // caps each line's hold at that line's own need and routes the surplus to
  // over_held. The two agree whenever over_held is 0; where they differ this one
  // reads LESS free, so an over-held board makes the back-fill freeze less than
  // the app would allow. Under-freezing is recoverable by hand; over-freezing
  // promises a planner board that is not there.
  const ids = [...new Set(candidates.map(r => r.material_id))];
  const { rows: boards } = await c.query(
    `SELECT m.id, m.name,
            COALESCE((SELECT SUM(qty) FROM stock_batches sb
                       WHERE sb.material_id=m.id AND sb.status='available'), 0) AS available,
            COALESCE((SELECT SUM(qty) FROM board_allocations ba
                       WHERE ba.material_id=m.id AND ba.status='active' AND ba.source='stock'), 0) AS held
       FROM materials m WHERE m.id = ANY($1)`, [ids]);
  const free = new Map(boards.map(b => [b.id, Math.max(0, Number(b.available) - Number(b.held))]));
  const name = new Map(boards.map(b => [b.id, b.name]));

  // Walk in the same order the board panel lists claimants — planned date, then
  // delivery date, then id — so the jobs the plant would serve first are the
  // jobs that get the board. Cap per board as we go.
  const plan = [];
  // Candidates the walk left with nothing. They are not written — but the SHORT
  // total below is partly theirs, and a sheet count with no job names behind it
  // is not something the owner can act on. They are listed, at want 0.
  const starved = [];
  let shortfall = 0;
  for (const r of candidates) {
    const budget = free.get(r.material_id) ?? 0;
    const want = Math.min(Number(r.need), budget);
    if (want > 0) {
      plan.push({ ...r, want });
      free.set(r.material_id, budget - want);
    } else {
      starved.push({ ...r, want: 0 });
    }
    const missed = Number(r.need) - want;
    if (missed > 0) shortfall += missed;
  }

  console.log(`candidate jobs      : ${candidates.length}`);
  console.log(`would freeze        : ${plan.length} jobs`);
  console.log(`no board free       : ${starved.length} jobs`);
  console.log(`sheets frozen       : ${plan.reduce((s, x) => s + x.want, 0)}`);
  console.log(`sheets SHORT        : ${shortfall}  <- these need a PR or an alternate board\n`);

  const byBoard = new Map();
  for (const p of [...plan, ...starved]) {
    if (!byBoard.has(p.material_id)) byBoard.set(p.material_id, []);
    byBoard.get(p.material_id).push(p);
  }
  for (const [mid, rows] of byBoard) {
    const frozen = rows.reduce((s, x) => s + x.want, 0);
    const short = rows.reduce((s, x) => s + (Number(x.need) - x.want), 0);
    console.log(`${name.get(mid)} — ${rows.length} job(s), ${frozen} sheets`
      + (short > 0 ? `, ${short} SHORT` : ''));
    for (const x of rows) {
      console.log(`   ${String(x.po_number || '').padEnd(14)} ${String(x.customer_name || '').slice(0, 20).padEnd(22)}`
        + `${String(x.product_name).slice(0, 30).padEnd(32)} ${String(x.want).padStart(7)}`
        + (x.want === 0 ? `  (NOTHING FREE — short ${Number(x.need)})`
          : x.want < Number(x.need) ? `  (short ${Number(x.need) - x.want})` : ''));
    }
  }

  // Refuse a runaway. This is meant to cover a pipeline of order tens to low
  // hundreds. If it ever matches thousands, the candidate query has stopped
  // discriminating and a human must look before anything is written.
  if (plan.length > 1000) {
    console.error(`\nREFUSING: ${plan.length} jobs is far more than this plant's pipeline. Check the query.`);
    await c.query('ROLLBACK');
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    await c.query('ROLLBACK');
    console.log('\nreport only — nothing written. Re-run with --apply --prod-i-mean-it.');
  } else {
    // The reversal key is created_by, NOT origin.
    //
    // origin='plan_lock' is byte-identical on a back-fill row and on every
    // organic freeze the engine writes afterwards. A reversal keyed on origin
    // alone, run a week later, would dismantle the entire reservation system
    // instead of this migration. The stamp is what makes "one statement
    // reverses it" true rather than merely short.
    const stamp = `board-freeze back-fill ${new Date().toISOString().slice(0, 10)}`;

    const ids = [];
    for (const p of plan) {
      const { rows: [row] } = await c.query(
        `INSERT INTO board_allocations
           (material_id, order_line_id, qty, source, status, reason, created_by, origin)
         VALUES ($1,$2,$3,'stock','active',$4,$5,'plan_lock') RETURNING id`,
        [p.material_id, p.id, p.want,
         `Back-filled: board this job was already planned against`, stamp]);
      ids.push(row.id);
    }

    if (ids.length !== plan.length) {
      console.error(`\nREFUSING: wrote ${ids.length} rows but planned ${plan.length}.`);
      await c.query('ROLLBACK');
      process.exitCode = 1;
      return;
    }

    await c.query('COMMIT');
    console.log(`\napplied: ${ids.length} holds written, stamped "${stamp}".`);
    console.log(`manifest: ${ids.join(',')}`);
    console.log('\nTO REVERSE THE WHOLE BACK-FILL, and nothing else:\n');
    console.log(`  UPDATE board_allocations`);
    console.log(`     SET status='released', released_at=now(), released_by='back-fill reversal',`);
    console.log(`         release_reason='board-freeze back-fill reversed'`);
    console.log(`   WHERE origin='plan_lock' AND created_by='${stamp}' AND status='active';`);
    console.log('\nThe status=\'active\' clause is NOT optional: without it the reversal');
    console.log('un-consumes board that has already physically left the building.');
  }
}
