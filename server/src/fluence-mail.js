// Fluence's prescriptions, MRPs and new kits, from Fluence's own mails (owner, 18 Nov 2026: "the new MRP of a product
// and the prescription should be auto-saved in the Fluence module and the master module … I just want the system to
// fetch it whenever there is a new email from Fluence … We should be able to create the masters for the same").
// Design: plans/2026-11-18-fluence-mail-masters-design.md; the review of 18 Nov 2026 is answered below.
//
// The office AVS reads the mail (the prescription and MRPs printed on a kit's artwork, an MRP sheet, a PO's MRPs) and
// files what it read (avs intake kind 'fluence'). Here each reading is kept (fluence_mail_readings) and saved to the
// master ONLY through the Fluence module's own save (saveKitAndRx: revision, history, MRP trail) — signed "AVS —
// Fluence mail (date)" as a change from outside, so it waits for management's acknowledgement:
//   artwork  → kept with its artwork version; saved when the client approves that version (Anik, 18 Nov)
//   sheet    → saved when it arrives
//   PO       → compared and flagged, never saved
// Filing a mail only records its readings; they are saved right after, one small transaction each, oldest first,
// within a time budget (a sheet of 300 kits never runs as one transaction past the function's limit), and a reading
// that keeps failing is held after a few tries. One notice per mail, never a bell per kit.
// Held (not saved, a person decides): an MRP more than 25 % lower (kit total, carton MRP or an item) or more than
// double; a field the robot was not sure of; a kit or carton MRP changed by a person — or by a newer mail — after the
// mail; an artwork for a kit we have whose printed items are not the kit's (a mail never changes what is in the box).
// A kit not in our masters, from artwork: its masters are made by themselves (Anik) — the kit for the carton its job
// is linked to, or, with no carton, a draft carton (next code) and its kit. A sheet line naming no kit: not matched.
// Undo puts back only what the reading wrote, where it is still as the reading wrote it.
import { q, one, tx } from './db.js';
import { audit, notify } from './helpers.js';
import { PLANNING_ROLES } from './auth.js';
import { canAccess, fluenceTabsOf, isFluenceOnly } from '../../client/src/modules.js';
import { saveKitAndRx, rxSnapshot, componentsSnapshot, setKitTotalMrp, recordMrpChanges, kitIdOf, kitForProduct } from './routes/fluence.js';
import { normaliseReading, matchKit, namedKits, innerFor, holdsFor, contentsDiffer, payloadFor } from './fluence-mail-rules.js';
import { createDraftProduct, fluenceKitFor } from './artwork-masters.js';
import { nameKey, sameMrp, mrpValue, componentsSignature } from '../../client/src/lib/fluence.js';

const FROM = 'fluence_mail';
const MAX_TRIES = 5;
const QUEUE_LOCK = 727101;            // pg advisory lock: one Fluence reading saved at a time, oldest first
const PASSING = new Set(['40001', '40P01', '55P03', '57014']);
const SETTLED = ['saved', 'same', 'held', 'not_matched', 'compared'];
const SOURCE_WORD = { artwork: 'artwork', mrp_sheet: 'MRP sheet', po: 'PO' };
const day = iso => new Date(Number.isFinite(Date.parse(iso)) ? iso : Date.now()).toISOString().slice(0, 10);
// a mail's reading: from outside (waits for management), and quiet — its mail is told once, not kit by kit
const mailUser = r => ({ name: `AVS — Fluence mail ${day(r.received_at)}`, id: null, outside: true, quiet: true });
const list = v => (Array.isArray(v) ? v : []);
const text = v => String(v ?? '').trim();
const plain = n => (n == null ? '—' : String(Number(n)));
const fail = (status, message) => Object.assign(new Error(message), { status });

// The table may not be there yet (code shipped ahead of its migration): a client's approval and the artwork window ask
// first, so neither ever fails on it.
const ready = async oc => !!(await oc(`SELECT to_regclass('public.fluence_mail_readings') IS NOT NULL AS ok`))?.ok;
const allKits = qc => qc(`SELECT k.id, k.kit_name, k.product_id, k.kit_total_mrp, k.superseded_by_kit_id, p.code AS product_code, p.mrp AS carton_mrp
                            FROM fluence_kits k LEFT JOIN products p ON p.id = k.product_id`);

