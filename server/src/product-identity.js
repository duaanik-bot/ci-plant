// GET /products/identity — the product master as identity (see masters.js).
//
// Two ways to ask, one query:
//
//   bare        → every product, exactly as before. Plant tablets hold an old
//                 bundle open for hours or days and that bundle still asks for
//                 the whole list, so this answer must not change by a byte.
//   ?ids=1,2,3  → only those products. ProductIdentity needs a record only for a
//                 row that arrived without its codes — a station queue names
//                 tens of products, and the whole list was ~1,062 KB parsed on
//                 the tablet at every page load to find them.
//
// Same columns, same ORDER BY on both: the client merges these rows into the
// same Map, and products-identity.test.js pins that the ?ids query is the bare
// one plus a WHERE and nothing else.

// A batch is what one render of one screen is missing; 200 is well past any
// station queue, and a caller asking for more has a bug worth refusing loudly
// rather than a reason to be handed a master-sized answer. The client splits
// its batches at the same number (client/src/lib/idBatchLoader.js).
export const IDENTITY_IDS_CAP = 200;

// products.id is an INTEGER identity; anything past int4 would make Postgres
// throw on the ::int[] cast instead of simply not matching.
const INT4_MAX = 2147483647;

export function productIdentitySql(byIds = false) {
  return `
      SELECT p.id, p.name, p.code, p.internal_carton_code, p.party_item_code, p.party_artwork_code,
             p.output_number, p.shade_card_number, p.board_grade, p.gsm, p.size,
             p.child_l, p.child_w, p.parent_l, p.parent_w, p.ups,
             p.colors, p.colour_type, p.print_process, p.coating, p.special, p.pasting_type,
             p.emboss, p.leafing, p.leafing_colour, p.die_number, p.block_number,
             p.product_type, p.rate, p.mrp,
             m.name AS board_material_name,
             COALESCE(p.gst_pct, gr.rate, 12) AS effective_gst
      FROM products p
      JOIN materials m ON m.id = p.board_material_id
      LEFT JOIN gst_rates gr ON gr.product_type = p.product_type${byIds ? `
      WHERE p.id = ANY($1::int[])` : ''}
      ORDER BY p.name`;
}

// null = the caller did not ask by id (the bare route). Otherwise the distinct
// positive integer ids, in the order first given; junk entries are dropped, not
// fatal — a row with a blank product_id should not cost the whole batch.
export function parseIdentityIds(raw) {
  if (raw === undefined) return null;
  const seen = new Set();
  for (const part of [].concat(raw).join(',').split(',')) {
    const s = String(part).trim();
    if (!/^\d+$/.test(s)) continue;
    const n = Number(s);
    if (n > 0 && n <= INT4_MAX) seen.add(n);
  }
  const ids = [...seen];
  if (ids.length > IDENTITY_IDS_CAP) {
    throw Object.assign(
      new Error(`Ask for at most ${IDENTITY_IDS_CAP} products at a time (got ${ids.length})`),
      { status: 400 });
  }
  return ids;
}

export function productIdentityRoute(q) {
  return async (req, res, next) => {
    try {
      const ids = parseIdentityIds(req.query?.ids);
      if (ids === null) return res.json(await q(productIdentitySql()));
      if (!ids.length) return res.json([]);
      res.json(await q(productIdentitySql(true), [ids]));
    } catch (e) { next(e); }
  };
}
