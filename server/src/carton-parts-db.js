// The DB side of a carton made in parts (rules: carton-parts.js). Every function
// runs inside the CALLER's transaction — qc/oc are its query functions.
import {
  audit, effectiveProduct, nextNumber, partLinesOf, rollbackLine, routingFor, setLineStatus,
} from './helpers.js';
import {
  EDITABLE_PART, assemblyStages, joinableSets, lineSays, partLineSyncPlan, partPieces, partStillReferenced,
  pastingCantStart, walkToInProduction,
} from './carton-parts.js';

const NOTHING = () => ({ inserted: 0, updated: 0, removed: 0, warnings: [] });

// Keep a carton line's part lines in step with its master's parts list. Called
// after an order line is created or edited, after a shortage balance is raised,
// and when a carton's parts are saved. A line whose product has no parts and no
// part lines is left exactly as it was.
export async function syncPartLines(outerLineId, qc, oc, user = null) {
  const out = NOTHING();
  // One unlocked look first: every line of every PO save comes through here, and
  // an ordinary line (no parts on its master, none on the order) is left exactly
  // as it was — no lock, no further query.
  const peek = await oc(`SELECT ol.part_of_line_id,
      EXISTS (SELECT 1 FROM order_lines x WHERE x.part_of_line_id = ol.id) AS has_parts,
      EXISTS (SELECT 1 FROM product_parts pp WHERE pp.outer_product_id = ol.product_id) AS listed
    FROM order_lines ol WHERE ol.id=$1`, [outerLineId]);
  if (!peek || peek.part_of_line_id || (!peek.has_parts && !peek.listed)) return out;
  // rollbackLine's lock rule: a line that already has part lines is locked NO
  // KEY UPDATE (its parts' foreign keys share-lock it on every second update of
  // a part — FOR UPDATE would deadlock); one with none yet is locked FOR UPDATE,
  // which the first-conversion rollbackLine below re-enters without an upgrade.
  const outer = await oc(`SELECT * FROM order_lines WHERE id=$1 FOR ${peek.has_parts ? 'NO KEY UPDATE' : 'UPDATE'}`, [outerLineId]);
  if (!outer || outer.part_of_line_id) return out;
  const parts = await qc(
    `SELECT part_product_id, label, per_carton FROM product_parts
      WHERE outer_product_id=$1 ORDER BY seq, id`, [outer.product_id]);
  let existing = await partLinesOf(outer.id, qc);
  if (!parts.length && !existing.length) return out;

  // First time this line becomes a carton-in-parts: its own board plan is void —
  // each part carries its own board now (contract C2).
  if (parts.length && !existing.length) {
    if (outer.gang_run_id) {
      out.warnings.push('This line is in a gang — take it out of the gang to run it in parts');
      return out;
    }
    if (!['pending', 'planned'].includes(outer.status)) {
      out.warnings.push(`This line is ${lineSays(outer.status)} — it runs as one carton this time`);
      return out;
    }
    // Anything already done for the carton as ONE job — a lock, a PR, a hold, a
    // mix, FG reserved against it, a shipped balance (even on a pending line:
    // Raise PR and consume-FG have no status gate) — is undone the one audited
    // way: rollbackLine. It gives reserved FG back, and refuses a shipped line.
    const prior = await oc(`SELECT
        EXISTS (SELECT 1 FROM requisitions WHERE order_line_id=$1) AS pr,
        EXISTS (SELECT 1 FROM board_allocations WHERE order_line_id=$1 AND status='active') AS hold,
        EXISTS (SELECT 1 FROM job_board_mix WHERE order_line_id=$1) AS mix`, [outer.id]);
    if (outer.status === 'planned' || outer.sheets_required != null || outer.parent_sheets_required != null
        || +outer.fg_consumed_qty > 0 || +outer.dispatched_qty > 0
        || prior.pr || prior.hold || prior.mix) {
      // A savepoint, so a refusal can never leave half a rollback behind — today
      // rollbackLine refuses before its first write, but that is its business.
      await qc('SAVEPOINT carton_parts_convert');
      try {
        await rollbackLine({ lineId: outer.id, mode: 'rollback', note: 'carton now made in parts — each part carries its own board' }, qc, oc, user);
        await qc('RELEASE SAVEPOINT carton_parts_convert');
      } catch (e) {
        if (!e.blockers) throw e;
        await qc('ROLLBACK TO SAVEPOINT carton_parts_convert');
        out.warnings.push(`This line stays one carton this time — ${e.message}`);
        return out;
      }
      outer.status = 'pending';
    }
    await qc('UPDATE order_lines SET sheets_required=0, parent_sheets_required=0, wastage_sheets=0 WHERE id=$1',
      [outer.id]);
    await audit('order_line', outer.id, 'made_in_parts',
      'now made in parts — each part is planned and covered on its own board', qc, user);
  }

  let plan = partLineSyncPlan({ outer, parts, existing });
  // A push commits a part's card without touching the carton, so the carton
  // lock above does not keep the part statuses just read from changing: a qty
  // edit or a list change decided on them could land on a part that went under
  // way a moment ago (the freeze, C9). So before this sync writes a part or
  // changes the list, it locks the parts it read as still in planning — the
  // only ones that can go under way beneath it — in id order, like every
  // multi-line lock, and decides again on what they say under the lock.
  // ONLY those, and ONLY then: an order edit holds its ORDER row FOR UPDATE
  // through this call, and a save that writes a part line twice (a plan save,
  // a push from planned, a reverse to Planning, an artwork unlock) holds that
  // part and then KEY SHAREs the order (its foreign-key re-check). So an edit
  // must never wait on a part it will not write — not when it leaves the
  // carton alone ((vii) in carton-parts-lock-order-pg.test.js), and not on a
  // part already past planning ((viii)). A part that comes BACK to planning
  // meanwhile keeps its first reading, under way: it keeps its figures for
  // now and follows on the next save — the safe side.
  const inPlanning = existing.filter(p => EDITABLE_PART.includes(p.status)).map(p => p.id);
  if (inPlanning.length && (plan.update.length || plan.insert.length || plan.remove.length)) {
    await qc('SELECT id FROM order_lines WHERE id = ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE', [inPlanning]);
    const locked = new Set(inPlanning);
    const first = new Map(existing.map(p => [p.id, p]));
    existing = (await partLinesOf(outer.id, qc)).map(p => (locked.has(p.id) ? p : (first.get(p.id) ?? p)));
    plan = partLineSyncPlan({ outer, parts, existing });
  }
  // Qty and batch first — they do not depend on the list.
  for (const up of plan.update) {
    const was = existing.find(x => x.id === up.id);
    await qc('UPDATE order_lines SET qty=$1, line_remark=$2, part_label=$3, part_per_carton=$4 WHERE id=$5',
      [up.qty, up.line_remark, up.label, up.per_carton, up.id]);
    const batch = (was.line_remark ?? null) !== up.line_remark
      ? `, batch ${was.line_remark ?? 'none'} → ${up.line_remark ?? 'none'}` : '';
    await audit('order_line', up.id, 'part_line_updated',
      `${up.label} follows its carton — qty ${was.qty} → ${up.qty}${batch}`, qc, user);
    out.updated++;
  }
  // The LIST changes all-or-nothing on this carton line: removals first, then
  // inserts, then the un-made reset, under one savepoint. If one part cannot go
  // (its PR already on a purchase order, say), the whole list stays as it was
  // on this order with one warning — a half-applied list (an old part beside a
  // new one, or one lone part with the carton's board at zero) must never exist,
  // and one blocked line must never fail a whole parts save either.
  if (plan.remove.length || plan.insert.length) {
    const removeNote = `taken off carton line #${outer.id} in the Product Master`;
    await qc('SAVEPOINT carton_parts_list');
    try {
      for (const rm of plan.remove) {
        // The one way out for a part line (contract C8): its holds, PR and card go too.
        const label = existing.find(x => x.id === rm.id)?.label || 'A part';
        try {
          await rollbackLine({ lineId: rm.id, mode: 'delete', note: removeNote, viaCarton: true }, qc, oc, user);
        } catch (e) {
          if (e.blockers) e.message = `${label}: ${e.message}`;
          // A record still pointing at the part — a shade card raised against it
          // (no delete rule on shade_cards.order_line_id) — stops its row being
          // deleted: 23503 from the DELETE. It cannot leave, exactly as a
          // blocker cannot, so it is contained the same way below — never a
          // raw Postgres error failing the whole parts save for every order.
          // Thrown in rollbackLine's own refusal shape, which that catch reads.
          if (e.code === '23503') {
            const refused = new Error(partStillReferenced(label, e.table));
            refused.status = 409;
            refused.blockers = [refused.message];
            throw refused;
          }
          throw e;
        }
        out.removed++;
      }
      for (const ins of plan.insert) {
        // A part line remembers what it is — its label and pieces per carton —
        // so the order keeps deciding its carton even after the master changes.
        // It takes the carton's P1 star as it takes its date: the Status Sheet
        // keeps the two in step after that (orders.js).
        const [row] = await qc(
          `INSERT INTO order_lines (order_id, product_id, qty, rate, gst_pct, tolerance_pct, delivery_date,
                                    line_remark, part_of_line_id, part_label, part_per_carton, is_p1)
           VALUES ($1,$2,$3,0,0,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [outer.order_id, ins.product_id, ins.qty, outer.tolerance_pct, outer.delivery_date || null,
           outer.line_remark ?? null, outer.id, ins.label, ins.per_carton, outer.is_p1 ? 1 : 0]);
        await audit('order_line', row.id, 'part_line_created',
          `${ins.label} of carton line #${outer.id} — ${ins.qty}${outer.line_remark ? `, batch ${outer.line_remark}` : ''}`, qc, user);
        out.inserted++;
      }
      // Un-made: the master lists no parts any more and none is left on this
      // line — it is an ordinary carton again, planned on its own board from
      // scratch (its zeros would otherwise read as "needs no board" in Planning).
      if (!parts.length && out.removed === existing.length) {
        await qc('UPDATE order_lines SET sheets_required=NULL, parent_sheets_required=NULL, wastage_sheets=NULL WHERE id=$1', [outer.id]);
        await audit('order_line', outer.id, 'no_longer_in_parts', 'its parts were taken off the master — plan it as one carton', qc, user);
      }
      await qc('RELEASE SAVEPOINT carton_parts_list');
    } catch (e) {
      if (!e.blockers) throw e;
      await qc('ROLLBACK TO SAVEPOINT carton_parts_list');
      out.removed = 0;
      out.inserted = 0;
      out.warnings.push(`The parts list stays as it was on this order — ${e.message}`);
    }
  }
  out.warnings.push(...plan.warnings);
  return out;
}

// A part card has finished die cutting (contract C4): it is done — 'split', the
// state that already means "finished, not a finished-goods batch" — and its
// pieces are counted. No FG receipt: a part is not a saleable carton. The part
// line stays in_production until the carton's pasting card takes the pieces.
export async function closePartCard(jc, dieCutSheets, qc, oc, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1', [jc.order_line_id]);
  const master = await oc('SELECT * FROM products WHERE id=$1', [jc.product_id]);
  const pieces = partPieces({ dieCutSheets, ups: effectiveProduct(master, line).ups });
  const tot = await oc('SELECT COALESCE(SUM(qty_scrap),0)::int AS s FROM job_stages WHERE job_card_id=$1', [jc.id]);
  await qc(`UPDATE job_cards SET status='split', qty_produced=$1, qty_scrap=$2, closed_at=now() WHERE id=$3`,
    [pieces, tot.s, jc.id]);
  await audit('job_card', jc.id, 'part_die_cut',
    `${pieces} pieces die-cut — handed to the carton's pasting card`, qc, user);
  return pieces;
}

// Once EVERY part of the carton is die-cut, make its pasting card (contract C5).
// Returns the card id, or null while a part is still on the floor.
export async function maybeCreateAssemblyCard(outerLineId, qc, oc, user = null) {
  // Lock order: the order and the outer product BEFORE the carton — the order an
  // order edit (the order FOR UPDATE, then its lines) and a parts save (the
  // product, then its cartons) take them. Walking the carton's status below
  // writes it several times, and every write after the first re-checks its
  // foreign keys, share-locking the order and the product; asked for only then,
  // behind an edit that already holds the carton, that is a deadlock.
  const ref = await oc('SELECT order_id, product_id FROM order_lines WHERE id=$1', [outerLineId]);
  if (!ref) return null;
  await oc('SELECT id FROM orders WHERE id=$1 FOR KEY SHARE', [ref.order_id]);
  await oc('SELECT id FROM products WHERE id=$1 FOR KEY SHARE', [ref.product_id]);
  const outer = await oc('SELECT * FROM order_lines WHERE id=$1 FOR NO KEY UPDATE', [outerLineId]);
  if (!outer) return null;
  const existing = await oc('SELECT id FROM job_cards WHERE order_line_id=$1', [outer.id]);
  if (existing) return existing.id;

  // The carton's OWN part lines decide — never the live master, which may have
  // changed since these parts went to the floor (partsFrozen). Each line
  // remembers its label and pieces per carton; the master fills in only for a
  // line that predates that memory.
  const parts = await qc(`
    SELECT pl.id AS line_id, COALESCE(pl.part_label, pp.label, p.name) AS label,
           COALESCE(pl.part_per_carton, pp.per_carton, 1) AS per_carton,
           jc.jc_number, jc.status AS jc_status, jc.qty_produced
      FROM order_lines pl
      JOIN products p ON p.id = pl.product_id
      LEFT JOIN product_parts pp ON pp.outer_product_id = $2 AND pp.part_product_id = pl.product_id
      LEFT JOIN job_cards jc ON jc.order_line_id = pl.id
     WHERE pl.part_of_line_id = $1
     ORDER BY pp.seq NULLS LAST, pl.id`, [outer.id, outer.product_id]);
  // Every part card split? Read after the carton lock: two parts finishing at
  // once serialise on it, and under READ COMMITTED (the app's only isolation
  // level) the second sees the first's committed card — exactly one pasting
  // card, made by whichever part finishes last.
  if (!parts.length || parts.some(p => p.jc_status !== 'split')) return null;

  // 0 sets still makes the card: Sort & Paste closes it short, and the shortage
  // re-raise brings the carton (and its parts) back — the road any short job takes.
  const { sets, spare } = joinableSets(parts.map(p => ({ label: p.label, pieces: p.qty_produced, per_carton: p.per_carton })));
  const master = await oc('SELECT * FROM products WHERE id=$1', [outer.product_id]);
  let walk;
  try {
    walk = walkToInProduction(outer.status);
  } catch (e) {
    // The operator saving a die-cut never sees the carton line — name it.
    const po = await oc('SELECT po_number FROM orders WHERE id=$1', [outer.order_id]);
    e.message = pastingCantStart({ code: master.code, po: po?.po_number ?? outer.order_id, status: outer.status });
    throw e;
  }
  // Entering in_production puts the carton in board demand: pin its own need at
  // zero first, whatever its history, so it can never price its master board.
  // Its artwork locks in the same write: every part line was artwork-locked to
  // get its card, and the pasting card reads its artwork off THIS line — left
  // unlocked, its floor light reads "Artwork not locked" and finalise refuses.
  await qc(`UPDATE order_lines SET sheets_required=0, parent_sheets_required=0, wastage_sheets=0,
              artwork_customer_ok=1, artwork_qa_ok=1, artwork_locked=1 WHERE id=$1`, [outer.id]);
  await audit('order_line', outer.id, 'artwork_locked_with_parts',
    'artwork approved and locked with its parts — every part was locked before its card', qc, user);
  for (const to of walk) await setLineStatus(outer.id, to, qc, oc, user);
  const product = effectiveProduct(master, outer);
  const jcNumber = await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc);
  const [card] = await qc(
    `INSERT INTO job_cards (jc_number, order_line_id, product_id, qty_planned, sheets_issued, children_per_parent, is_assembly)
     VALUES ($1,$2,$3,$4,$4,1,true) RETURNING id`,
    [jcNumber, outer.id, outer.product_id, sets]);
  const stages = assemblyStages(routingFor(product));
  for (let i = 0; i < stages.length; i++) {
    await qc('INSERT INTO job_stages (job_card_id, seq, stage, unit) VALUES ($1,$2,$3,$4)',
      [card.id, i + 1, stages[i].stage, stages[i].unit]);
  }
  // The parts' work is done: their pieces now live on the pasting card. Walking
  // them to a terminal status keeps order completion, pendency and dispatch from
  // ever waiting on a line no customer ordered.
  for (const p of [...parts].sort((a, b) => a.line_id - b.line_id)) {   // ascending id, like every multi-line lock
    await setLineStatus(p.line_id, 'produced', qc, oc, user);
    await setLineStatus(p.line_id, 'dispatched', qc, oc, user);
    await audit('order_line', p.line_id, 'part_pasted', `${p.label} handed to pasting card ${jcNumber}`, qc, user);
  }
  const joined = parts.map(p => `${p.label} ${p.jc_number} (${p.qty_produced})`).join(' + ');
  const left = spare.length ? ` — spare ${spare.map(s => `${s.label} ${s.qty}`).join(', ')}` : '';
  await audit('job_card', card.id, 'create_assembly', `${jcNumber} pastes ${joined} → ${sets} cartons${left}`, qc, user);
  return card.id;
}