// ── filing: the copier hands each 'fluence' intake row here (artwork-intake.js). Cheap: it only records. ───────────
export async function fileFluenceRow(qc, oc, row, mail) {
  const made = [];
  let kits = null;
  for (const it of list(row.items)) {
    const source = ['artwork', 'mrp_sheet', 'po'].includes(it?.source) ? it.source : 'artwork';
    const reading = normaliseReading(it);
    // an artwork reading waits with its version: the newest live version, in this thread, of the job for this kit
    let versionId = null;
    let stage = null;
    if (source === 'artwork' && row.gmail_thread_id) {
      const vs = await qc(`
        SELECT DISTINCT v.id, j.product_name FROM artwork_mails m JOIN artwork_events e ON e.mail_id = m.id
          JOIN artwork_versions v ON v.id = e.version_id JOIN artwork_jobs j ON j.id = v.job_id
         WHERE m.gmail_thread_id = $1 AND v.deleted_at IS NULL AND v.status <> 'not_artwork'
           AND NOT EXISTS (SELECT 1 FROM artwork_versions x WHERE x.job_id = v.job_id AND x.id > v.id AND x.deleted_at IS NULL AND x.status <> 'not_artwork')`,
      [row.gmail_thread_id]);
      const key = nameKey(reading.kit_name);
      const byName = vs.filter(v => key && nameKey(v.product_name) === key);
      versionId = (byName.length === 1 ? byName[0] : vs.length === 1 ? vs[0] : null)?.id ?? null;
      // under a share lock: an approval being pressed this moment is waited for, never missed
      if (versionId) stage = (await oc('SELECT stage FROM artwork_versions WHERE id = $1 FOR SHARE', [versionId]))?.stage ?? null;
    }
    const status = source === 'po' ? 'compared'
      : source === 'mrp_sheet' ? 'queued'
        : !versionId ? 'held'
          : ['approved', 'released'].includes(stage) ? 'queued' : 'waiting_approval';
    const r = await oc(`
      INSERT INTO fluence_mail_readings (source, intake_id, mail_id, gmail_message_id, gmail_thread_id, subject, from_email, received_at,
                                         artwork_version_id, read_from, kit_name, kit_code, reading, sure, unsure, status, hold_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [source, row.id, mail?.id ?? null, row.gmail_message_id, row.gmail_thread_id, row.subject, row.from_email, row.received_at,
      versionId, text(it?.read_from) || null, reading.kit_name, reading.kit_code, JSON.stringify(reading), reading.sure,
      JSON.stringify(reading.unsure), status, status === 'held' ? 'no artwork version in this thread to wait for — a person applies it' : null]);
    if (source === 'po') { kits ??= await allKits(qc); await comparePo(qc, r, kits); }
    made.push(r.id);
  }
  await audit('artwork_intake', row.id, 'fluence', `AVS intake ${row.id} — ${made.length} Fluence reading(s)`, qc, 'AVS (office)');
  return { status: 'filed', result: { fluence_readings: made } };
}

async function hold(qc, id, kitId, reason) {
  await qc(`UPDATE fluence_mail_readings SET status = 'held', hold_reason = $2, kit_id = COALESCE($3, kit_id) WHERE id = $1`, [id, reason, kitId]);
}
async function notMatched(qc, id, why) {
  await qc(`UPDATE fluence_mail_readings SET status = 'not_matched', hold_reason = $2 WHERE id = $1`, [id, why]);
  return { status: 'not_matched' };
}

// A PO's MRPs: compared with the master — the carton's own MRP first, the MRP that is printed — and flagged, never
// written (a PO can carry the MRPs of before a newer sheet).
async function comparePo(qc, r, kits) {
  const reading = r.reading;
  const kit = matchKit(reading, { kits });
  if (!kit) { await qc(`UPDATE fluence_mail_readings SET hold_reason = 'no kit of that name or code' WHERE id = $1`, [r.id]); return; }
  const total = reading.mrp?.kit_total;
  const diffs = [];
  if (total != null) {
    const ct = kit.carton_mrp, kt = kit.kit_total_mrp;
    if (ct != null && !sameMrp(ct, total)) diffs.push(`carton MRP: master ${plain(ct)}, PO ${plain(total)}`);
    if (kt != null && !sameMrp(kt, total) && !sameMrp(kt, ct)) diffs.push(`kit total: master ${plain(kt)}, PO ${plain(total)}`);
    if (ct == null && kt == null) diffs.push(`no MRP in the master; PO ${plain(total)}`);
  }
  await qc(`UPDATE fluence_mail_readings SET kit_id = $2, product_id = $3, changes = $4 WHERE id = $1`,
    [r.id, kit.id, kit.product_id, JSON.stringify({ differs: diffs })]);
}

// Each save in its own savepoint: one reading that cannot be saved is held with the reason; the rest carry on.
async function applySafely(qc, oc, id, opts) {
  await qc('SAVEPOINT fluence_reading');
  try {
    const out = await applyReading(qc, oc, id, opts);
    await qc('RELEASE SAVEPOINT fluence_reading');
    return out;
  } catch (e) {
    await qc('ROLLBACK TO SAVEPOINT fluence_reading');
    if (PASSING.has(e?.code)) throw e;
    await hold(qc, id, null, `could not be saved: ${String(e.message).slice(0, 300)}`);
    return { status: 'held' };
  }
}

// What changed this kit after the mail was written, by someone other than the mail robot: a person's revision of its
// items or prescription, a person's MRP change, the carton's MRP edited in Masters (its audit line) — and a newer mail
// already saved to it.
async function changedSince(qc, oc, { kitId, productId, at, readingId }) {
  const since = at || new Date(0).toISOString();
  const person = await oc(`
    SELECT changed_by AS by, changed_at AS at FROM fluence_master_revisions
     WHERE kit_id = $1 AND changed_at > $2 AND area IN ('components', 'prescription') AND COALESCE(changed_by, '') NOT LIKE 'AVS%'
    UNION ALL
    SELECT changed_by, changed_at FROM fluence_mrp_changes WHERE kit_id = $1 AND changed_at > $2 AND COALESCE(changed_by, '') NOT LIKE 'AVS%'
    ORDER BY at DESC LIMIT 1`, [kitId, since]);
  let carton = null;
  if (productId) {
    const rows = await qc(`SELECT user_name AS by, created_at AS at, detail FROM audit_log
                            WHERE entity = 'products' AND entity_id = $1 AND action = 'update' AND created_at > $2
                              AND COALESCE(user_name, '') NOT LIKE 'AVS%' AND detail LIKE '%mrp: %' ORDER BY id DESC`, [productId, since]);
    const hit = rows.find(x => String(x.detail).split('; ').some(s => s.startsWith('mrp: ')));
    if (hit) carton = { by: hit.by, at: hit.at, what: 'carton MRP' };
  }
  const newer = at ? await oc(`SELECT received_at AS at FROM fluence_mail_readings
                                 WHERE kit_id = $1 AND id <> $2 AND status = 'saved' AND received_at > $3 ORDER BY received_at DESC LIMIT 1`, [kitId, readingId, at]) : null;
  const latest = [person, carton].filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
  return { person: latest, newer };
}

// Save one reading to the master. by = the person applying a held one (force: the holds are theirs to overrule).
export async function applyReading(qc, oc, id, { by = null, force = false } = {}) {
  const r = await oc('SELECT * FROM fluence_mail_readings WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw fail(404, 'No such Fluence reading.');
  const reading = normaliseReading(r.reading);
  const user = by ? { name: by.name, id: by.id ?? null, outside: false } : mailUser(r);
  // the artwork job's carton decides the kit, when the job is linked: its own kit, or its outer carton's
  const job = r.artwork_version_id ? await oc(`SELECT j.id, j.job_no, j.product_id, j.customer_id FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id WHERE v.id = $1`, [r.artwork_version_id]) : null;
  const kits = await allKits(qc);
  const productKitId = job?.product_id ? await kitIdOf(job.product_id, oc) : null;
  let kit = matchKit(reading, { kits, productKitId });
  const inners = await qc(`SELECT id, name FROM fluence_inner_products WHERE COALESCE(active, 1) = 1`);
  const innerIdOf = n => innerFor(n, inners);
  let created = null;

  if (!kit) {
    const twins = namedKits(reading, kits);
    if (twins.length > 1) {
      const why = `two kits are named ${reading.kit_name}`;
      if (r.source !== 'artwork') return notMatched(qc, id, `${why} — put the MRP in the right one by hand`);
      await hold(qc, id, null, `${why} — match the artwork job to its carton in the artwork window, then Apply`);
      return { status: 'held', reasons: [why] };
    }
    if (r.source !== 'artwork') return notMatched(qc, id, 'no kit of that name or code in our masters');
    if (!reading.sure && !force) { await hold(qc, id, null, `the robot was not sure of: ${reading.unsure.join(', ') || 'what it read'}`); return { status: 'held' }; }
    if (job?.product_id) {
      // the job's carton is in our masters with no kit yet: its kit is made for that carton — never a second carton
      const carton = await oc(`SELECT p.id, p.code, p.name FROM products p JOIN fluence_customers fc ON fc.customer_id = p.customer_id WHERE p.id = $1`, [job.product_id]);
      if (!carton) { await hold(qc, id, null, 'the artwork job is linked to a carton that is not a Fluence product — a person looks'); return { status: 'held' }; }
      const { kit: k } = await kitForProduct(carton, user, qc, oc);
      created = { kit: k, product: null };
      kit = k;
    } else {
      // a new development: its masters, by themselves (Anik, 18 Nov)
      const fc = await oc(`SELECT fc.customer_id FROM fluence_customers fc WHERE fc.customer_id = $1 UNION ALL SELECT customer_id FROM fluence_customers LIMIT 1`, [job?.customer_id ?? null]);
      if (!fc) { await hold(qc, id, null, 'no Fluence customer in the masters to make the kit for'); return { status: 'held' }; }
      const product = await createDraftProduct(qc, oc, { customerId: fc.customer_id, name: reading.kit_name || `Fluence kit ${r.id}`,
        productType: 'carton', draftSource: 'fluence_mail', by: user.name, note: `new Fluence kit read from the mail of ${day(r.received_at)}` });
      const k = await fluenceKitFor(qc, oc, product, user.name);
      if (job && !job.product_id) {
        await qc('UPDATE artwork_jobs SET product_id = $2, product_name = $3, to_sort = false WHERE id = $1', [job.id, product.id, product.name]);
        await qc(`INSERT INTO artwork_events (job_id, action, detail, by_name) VALUES ($1, 'product_created', $2, $3)`,
          [job.id, JSON.stringify({ product_id: product.id, code: product.code, product_name: product.name, from: 'fluence_mail' }), user.name]);
      }
      created = { product, kit: k };
      kit = k;
    }
  }

  const kitRow = await oc('SELECT * FROM fluence_kits WHERE id = $1 FOR UPDATE', [kit.id]);
  const product = kitRow.product_id ? await oc('SELECT id, code, name, mrp FROM products WHERE id = $1', [kitRow.product_id]) : null;
  const comps = await componentsSnapshot(kitRow.id, qc);
  const kinds = new Map((await qc(`SELECT id, kind FROM fluence_inner_products WHERE id = ANY($1::int[])`, [comps.map(c => c.inner_product_id)])).map(x => [x.id, x.kind]));
  const rxBefore = await rxSnapshot(kitRow.id, qc);
  // a kit this reading made, or an empty one ("Create it" made the kit and nothing more): filled as printed
  const creating = !!created || (!comps.length && !rxBefore);

  if (!force) {
    const since = created?.product ? null : await changedSince(qc, oc, { kitId: kitRow.id, productId: product?.id ?? null, at: r.received_at, readingId: r.id });
    const reasons = holdsFor({ reading, master: { kit_total_mrp: kitRow.kit_total_mrp, carton_mrp: product?.mrp ?? null, components: comps }, innerIdOf,
      personChangedAfterMail: since?.person ?? null, newerMail: since?.newer ?? null });
    if (!creating) reasons.push(...contentsDiffer(reading, { masterComponents: comps.map(c => ({ ...c, kind: kinds.get(c.inner_product_id) })), innerIdOf }));
    // a sheet's item that is not in the kit: the kit's contents differ — a person looks
    if (!reading.prescription) {
      for (const it of reading.mrp?.items || []) {
        const iid = innerIdOf(it.item);
        if (iid == null || !comps.some(c => c.inner_product_id === iid)) reasons.push(`${it.item} is not in this kit`);
      }
    }
    if (reasons.length) { await hold(qc, id, kitRow.id, reasons.join('; ')); return { status: 'held', reasons }; }
  }

  // items printed that are not in the inner-product list yet: added, flagged — for a kit filled as printed, or when a
  // person applies it (a mail never adds an item to a kit we have by itself)
  const added = [];
  if (reading.prescription && (creating || force)) {
    for (const n of [...reading.prescription.lines.map(l => l.item), ...(reading.mrp?.items || []).map(x => x.item)]) {
      if (innerIdOf(n) != null || added.includes(n)) continue;
      const ip = await oc(`INSERT INTO fluence_inner_products (name, name_key, kind, source, remarks, created_by, updated_by)
                           VALUES ($1, $2, 'item', 'fluence_mail', 'Added from a Fluence artwork — check its details', $3, $3)
                           ON CONFLICT (name_key) DO UPDATE SET updated_at = now() RETURNING id, name`, [n, nameKey(n), user.name]);
      inners.push(ip);
      added.push(n);
    }
  }

  const body = payloadFor(reading, { masterComponents: comps, masterRx: rxBefore, innerIdOf, creating });
  const outcome = await saveKitAndRx({ kit: kitRow, product, outer: null, body, user, from: FROM }, qc, oc);
  const total = await setKitTotalMrp({ kit: kitRow, product, newTotal: reading.mrp?.kit_total ?? null, user, from: FROM }, qc);
  const mrpIds = (await qc(`SELECT id FROM fluence_mrp_changes WHERE kit_id = $1 AND changed_at = now()`, [kitRow.id])).map(x => x.id);
  // what it wrote, so Undo can tell what has moved since
  const after = {
    components: await componentsSnapshot(kitRow.id, qc),
    rx_revision: outcome.revision,
    kit_total_mrp: total ? total.new : kitRow.kit_total_mrp,
    carton_mrp: product ? (await oc('SELECT mrp FROM products WHERE id = $1', [product.id]))?.mrp ?? null : null,
  };
  const changed = outcome.componentsChanged || outcome.rxChanged || !!total || !!created;
  await qc(`UPDATE fluence_mail_readings SET status = $2, kit_id = $3, product_id = $4, created_kit_id = $5, created_product_id = $6, changes = $7,
                   saved_at = now(), saved_by = $8, hold_reason = NULL WHERE id = $1`,
  [id, changed ? 'saved' : 'same', kitRow.id, product?.id ?? null, created?.kit.id ?? null, created?.product?.id ?? null,
    JSON.stringify({ revision: outcome.revision, components_changed: outcome.componentsChanged, rx_changed: outcome.rxChanged,
      kit_total: total ? { old: total.old, new: total.new } : null, mrp_change_ids: mrpIds, inner_added: added,
      before: { rx: rxBefore, components: comps, kit_total_mrp: kitRow.kit_total_mrp, carton_mrp: product?.mrp ?? null }, after }),
    user.name]);
  return { status: changed ? 'saved' : 'same', created: !!created };
}

// A version just approved: its waiting readings are saved now (hooked where a version becomes approved).
export async function applyApprovedReadings(qc, oc, versionIds) {
  if (!versionIds?.length || !await ready(oc)) return 0;
  const waiting = await qc(`SELECT id FROM fluence_mail_readings WHERE artwork_version_id = ANY($1::int[]) AND status = 'waiting_approval' ORDER BY id FOR UPDATE`, [versionIds]);
  for (const w of waiting) await applySafely(qc, oc, w.id, { by: null, force: false });
  if (waiting.length) await noticeSettledReadings(qc);
  return waiting.length;
}

// ── the queue: readings recorded by the filing, saved one small transaction at a time, oldest first ─────────────────
// A reading is claimed (its try counted, committed) before it is saved, so one that keeps dying — a cut-off function,
// a lock that never comes — is held after MAX_TRIES instead of being retried for ever ahead of the rest.
export async function applyQueuedReadings({ budgetMs = 10000, max = 500 } = {}) {
  const out = { applied: 0, held: 0 };
  if (!await ready(one)) return out;
  const t0 = Date.now();
  for (let n = 0; n < max && Date.now() - t0 < budgetMs; n++) {
    const claim = await tx(async (qc, oc) => {
      if (!(await oc(`SELECT pg_try_advisory_xact_lock(${QUEUE_LOCK}) AS ok`))?.ok) return { busy: true };
      const r = await oc(`SELECT id, attempts FROM fluence_mail_readings WHERE status = 'queued' ORDER BY received_at NULLS LAST, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!r) return null;
      if (r.attempts >= MAX_TRIES) {
        await hold(qc, r.id, null, `could not be saved after ${r.attempts} tries — a person applies it`);
        return { id: r.id, held: true };
      }
      await qc('UPDATE fluence_mail_readings SET attempts = attempts + 1 WHERE id = $1', [r.id]);
      return { id: r.id };
    });
    if (!claim || claim.busy) break;
    if (claim.held) { out.held += 1; continue; }
    let res;
    try {
      res = await tx(async (qc, oc) => {
        if (!(await oc(`SELECT pg_try_advisory_xact_lock(${QUEUE_LOCK}) AS ok`))?.ok) return { busy: true };
        const r = await oc('SELECT status FROM fluence_mail_readings WHERE id = $1 FOR UPDATE', [claim.id]);
        if (r?.status !== 'queued') return { skipped: true };
        return applySafely(qc, oc, claim.id, { by: null, force: false });
      });
    } catch (e) {
      if (PASSING.has(e?.code)) { console.warn(`[fluence-mail] left for the next call: ${e.message}`); break; }
      throw e;
    }
    if (res?.busy) break;
    if (!res?.skipped) out.applied += 1;
  }
  return out;
}

