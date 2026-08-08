import { tx } from './db.js';
import { adjustBoardStock, audit } from './helpers.js';

const RETURN_NOTE = 'returned to warehouse uncommitted';

const movementIdsOf = x => {
  if (Array.isArray(x?.stock_movement_ids)) return x.stock_movement_ids.map(Number).filter(Boolean);
  if (typeof x?.stock_movement_ids === 'string') {
    try { return JSON.parse(x.stock_movement_ids).map(Number).filter(Boolean); }
    catch { return []; }
  }
  return [];
};

export async function returnIssuedExtraToStock({ qc, oc, x, jc, materialId, parentQty, reason, user, writeOnMissing = true }) {
  let owed = Math.max(0, Math.round(+parentQty || 0));
  if (!owed) return 0;
  const ids = movementIdsOf(x);
  let rows = [];
  if (ids.length) {
    rows = await qc(`
      SELECT id, material_id, batch_id, qty
      FROM stock_movements
      WHERE id = ANY($1::int[]) AND material_id=$2 AND qty < 0 AND batch_id IS NOT NULL
      ORDER BY id DESC`, [ids, materialId]);
  }
  if (!rows.length) {
    rows = await qc(`
      SELECT id, material_id, batch_id, qty
      FROM stock_movements
      WHERE ref_type='job_card' AND ref_id=$1 AND material_id=$2
        AND type='consumption' AND qty < 0 AND note ILIKE $3
      ORDER BY id DESC`, [jc.id, materialId, `%${x.xs_number}%`]);
  }

  let returned = 0;
  for (const row of rows) {
    if (owed <= 0) break;
    const back = Math.min(owed, Math.abs(Math.round(Number(row.qty || 0))));
    if (back <= 0) continue;
    const b = await oc('SELECT qty FROM stock_batches WHERE id=$1 FOR UPDATE', [row.batch_id]);
    const newQty = Number(b?.qty || 0) + back;
    await qc('UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3',
      [newQty, newQty <= 0 ? 'exhausted' : 'available', row.batch_id]);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'adjustment',$3,'job_card',$4,$5)`,
      [row.material_id, row.batch_id, back, jc.id,
       `Returned - ${x.xs_number} ${RETURN_NOTE} for ${jc.jc_number} - ${reason}`]);
    owed -= back;
    returned += back;
  }

  if (owed > 0 && writeOnMissing) {
    await adjustBoardStock(materialId, -owed, 'job_card', jc.id,
      `Returned - ${x.xs_number} approval reversed for ${jc.jc_number} - ${reason}`,
      qc, oc, { user, reason, label: jc.jc_number });
    returned += owed;
  }
  return returned;
}

export async function releaseExtraSheetReservation({ qc, oc, x, jc, materialId, parentQty, reason, user, returnConsumed = true }) {
  const qty = Math.max(0, Math.round(+parentQty || 0));
  if (!qty || !materialId) return '';
  const returned = returnConsumed
    ? await returnIssuedExtraToStock({ qc, oc, x, jc, materialId, parentQty: qty, reason, user, writeOnMissing: false })
    : 0;
  if (returned && jc?.id) {
    await qc('UPDATE job_cards SET sheets_issued=GREATEST(0, sheets_issued - $1) WHERE id=$2', [returned, jc.id]);
  }
  const board = await oc('SELECT name FROM materials WHERE id=$1', [materialId]);
  const jobNo = jc?.jc_number || `job #${x.job_card_id}`;
  const boardName = board?.name || `material #${materialId}`;
  const note = returned
    ? `${returned} parent sheets ${RETURN_NOTE} from ${x.xs_number} for ${jobNo}`
    : `${qty} parent sheets released to warehouse uncommitted from ${x.xs_number} for ${jobNo}`;
  await audit('materials', materialId, 'extra_sheet_stock_uncommitted',
    `${note} (${boardName})${reason ? ` - ${reason}` : ''}`, qc, user);
  return `${returned || qty} parent sheets ${returned ? RETURN_NOTE : 'released to warehouse uncommitted'}${board?.name ? ` (${board.name})` : ''}`;
}

export async function repairMissingExtraSheetReturns({ user = 'system repair' } = {}) {
  return tx(async (qc, oc) => {
    const rows = await qc(`
      SELECT x.*, jc.id AS jc_id, jc.jc_number
      FROM extra_sheet_requests x
      JOIN job_cards jc ON jc.id = x.job_card_id
      WHERE x.status IN ('cancelled','rejected','reversed')
        AND x.issued_at IS NULL
        AND x.board_material_id IS NOT NULL
        AND COALESCE(x.qty, 0) > 0
        AND EXISTS (
          SELECT 1 FROM stock_movements sm
          WHERE sm.ref_type='job_card' AND sm.ref_id=x.job_card_id
            AND sm.material_id=x.board_material_id
            AND sm.type='consumption' AND sm.qty < 0
            AND sm.note ILIKE '%' || x.xs_number || '%'
        )
        AND NOT EXISTS (
          SELECT 1 FROM stock_movements sm
          WHERE sm.ref_type='job_card' AND sm.ref_id=x.job_card_id
            AND sm.material_id=x.board_material_id
            AND sm.type='adjustment' AND sm.qty > 0
            AND sm.note ILIKE '%' || x.xs_number || '%'
            AND sm.note ILIKE '%' || $1 || '%'
        )
      ORDER BY x.id
      LIMIT 25
      FOR UPDATE OF x SKIP LOCKED`, [RETURN_NOTE]);

    let repaired = 0;
    for (const x of rows) {
      const returned = await returnIssuedExtraToStock({
        qc, oc, x, jc: { id: x.jc_id, jc_number: x.jc_number }, materialId: x.board_material_id, parentQty: x.qty,
        reason: `legacy ${x.status} request stock repair`, user, writeOnMissing: false,
      });
      if (!returned) continue;
      await qc('UPDATE job_cards SET sheets_issued=GREATEST(0, sheets_issued - $1) WHERE id=$2', [returned, x.jc_id]);
      repaired += 1;
      await audit('materials', x.board_material_id, 'extra_sheet_stock_uncommitted',
        `${x.xs_number} - repaired missing cancellation return; ${returned} parent sheets ${RETURN_NOTE} for ${x.jc_number}`,
        qc, user);
      await audit('extra_sheet', x.id, 'stock_return_repair',
        `${x.xs_number} - ${returned} parent sheets ${RETURN_NOTE} after ${x.status}`,
        qc, user);
      await audit('job_card', x.job_card_id, 'extra_sheet_stock_return_repair',
        `${x.xs_number} - ${returned} parent sheets ${RETURN_NOTE}`,
        qc, user);
    }
    return repaired;
  });
}

export async function repairMissingExtraSheetReturnsQuiet(opts) {
  try { return await repairMissingExtraSheetReturns(opts); }
  catch (e) {
    console.warn(`[extra-sheets] stock return repair skipped: ${e.message}`);
    return 0;
  }
}
