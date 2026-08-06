// Retire the Finished Goods & QC gate: release what is stranded behind it and
// clear the trailing qc stages so every job closes at Sort & Paste.
//
//   node scripts/bypass-fg-qc.mjs            dry run against $DATABASE_URL (default local)
//   node scripts/bypass-fg-qc.mjs --apply    write it
//
// RUN THIS ONLY AFTER THE CODE IS DEPLOYED. The app is what stops minting new
// qc stages; running the data fix first would close these jobs while the live
// build kept adding a qc hop to every new job card.
//
// Three populations, handled differently on purpose:
//
//   1. Pasting COMPLETED, qc still open. The goods are finished and sitting on
//      the floor behind a gate nobody runs. Nothing will ever re-fire the closer
//      for them — their pasting stage is already closed — so the release has to
//      be performed here: credit Finished Goods, move every sales order on the
//      card to 'produced', close the card. This is what puts them in Dispatch.
//
//   2. Pasting NOT completed. These are still upstream. Dropping the qc row is
//      enough — pasting becomes the last stage and the normal closer releases
//      them when the floor finishes the run.
//
//   3. A qc stage carrying stage_runs. Someone counted against it. It is NOT
//      deleted blind; it is reported and skipped so a human can decide.
//
// Completed qc stages are never touched — that history stays exactly as it is.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const USER = 'FG&QC bypass migration';

const num = n => Number(n || 0).toLocaleString('en-IN');
const client = new pg.Client({
  connectionString: url,
  ssl: /supabase|amazonaws|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
});

const skipped = [];
let released = 0, releasedQty = 0, dropped = 0;