// ── one notice per mail ─────────────────────────────────────────────────────────────────────────────────────────
// When a mail's readings are all settled (none still queued), management hears once what it did — and the Planning
// people who can act on it hear too when something is held, not matched, or a PO's MRPs differ. A mail that only
// confirmed the master tells nobody. Each reading is told once (notified_at), however many callers race.
export async function noticeSettledReadings(qc) {
  const rows = await qc(`
    SELECT r.id, r.intake_id, r.source, r.status, r.changes, r.created_kit_id, r.subject, r.received_at, r.kit_name
      FROM fluence_mail_readings r
     WHERE r.notified_at IS NULL AND r.status = ANY($1::text[])
       AND NOT EXISTS (SELECT 1 FROM fluence_mail_readings x WHERE x.intake_id = r.intake_id AND x.status = 'queued')
     ORDER BY r.id LIMIT 3000 FOR UPDATE OF r SKIP LOCKED`, [SETTLED]);
  if (!rows.length) return 0;
  await qc('UPDATE fluence_mail_readings SET notified_at = now() WHERE id = ANY($1::int[])', [rows.map(x => x.id)]);
  const groups = new Map();
  for (const x of rows) {
    const key = x.intake_id ?? `r${x.id}`;
    groups.set(key, [...(groups.get(key) || []), x]);
  }
  const users = await qc('SELECT id, role, modules, fluence_tabs, is_management FROM users WHERE active = 1');
  const managers = users.filter(u => u.role === 'admin' || Number(u.is_management) === 1).map(u => u.id);
  const planners = users.filter(u => PLANNING_ROLES.includes(u.role) && !isFluenceOnly(u) && canAccess(u, 'fluence') && fluenceTabsOf(u).includes('mail')).map(u => u.id);
  let sent = 0;
  for (const xs of groups.values()) {
    const n = s => xs.filter(x => x.status === s).length;
    const differs = xs.filter(x => x.status === 'compared' && list(x.changes?.differs).length).length;
    const made = xs.filter(x => x.status === 'saved' && x.created_kit_id).length;
    const parts = [
      n('saved') && `${n('saved')} saved`, n('held') && `${n('held')} held`, n('not_matched') && `${n('not_matched')} not matched`,
      differs && `${differs} PO MRP${differs === 1 ? '' : 's'} differ`, made && `${made} new kit${made === 1 ? '' : 's'} made`,
    ].filter(Boolean);
    if (!parts.length) continue;
    const look = n('held') + n('not_matched') + differs > 0;
    const to = [...new Set([...managers, ...(look ? planners : [])])];
    if (!to.length) continue;
    const lines = xs.filter(x => x.status !== 'same').slice(0, 8).map(x => `${x.kit_name || 'a kit'}: ${x.status.replace('_', ' ')}`);
    await notify(to, {
      kind: 'fluence_mail',
      title: `From Fluence mail — ${xs[0].subject || SOURCE_WORD[xs[0].source] || 'a mail'}: ${parts.join(', ')}`,
      body: `${lines.join('\n')}${xs.length > 8 ? `\n…and ${xs.length - 8} more` : ''}\nSee Fluence › From Fluence mail.`,
      link: '/fluence?tab=mail',
    }, qc);
    sent += 1;
  }
  return sent;
}

