-- Billing entities — the plant sells under more than one name.
--
-- Colour Impressions is the house entity and stays the default. Galpha
-- Laboratories' cartons invoice and certify as Darbi Print Pack, a separate
-- registration with its own GSTIN, address and state. A customer therefore
-- points at the entity that bills it, and a document freezes the entity it was
-- raised under so a later master edit cannot rewrite a certificate or a bill
-- the customer already holds.
--
-- Place of supply reads the ENTITY's state, not a hardcoded 'Punjab': a Darbi
-- invoice to a Himachal customer splits CGST+SGST or charges IGST according to
-- where Darbi is registered, which is the whole point of separating them.

CREATE TABLE IF NOT EXISTS billing_entities (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  tagline TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  state_code TEXT,
  gstin TEXT,
  hsn TEXT,
  gst_rate INTEGER,
  jurisdiction TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- One default only. A partial unique index rather than a CHECK, because the
-- rule is "at most one row wins", not a per-row condition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_entities_one_default
  ON billing_entities (is_default) WHERE is_default = 1;

-- The house entity, seeded from the values billing.js has carried as a constant.
INSERT INTO billing_entities (name, tagline, address, city, state, state_code, gstin, hsn, gst_rate, jurisdiction, is_default)
SELECT 'Colour Impressions',
       'Manufacturers of Printed Packaging Cartons — Pharma & FMCG',
       'Vill Shamdo Road, Rajpura–Chandigarh Highway, Rajpura, Punjab 140401',
       'Rajpura', 'Punjab', '03',
       '03BCMPD4475P1Z7', '48192010', 18, 'Patiala', 1
WHERE NOT EXISTS (SELECT 1 FROM billing_entities WHERE name = 'Colour Impressions');

-- Darbi Print Pack. GSTIN and address recovered from the plant's own legacy
-- party master (rows 10/11, which are ALSO vendors 10/11 in this database) and
-- check-digit validated. Both entities are Punjab (03), so a Galpha invoice —
-- Himachal Pradesh — stays inter-state IGST either way.
--
-- CONFIRM BEFORE BILLING: these were recorded in Aug 2024, and the June 2026
-- "GSTIN MISMATCH / GST CORRECTIONS" correspondence shows Darbi's number being
-- re-issued to customers. Masters → Billing Entities is the place to correct it.
INSERT INTO billing_entities (name, tagline, address, city, state, state_code, gstin, hsn, gst_rate, jurisdiction, is_default)
SELECT 'Darbi Print Pack',
       'Manufacturers of Printed Packaging Cartons — Pharma & FMCG',
       'Village Dhakansu, Near Vijay Soap Factory, Rajpura–Chandigarh Road, Rajpura, Punjab 140401',
       'Rajpura', 'Punjab', '03',
       '03AXRPD1246K2ZI', '48192010', 18, 'Patiala', 0
WHERE NOT EXISTS (SELECT 1 FROM billing_entities WHERE name = 'Darbi Print Pack');

-- Which entity bills this customer. NULL = the default entity.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  billing_entity_id INTEGER REFERENCES billing_entities(id);

CREATE INDEX IF NOT EXISTS idx_fk_customers_billing_entity_id
  ON customers (billing_entity_id);

-- Galpha Laboratories bills as Darbi Print Pack.
UPDATE customers c SET billing_entity_id = (SELECT id FROM billing_entities WHERE name = 'Darbi Print Pack')
WHERE c.billing_entity_id IS NULL AND c.name ILIKE 'galpha%';

-- Frozen on the document, so history stays true when the master moves.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS
  billing_entity_id INTEGER REFERENCES billing_entities(id);
ALTER TABLE coas ADD COLUMN IF NOT EXISTS
  billing_entity_id INTEGER REFERENCES billing_entities(id);

CREATE INDEX IF NOT EXISTS idx_fk_invoices_billing_entity_id ON invoices (billing_entity_id);
CREATE INDEX IF NOT EXISTS idx_fk_coas_billing_entity_id ON coas (billing_entity_id);

-- Every document that already exists was raised under the house entity and went
-- out on its letterhead, so that is what it is pinned to — including Galpha's
-- five open CI-INV- invoices. Resolving them through the customer instead would
-- restate the SELLER on tax invoices the customer already holds, which is a
-- compliance decision and not something a schema migration gets to make
-- silently. It would also contradict the freeze these columns exist for.
--
-- Pinning is required, not optional: a NULL here falls back to the customer's
-- mapping at read time, so leaving history NULL would restate it just the same.
--
-- Restating them later, if that is genuinely wanted, is one deliberate UPDATE.
UPDATE invoices SET billing_entity_id = (SELECT id FROM billing_entities WHERE is_default = 1)
  WHERE billing_entity_id IS NULL;
UPDATE coas SET billing_entity_id = (SELECT id FROM billing_entities WHERE is_default = 1)
  WHERE billing_entity_id IS NULL;

-- The GSM a certificate declares, snapshotted when the draft is built and
-- editable through Edit COA. Read-only on the printed sheet.
ALTER TABLE coas ADD COLUMN IF NOT EXISTS gsm INTEGER;