await client.connect();
await client.query('BEGIN');
try {
  // Every open qc stage, with the state of its own job card and its pasting stage.
  const { rows: open } = await client.query(`
    SELECT qs.id AS qc_stage_id, qs.seq AS qc_seq,
           jc.id AS job_card_id, jc.jc_number, jc.status AS jc_status,
           jc.product_id, jc.order_line_id, jc.gang_run_id,
           ps.id AS paste_stage_id, ps.status AS paste_status, ps.qty_out AS paste_good,
           (SELECT COUNT(*)::int FROM stage_runs sr WHERE sr.job_stage_id=qs.id) AS qc_runs,
           (SELECT MAX(seq) FROM job_stages x WHERE x.job_card_id=jc.id) AS max_seq
    FROM job_stages qs
    JOIN job_cards jc ON jc.id = qs.job_card_id
    LEFT JOIN job_stages ps ON ps.job_card_id = jc.id AND ps.stage='pasting'
    WHERE qs.stage='qc' AND qs.status <> 'completed'
    ORDER BY jc.jc_number`);

  console.log(`\n${open.length} open qc stages\n`);

  for (const r of open) {
    // Guard 1 — someone counted against this qc stage. Leave it alone.
    if (r.qc_runs > 0) {
      skipped.push(`${r.jc_number}: qc stage has ${r.qc_runs} stage_run(s) — left in place`);
      continue;
    }
    // Guard 2 — qc must actually be the tail. If anything sits after it the
    // routing is not what this migration assumes.
    if (r.qc_seq !== r.max_seq) {
      skipped.push(`${r.jc_number}: qc is seq ${r.qc_seq} of ${r.max_seq} — not the last stage`);
      continue;
    }

    await client.query('DELETE FROM job_stages WHERE id=$1', [r.qc_stage_id]);
    dropped++;

    // Population 2 — still upstream. The floor will close it normally.
    if (r.paste_status !== 'completed') {
      console.log(`  ${r.jc_number}  qc stage dropped — pasting still ${r.paste_status || 'absent'}`);
      continue;
    }

    // Population 1 — finished and stranded. Release it, exactly as the closer
    // in routes/production.js would have.
    const good = Number(r.paste_good || 0);
    const { rows: [tot] } = await client.query(
      `SELECT COALESCE(SUM(qty_scrap),0)::int AS s FROM job_stages WHERE job_card_id=$1`, [r.job_card_id]);

    await client.query(`
      UPDATE job_cards SET status='closed', qty_produced=$1, qty_scrap=$2,
             fg_location=COALESCE(fg_location,'FG-STORE'), closed_at=now()
      WHERE id=$3`, [good, tot.s, r.job_card_id]);

    // fgReceipt()
    await client.query(`
      INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
      ON CONFLICT (product_id) DO UPDATE SET qty = fg_stock.qty + EXCLUDED.qty`, [r.product_id, good]);
    await client.query(`
      INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id)
      VALUES ($1,'fg_receipt',$2,'job_card',$3)`, [r.product_id, good, r.job_card_id]);

    // closeRunLines() — one line for a plain card, every member for a gang run.
    const lineIds = r.order_line_id
      ? [r.order_line_id]
      : (r.gang_run_id
          ? (await client.query('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [r.gang_run_id])).rows.map(x => x.id)
          : []);
    for (const id of lineIds) {
      const { rows: [ln] } = await client.query('SELECT status FROM order_lines WHERE id=$1', [id]);
      if (!ln || ln.status === 'produced' || ln.status === 'dispatched') continue;
      if (ln.status !== 'in_production') {
        skipped.push(`${r.jc_number}: order line ${id} is '${ln.status}', not 'in_production' — status left alone`);
        continue;
      }
      await client.query(`UPDATE order_lines SET status='produced' WHERE id=$1`, [id]);
      await client.query(
        `INSERT INTO audit_log (entity, entity_id, action, detail, user_name) VALUES ('order_line',$1,$2,NULL,$3)`,
        [id, `status:${ln.status}→produced`, USER]);
    }

    await client.query(
      `INSERT INTO audit_log (entity, entity_id, action, detail, user_name) VALUES ('job_card',$1,'closed',$2,$3)`,
      [r.job_card_id, `FG ${good} released (batch ${r.jc_number}) — QC gate retired`, USER]);

    released++; releasedQty += good;
    console.log(`  ${r.jc_number}  RELEASED ${num(good)} cartons → Dispatch  (scrap ${num(tot.s)})`);
  }

  // Dead access keys. Neither causes a lockout (nobody lands on /finished-goods)
  // but both point at things that no longer exist.
  const { rowCount: secFixed } = await client.query(`
    UPDATE users SET sections = (SELECT jsonb_agg(v) FROM jsonb_array_elements(sections) v WHERE v <> '"qc"')
    WHERE sections IS NOT NULL AND sections @> '["qc"]'`);
  const { rowCount: modFixed } = await client.query(`
    UPDATE users SET modules = (SELECT jsonb_agg(v) FROM jsonb_array_elements(modules) v WHERE v <> '"finished_goods"')
    WHERE modules IS NOT NULL AND modules @> '["finished_goods"]'`);

  console.log(`\n── summary ──`);
  console.log(`  qc stages dropped        ${dropped}`);
  console.log(`  job cards released       ${released}  (${num(releasedQty)} cartons to Dispatch)`);
  console.log(`  logins: qc section       ${secFixed} cleaned`);
  console.log(`  logins: finished_goods   ${modFixed} cleaned`);
  if (skipped.length) {
    console.log(`\n  SKIPPED (${skipped.length}) — needs a human:`);
    for (const s of skipped) console.log(`    · ${s}`);
  }

  const { rows: [left] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM job_stages WHERE stage='qc' AND status <> 'completed'`);
  const { rows: [kept] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM job_stages WHERE stage='qc' AND status='completed'`);
  console.log(`\n  open qc stages remaining ${left.n}   completed qc history preserved ${kept.n}`);

  if (APPLY) {
    await client.query('COMMIT');
    console.log('\nAPPLIED.\n');
  } else {
    await client.query('ROLLBACK');
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.\n');
  }
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nFAILED, rolled back:', e.message, '\n');
  process.exitCode = 1;
} finally {
  await client.end();
}
