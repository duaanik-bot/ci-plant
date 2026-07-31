// PO-line ↔ product matching. The cases here are lifted from real Swiss Garnier
// POs (SGB/2627/POS/PMP/00769) against the real master names — the wave where
// every line came back unmatched although the catalogue held near-exact names.
//
// The killer was noise the customer prints INSIDE the description cell: their
// own item code ("PCS-E243") and the per-line delivery date ("05/06/2026").
// Six extra tokens against a 5-token name drag a word-for-word match from ~1.0
// to 0.68 — under the 0.85 auto-match bar, some under the 0.5 suggestion bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, normalize, matchLine, score } from './pomatch.js';

test('scrub drops per-line delivery dates and the leading customer item code', () => {
  assert.equal(
    scrub("PCS-E243 EUGI SACHETS CARTON 10X1g (SALES)-R3 05/06/2026 NOS"),
    'EUGI SACHETS CARTON 10X1g (SALES)-R3 NOS',
  );
});

test('scrub keeps tokens that merely look code-ish', () => {
  // Sizes, strengths and revision suffixes carry digits or hyphens but are part
  // of the name; a leading hyphenated word without digits is a name too.
  assert.equal(scrub('F-TRICHONOURISH GEL 100GMS LABEL'), 'F-TRICHONOURISH GEL 100GMS LABEL');
  assert.equal(scrub('DAYO OD 500MG TABLET CARTON 10X10'), 'DAYO OD 500MG TABLET CARTON 10X10');
  // Only the LEADING token can be an item code — SALE-R0 mid-line survives.
  assert.equal(scrub('GERIPAN DSR TABLET CARTON 10X10 SALE-R4'), 'GERIPAN DSR TABLET CARTON 10X10 SALE-R4');
});

const PRODUCTS = [
  { id: 1, name: "EUGI SACHETS CARTON 10X1g (SALES)-R3", code: 'SW-101', party_item_code: null },
  { id: 2, name: "EUGI CAPSULES CARTON 10 x 10's(SALES)-R3", code: 'SW-102', party_item_code: null },
  { id: 3, name: "GLIMINYLE MP2 TABLETSCARTON(10X15'S) (SALES)-R0", code: 'SW-103', party_item_code: null },
  { id: 4, name: 'GERIPAN DSR TABLET CARTON 10X10SALE-R4', code: 'SW-104', party_item_code: null },
];

test('a word-for-word name buried in code+date noise auto-matches', () => {
  const m = matchLine("PCS-E243 EUGI SACHETS CARTON 10X1g (SALES)-R3 05/06/2026 NOS", PRODUCTS, []);
  assert.equal(m.status, 'matched');
  assert.equal(m.best.product_id, 1);
  assert.ok(m.best.confidence >= 0.85, `confidence ${m.best.confidence} should clear the auto-match bar`);
});

test('a fused master name still surfaces as a suggestion through the noise', () => {
  // PDF: "PCS-G280 GLIMINYLE MP2 TABLETS 05/06/2026 NOS" — the master fuses
  // TABLETSCARTON into one token, so only bigrams can see the kinship. It was
  // 0.36 (invisible); scrubbed it must at least reach the suggestion list.
  const m = matchLine('PCS-G280 GLIMINYLE MP2 TABLETS 05/06/2026 NOS', PRODUCTS, []);
  assert.ok(m.status !== 'none', 'must not vanish entirely');
  assert.equal(m.suggestions[0]?.product_id, 3);
});

test('the customer item code still outranks fuzzy text when a master carries it', () => {
  const withPic = [...PRODUCTS, { id: 9, name: 'EUGI SACHETS CARTON', code: 'SW-999', party_item_code: 'PCS-E243' }];
  const m = matchLine("PCS-E243 EUGI SACHETS CARTON 10X1g (SALES)-R3 05/06/2026 NOS", withPic, []);
  assert.equal(m.best.product_id, 9, 'party_item_code must win over the fuzzy name');
  assert.equal(m.best.confidence, 0.98);
});

test('our own product code in the line is found even though it is hyphenated', () => {
  // normalize("SW-104") is the two words "SW 104" — the old words.includes()
  // lookup could never contain a two-word entry, so a line quoting our exact
  // code fell through to fuzzy scoring.
  const m = matchLine('SW-104 GERIPAN DSR TABLET 05/06/2026', PRODUCTS, []);
  assert.equal(m.best?.product_id, 4);
  assert.equal(m.best?.confidence, 0.95);
});

test('aliases learned before scrubbing existed still hit', () => {
  // Legacy rows in product_aliases were normalized from the FULL line text,
  // date and all. Lookup must try both spellings or past learning dies.
  const raw = "PCS-E243 EUGI SACHETS CARTON 10X1g (SALES)-R3 05/06/2026 NOS";
  const legacy = [{ alias_norm: normalize(raw), product_id: 2 }];
  const m = matchLine(raw, PRODUCTS, legacy);
  assert.equal(m.status, 'matched');
  assert.equal(m.best.product_id, 2);
  assert.equal(m.best.confidence, 1);
});

test('aliases learned after scrubbing hit a reprint carrying a different date', () => {
  const learned = [{ alias_norm: normalize(scrub('PCS-G280 GLIMINYLE MP2 TABLETS 05/06/2026 NOS')), product_id: 3 }];
  const reprint = 'PCS-G280 GLIMINYLE MP2 TABLETS 11/07/2026 NOS';
  const m = matchLine(reprint, PRODUCTS, learned);
  assert.equal(m.status, 'matched');
  assert.equal(m.best.product_id, 3);
});

test('scoring itself is unchanged for clean text', () => {
  const s = score('EUGI SACHETS CARTON 10X1g (SALES)-R3', PRODUCTS[0]);
  assert.ok(s > 0.9, `clean exact text should score ~1, got ${s}`);
});