// After each copier run and on the two-minute poll: save what is queued, then tell. Never fails its caller.
export async function workFluenceMailSoft({ budgetMs = 4000 } = {}) {
  const out = { applied: 0, held: 0, notices: 0 };
  try {
    if (!await ready(one)) return out;
    const waiting = await one(`SELECT EXISTS (SELECT 1 FROM fluence_mail_readings WHERE status = 'queued') AS queued,
                                      EXISTS (SELECT 1 FROM fluence_mail_readings WHERE notified_at IS NULL AND status = ANY($1::text[])) AS untold`, [SETTLED]);
    if (waiting?.queued && budgetMs > 0) Object.assign(out, await applyQueuedReadings({ budgetMs }));
    if (waiting?.queued || waiting?.untold) out.notices = await tx(qc => noticeSettledReadings(qc));
  } catch (e) {
    console.warn(`[fluence-mail] ${e.message}`);
  }
  return out;
}

// ── a person's buttons ──────────────────────────────────────────────────────────────────────────────────────────
export async function applyHeld(id, user) {
  return tx(async (qc, oc) => {
    const r = await oc(`SELECT status, source, artwork_version_id FROM fluence_mail_readings WHERE id = $1 FOR UPDATE`, [id]);
    if (!r) throw fail(404, 'No such Fluence reading.');
    if (r.status === 'waiting_approval') {
      throw fail(409, 'This reading waits for the client\'s approval of its artwork and is saved by itself when the client approves. If the client approved by phone or WhatsApp, use Approved by hand in the artwork window.');
    }
    if (r.status === 'not_matched') throw fail(409, 'No kit matched this reading, so there is nothing to apply it to. Keep the master as it is, or put the MRP in the kit by hand.');
    if (r.status !== 'held') throw fail(409, `This reading is ${r.status} — nothing to apply.`);
    if (r.source === 'artwork' && r.artwork_version_id) {
      const v = await oc('SELECT stage FROM artwork_versions WHERE id = $1', [r.artwork_version_id]);
      if (!['approved', 'released'].includes(v?.stage)) {
        throw fail(409, 'Its artwork version is not approved yet — a prescription is saved only from an approved artwork. When the client approves, use Approved by hand in the artwork window.');
      }
    }
    const out = await applyReading(qc, oc, id, { by: user, force: true });
    await audit('fluence_mail_reading', id, 'apply', `Applied by hand (was held) — now ${out.status}`, qc, user.name);
    return out;
  });
}

