// Making a product master that is not in our masters yet — shared by the artwork window's "Create it" (18 Nov 2026)
// and the Fluence-mail reader's new kits, so both make exactly the same thing: a DRAFT master (is_draft = 1, the next
// code in the customer's series, the board on the placeholder, spec marked incomplete — as a product raised from a PO
// is, routes/drafts.js), and for a Fluence product its Fluence kit (source erp-product:<id>, as the Fluence module
// makes one for a product).
import { audit, nextProductCode, placeholderBoardId } from './helpers.js';

export async function createDraftProduct(qc, oc, { customerId, name, partyItemCode = null, productType = null, draftSource, by, note }) {
  const code = await nextProductCode(customerId, qc, oc);
  const board = await placeholderBoardId(oc);
  if (!board) throw Object.assign(new Error('There is no board material at all yet — create one in Masters first.'), { status: 409 });
  const p = await oc(`INSERT INTO products (customer_id, name, code, internal_carton_code, party_item_code, board_material_id, spec_incomplete,
                                             product_type, is_draft, draft_source)
                      VALUES ($1, $2, $3, $3, $4, $5, 1, $6, 1, $7) RETURNING id, code, name, customer_id`,
  [customerId, String(name).slice(0, 200), code, partyItemCode, board, productType, draftSource]);
  await audit('products', p.id, 'create', `Draft master ${p.code} ${p.name} — ${note}`, qc, by);
  return p;
}

export async function fluenceKitFor(qc, oc, product, by) {
  return oc(`INSERT INTO fluence_kits (kit_name, source_ref, product_id, link_method, linked_at, linked_by, created_by, updated_by)
             VALUES ($1, $2, $3, 'created_from_product', now(), $4, $4, $4)
             ON CONFLICT (source_ref) DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now() RETURNING *`,
  [product.name, `erp-product:${product.id}`, product.id, by]);
}