// A person decides the master stays as it is: a held or not-matched reading is set aside, kept, and off the list.
export async function keepReading(id, user) {
  return tx(async (qc, oc) => {
    const r = await oc(`SELECT status FROM fluence_mail_readings WHERE id = $1 FOR UPDATE`, [id]);
    if (!r) throw fail(404, 'No such Fluence reading.');
    if (!['held', 'not_matched'].includes(r.status)) throw fail(409, `This reading is ${r.status} — only a held or not-matched one is set aside.`);
    await qc(`UPDATE fluence_mail_readings SET status = 'dismissed', dismissed_at = now(), dismissed_by = $2 WHERE id = $1`, [id, user.name]);
    await audit('fluence_mail_reading', id, 'keep', `The master kept as it was (the reading was ${r.status})`, qc, user.name);
    return { status: 'dismissed' };
  });
}

const lineBody = l => ({
  inner_product_id: l.inner_product_id ?? null, item_label: l.item_label ?? null, dosage: l.dosage ?? null, dose_form: l.dose_form ?? null,
  pack_count: l.pack_count ?? null, frequency: l.frequency ?? null, morning_qty: l.morning_qty ?? null, afternoon_qty: l.afternoon_qty ?? null,
  evening_qty: l.evening_qty ?? null, night_qty: l.night_qty ?? null, other_timing: l.other_timing ?? null, other_qty: l.other_qty ?? null,
  instructions: l.instructions ?? null, remarks: l.remarks ?? null,
});
async function putKitTotal(qc, kit, product, value, user) {
  const label = product ? `${product.code} ${product.name}` : kit.kit_name;
  await qc('UPDATE fluence_kits SET kit_total_mrp = $2, updated_at = now(), updated_by = $3 WHERE id = $1', [kit.id, value, user.name]);
  await recordMrpChanges([{ subject: 'kit_total', kitId: kit.id, kitName: label, itemName: 'Kit total', oldMrp: kit.kit_total_mrp, newMrp: value }], user, 'fluence_master', qc);
  await audit('fluence_kit', kit.id, 'kit_total_mrp', `${label} — kit MRP ${mrpValue(kit.kit_total_mrp) ?? '—'} → ${mrpValue(value) ?? '—'}, a Fluence mail reading undone`, qc, user.name);
}
async function putCartonMrp(qc, product, value, user) {
  await qc('UPDATE products SET mrp = $2 WHERE id = $1', [product.id, value]);
  await audit('products', product.id, 'update', `mrp: ${product.mrp ?? '—'} → ${value ?? '—'}`, qc, user.name);
}

// Undo puts back only what the reading wrote, and only where the kit still holds what it wrote: a prescription revised
// since, an MRP changed since (by a person or a later mail), the kit list changed since — each is left as it is and
// said. A kit the reading made is removed (with its draft carton) only while nobody has worked on it, its carton is
// still a draft, and nothing uses it.
export async function undoReading(id, user) {
  return tx(async (qc, oc) => {
    const r = await oc(`SELECT * FROM fluence_mail_readings WHERE id = $1 FOR UPDATE`, [id]);
    if (!r) throw fail(404, 'No such Fluence reading.');
    if (r.status !== 'saved') throw fail(409, `This reading is ${r.status} — only a saved one can be undone.`);
    const me = { name: user.name, id: user.id ?? null, outside: false };
    const ch = r.changes || {};
    const left = [];
    if (r.created_kit_id) {
      const kit = await oc('SELECT * FROM fluence_kits WHERE id = $1 FOR UPDATE', [r.created_kit_id]);
      const carton = r.created_product_id ? await oc('SELECT id, is_draft FROM products WHERE id = $1 FOR UPDATE', [r.created_product_id]) : null;
      const why = [];
      if (carton && Number(carton.is_draft) !== 1) why.push('its carton master is no longer a draft');
      if (r.created_product_id && await oc(`SELECT 1 AS y FROM order_lines WHERE product_id = $1 UNION ALL SELECT 1 FROM job_cards WHERE product_id = $1 LIMIT 1`, [r.created_product_id])) {
        why.push('its carton is on an order or a job card');
      }
      const worked = kit && await oc(`SELECT changed_by FROM fluence_master_revisions WHERE kit_id = $1 AND changed_at > $2
                                        AND area IN ('components', 'prescription') AND COALESCE(changed_by, '') NOT LIKE 'AVS%' LIMIT 1`, [kit.id, r.saved_at]);
      if (worked) why.push(`${worked.changed_by} has worked on the kit since`);
      if (kit && await oc(`SELECT 1 AS y FROM fluence_mail_readings WHERE kit_id = $1 AND id <> $2 AND status = 'saved' LIMIT 1`, [kit.id, r.id])) why.push('a later mail was saved to it');
      if (why.length) throw fail(409, `The kit this mail made is kept: ${why.join('; ')}. Change it in the Fluence master instead.`);
      if (r.created_product_id) await qc('UPDATE artwork_jobs SET product_id = NULL WHERE product_id = $1', [r.created_product_id]);
      if (kit) await qc('DELETE FROM fluence_kits WHERE id = $1', [kit.id]);
      if (r.created_product_id) await qc('DELETE FROM products WHERE id = $1 AND is_draft = 1', [r.created_product_id]);
    } else {
      const kit = await oc('SELECT * FROM fluence_kits WHERE id = $1 FOR UPDATE', [r.kit_id]);
      if (!kit) throw fail(409, 'That kit is no longer in the Fluence master.');
      const before = ch.before || {};
      const after = ch.after;
      if (!after) throw fail(409, 'This reading was saved before Undo could tell what changed since — put it right in the Fluence master instead.');
      const product = kit.product_id ? await oc('SELECT id, code, name, mrp FROM products WHERE id = $1 FOR UPDATE', [kit.product_id]) : null;
      const nowComps = await componentsSnapshot(kit.id, qc);
      const nowRx = await rxSnapshot(kit.id, qc);
      let comps = nowComps.map(c => ({ ...c }));
      let touched = false;
      if (ch.components_changed) {
        if (componentsSignature(nowComps) === componentsSignature(after.components)) {
          comps = (before.components || []).map(c => ({ ...c }));
          touched = true;
        } else {
          // item by item: an MRP the reading set, put back where it is still what the reading set
          for (const c of comps) {
            const a = list(after.components).find(x => x.inner_product_id === c.inner_product_id);
            const b = list(before.components).find(x => x.inner_product_id === c.inner_product_id);
            if (!a || !b || sameMrp(a.mrp_in_kit, b.mrp_in_kit)) continue;
            if (sameMrp(c.mrp_in_kit, a.mrp_in_kit)) { c.mrp_in_kit = b.mrp_in_kit; touched = true; } else left.push(`${c.name} MRP was changed again after this mail (now ${plain(c.mrp_in_kit)}) — left as it is`);
          }
          const sameSet = (x, y) => JSON.stringify(list(x).map(c => c.inner_product_id).sort()) === JSON.stringify(list(y).map(c => c.inner_product_id).sort());
          if (!sameSet(before.components, after.components)) left.push('the kit list was changed again after this mail — its items are left as they are');
        }
      }
      let rx = nowRx;
      if (ch.rx_changed) {
        if (Number(nowRx?.revision) === Number(after.rx_revision)) { rx = before.rx; touched = true; } else left.push(`the prescription was changed again after this mail (now revision ${nowRx?.revision}) — left as it is`);
      }
      if (touched) {
        const body = { components: comps.map(c => ({ inner_product_id: c.inner_product_id, qty_per_kit: c.qty_per_kit, mrp_in_kit: c.mrp_in_kit, remarks: c.remarks })),
          general_instructions: rx?.general_instructions ?? null, remarks: rx?.remarks ?? null, lines: list(rx?.lines).map(lineBody) };
        await saveKitAndRx({ kit, product, outer: null, body, user: me, from: 'fluence_master' }, qc, oc);
      }
      if (ch.kit_total) {
        if (sameMrp(kit.kit_total_mrp, after.kit_total_mrp)) await putKitTotal(qc, kit, product, before.kit_total_mrp ?? null, me);
        else left.push(`the kit MRP was changed again after this mail (now ${plain(kit.kit_total_mrp)}) — left as it is`);
        if (product && !sameMrp(before.carton_mrp, after.carton_mrp)) {
          if (sameMrp(product.mrp, after.carton_mrp)) await putCartonMrp(qc, product, before.carton_mrp ?? null, me);
          else left.push(`the carton MRP was changed again after this mail (now ${plain(product.mrp)}) — left as it is`);
        }
      }
    }
    await qc(`UPDATE fluence_mail_readings SET status = 'undone', undone_at = now(), undone_by = $2 WHERE id = $1`, [id, user.name]);
    await audit('fluence_mail_reading', id, 'undo', `Undone${r.created_kit_id ? ' — the kit (and draft carton) it made removed' : ''}${left.length ? `; left as it is: ${left.join('; ')}` : ''}`.slice(0, 2000), qc, user.name);
    return { undone: id, left };
  });
}

// Management has read it: the readings and the MRP changes they made.
export async function ackReadings(ids, user) {
  return tx(async qc => {
    const rows = await qc(`UPDATE fluence_mail_readings SET ack_at = now(), ack_by = $2 WHERE id = ANY($1::int[]) AND ack_at IS NULL RETURNING id, changes`, [ids, user.name]);
    const mrp = rows.flatMap(x => list(x.changes?.mrp_change_ids));
    if (mrp.length) await qc(`UPDATE fluence_mrp_changes SET ack_at = now(), ack_by = $2, ack_by_id = $3 WHERE id = ANY($1::int[]) AND ack_at IS NULL`, [mrp, user.name, user.id ?? null]);
    return { acknowledged: rows.length };
  });
}

// "To look at": what waits on a person — held or not matched until someone applies it or keeps the master; saved, or a
// PO that differs, until management acknowledges it.
export async function listReadings({ view = 'all' } = {}) {
  return q(`
    SELECT r.id, r.source, r.status, r.hold_reason, r.kit_name, r.kit_code, r.subject, r.from_email, r.received_at, r.read_from, r.sure, r.unsure,
           r.changes, r.saved_at, r.saved_by, r.ack_at, r.ack_by, r.undone_at, r.undone_by, r.dismissed_at, r.dismissed_by, r.artwork_version_id, r.reading,
           k.kit_name AS kit, p.code AS product_code, p.name AS product_name, cp.code AS created_product_code, m.view_url
      FROM fluence_mail_readings r LEFT JOIN fluence_kits k ON k.id = r.kit_id LEFT JOIN products p ON p.id = r.product_id
      LEFT JOIN products cp ON cp.id = r.created_product_id LEFT JOIN artwork_mails m ON m.id = r.mail_id
     WHERE $1 = 'all'
        OR r.status IN ('held', 'not_matched')
        OR (r.ack_at IS NULL AND (r.status = 'saved' OR (r.status = 'compared' AND jsonb_array_length(COALESCE(r.changes->'differs', '[]'::jsonb)) > 0)))
     ORDER BY r.id DESC LIMIT 300`, [view]);
}
