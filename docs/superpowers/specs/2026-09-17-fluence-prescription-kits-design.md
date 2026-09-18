# Fluence Prescription & Kit Master — design and review notes

Status: **LIVE on motionci.in from 2026-09-18** — sanctioned by Anik ("commit, push and deploy,
go live"). Migration `fluence_prescription_kits` applied to `ylbfeptgefzimcqnwphy`; the kit master
loaded with `scripts/import-fluence-kits.mjs --production --apply`. Built in worktree
`~/.config/superpowers/worktrees/ci-erp/fluence-prescription-kits` (branch
`feat/fluence-prescription-kits`), reviewed on a private clone of production (`localhost:5477`).

## What it does

A Fluence carton is a kit box. The plant prints the outer carton; Fluence packs several
items inside; the carton carries the prescription. This feature gives that knowledge one
master and shows it wherever the carton is handled:

- **Prescription** per Fluence product: one line per kit item — dosage/strength, form,
  pack count, Morning / Afternoon / Evening / Night quantities, an "other time" slot,
  frequency, instructions, remarks — plus general instructions for the kit.
- **Kit composition**: the inner products in each kit, quantity per kit, MRP in kit.
- **Inner product master**: every item, with carton L × W × H (blank until supplied).
- **Fluence button** (green pill) in Planning, Artwork, Job Cards, Print Planning (board cards,
  expanded lane tables, Completed tab), Printing,
  Sorting & Pasting, Invoice, Dispatch (incl. challan), Accounts, Warehouse (movement
  ledger and FG stock). It opens one drawer: Prescription · Kit & inner products ·
  Product & artwork · History. Gangs, invoices and challans open product-wise.
- **Job card print**: Fluence cards get an extra page after the traveler — the
  product-wise table (Product | Artwork Code | Prescription), then each carton's full
  dose table, revision stamp and kit contents. Non-Fluence cards are unchanged.
- **Fluence Master page** (`/fluence`, Admin group): products with kit/prescription
  status, the customer's kit list with link/suggestion/unlink, and the inner product
  master.

## Decisions (and why)

| Decision | Why |
|---|---|
| Fluence is switched on by data (`fluence_customers`), seeded from `customers.name ILIKE 'fluence%'` | A rename of the misspelled customer ("Fluence Pharamceuticals Pvt. Ltd. ") must not switch the feature off |
| Buttons decide visibility from `/fluence/scope` (product/customer ids) | No existing endpoint changes shape — proven byte-identical on 24 endpoints |
| Prescription is read **live** from the master on every screen and card | Matches the job card's existing live-join rule; entered once, never re-keyed |
| Every save names the revision it started from; stale saves get 409 | Two people editing at once cannot silently overwrite each other |
| Revision history (before/after, who, from which module) + audit_log | "The system should clearly indicate the master was updated" |
| Printed card warns when the prescription was entered/revised **after** finalise | Live data can change under a finalised card; the floor must see it |
| Edit rights = `PLANNING_ROLES` (admin, planner, production); everyone else reviews | Same people who already decide planning/artwork/job card work |
| Invoice, Dispatch, Accounts, Warehouse open **review-first** with a verification checklist | Brief §11: verification, not re-keying; edit stays one deliberate click away |
| Kit ↔ ERP product linked automatically **only on an exact name** | A wrong link prints the wrong prescription; weaker matches are suggestions a person confirms |
| Quantity per kit = number of times an item is listed | Σ line MRPs = kit total on all 297 itemised kits, so each line is one unit |
| A flat-priced kit shows its **line price**, never a sum (`kitListPrice`) | The 16 flat-priced kits repeat one figure on every line. On Topico, CGC and Umang that figure is the carton's own MRP, so a sum is several times the real price, e.g. ₹28,260 for a ₹4,710 carton. Kids Hair Fact Growth is the exception: its 2 × ₹1,116 lines add up to its ₹2,221 carton. "₹X on every line" is true for all 16, and the drawer shows it next to the carton MRP |
| Carton dimensions left NULL | Not present in any of the four source files; never estimated |
| Prescriptions come from the customer master ONLY (Anik, 2026-09-18: "one source of truth") | Each kit's prescription = its products in the master's SR order. The master has no day-wise schedule, so none is written or guessed; days and doses can be added by a person |
| All FKs into existing tables are `ON DELETE SET NULL/CASCADE` | Deleting a product or customer behaves exactly as today |

## Data model (`supabase/migrations/20260917120000_fluence_prescription_kits.sql`)

`fluence_customers`, `fluence_inner_products`, `fluence_kits`, `fluence_kit_components`,
`fluence_prescriptions`, `fluence_prescription_lines`, `fluence_master_revisions`,
`fluence_part_cartons`. Additive and idempotent; replayed by `init()` for local databases only.
No existing table or column is altered.

## API (`server/src/routes/fluence.js`)

- `GET /fluence/scope` · `GET /fluence/dossiers?product_ids=` · `GET /fluence/resolve?job_card_id|gang_run_id|order_line_id|invoice_id|dispatch_id=`
- `GET /fluence/job-cards/prescriptions?ids=` (print page, product-wise)
- `GET /fluence/job-cards/products?ids=` (≤200 per call) — which Fluence cartons each job card carries.
  Print Planning cards name only a lead product, so gang/run cards (and Completed rows, which carry
  no product id) ask this once per board through a batched client loader (`lib/fluenceJobCards.js`);
  the drawer then resolves the card's members fresh, product-wise.
- `PUT /fluence/products/:id/prescription` · `PUT /fluence/products/:id/components`
- `GET|POST /fluence/inner-products` · `PUT /fluence/inner-products/:id`
- `GET /fluence/products` · `GET /fluence/kits` · `GET /fluence/kits/:id/revisions`
- `POST /fluence/kits/:id/link` · `POST /fluence/kits/:id/unlink`

Reads answer an empty, switched-off feature if the tables do not exist (42P01), so code
deployed ahead of its migration cannot break any screen.

## Source data (`scripts/import-fluence-kits.mjs`)

From `Master from Customer.xlsx` (snapshot `scripts/data/fluence-customer-kits-2026-08-22.json`):
313 kits, 2,239 kit lines → 2,225 components (13 items appear twice), 149 inner products.
**311 of 313 linked:**
- 279 by exact name.
- 13 suggested matches **confirmed by Anik on 2026-09-17**.
- 18 matched **by hand on Anik's instruction on 2026-09-17**.
- 1, HAIRFACT ANAGEN EXTENSION → FP-354 ANAGEN EXTEND GOLD, **confirmed by Anik on 2026-09-18**.

1 re-listing is superseded ("POST M -V2" → "POST M - V2"). 1 is held back on purpose (below).
Dry-run by default, `--apply` to write; refuses any non-local database.

Confirmed links live in `scripts/data/fluence-kit-links-confirmed-2026-09-17.json` (the 13),
`…-2026-09-17-manual.json` (the 18) and `…-2026-09-18.json` (ANAGEN). Each maps party serial + kit
name → product code + product name, so a refreshed review copy — and production — gets the same
311 links from the importer.
The manual file says `"link_method": "manual"`, and each link records its evidence in `reason`,
which lands in the kit's History. Its `not_linked` list keeps the held-back kits and why.

Each pair is re-checked on every run. The importer reports and does not link a pair when:
- the kit at that party serial has been renamed;
- the product at that code has been renamed;
- the carton already carries another kit.

Proven with a deliberately wrong file before each apply.

How the 18 were matched (sources: Fluence's *Product Status Sheet* Master_Data — code, family, MRP —
and the *MRP Kits* price lists):

| Kits | Carton | Evidence |
|---|---|---|
| 5 Topico large kits (Mild–Moderate Melasma, Resistant Melasma, Post Acne PIH, Peri Oral, Peri Orbital) | the `… LARGE TOPICO KIT` carton (FP-263/282/278/267/274) | one outer carton per condition in the Topico family; its MRP equals the price on every kit line (4,710 / 5,331 / 4,755 / 6,506 / 5,209) |
| 5 Topico Night Active kits | the `… TOPICO NIGHT ACTIVE` carton (FP-286/304/300/295/290) | same; 3,071 / 3,692 / 3,116 / 3,570 match — **Peri Oral Night Active does not: the kit list says ₹4,223 on every line, the carton and Product Status Sheet ₹4,867** |
| LACTIHEALTH VEG-2 | FP-058 LACTIHEALTH V2 | third LACTIHEALTH kit ↔ third LACTIHEALTH carton (20251056–58); the other two already linked; no other LACTIHEALTH carton |
| HAIR FACT FPHL Pro / MPHL Pro / PRO IMMUNE GOLD PRO | FP-312 / FP-311 / FP-313 | same name without the HAIR FACT family word; Fluence lists all three under Hair Fact |
| SKIN FACT MALE ACNE 1 / GOLD / GOLD PLUS | FP-259 MALE ACNE / FP-257 MALE ACNE G / FP-258 MALE ACNE PLUS | each kit is exactly ₹126 above its carton — the only assignment where the gap agrees |
| PROFACT PENOTYPE MITOBOOST | FP-314 PHENOTYPE MITOBOOST | misspelling; the only MITOBOOST carton (Pro Fact) |

On all 250 linked itemised kits that have a carton MRP, the kit list is above the carton MRP (median gap
₹74). Every hand-linked pair fits that: gaps of ₹96–₹299.

Held back (not linked):
- **F-D-STRIDE**: no carton. The kit is three units of the item F-D-STRIDE, and neither the ERP nor
  the Product Status Sheet has a D-STRIDE carton.

HAIRFACT ANAGEN EXTENSION was held back on 2026-09-17: the only candidate, FP-354 ANAGEN EXTEND GOLD
(Hair Fact, added 19 May 2026, no MRP to compare), says GOLD and the kit does not. Anik confirmed the
pair on 2026-09-18 and it is linked. FP-354 still has no MRP in the ERP or the Product Status Sheet;
the kit list totals ₹4,896.

## Part cartons show the outer kit's prescription (Topico, 2026-09-18)

A Topico kit is printed as several cartons. Each customer kit is linked to its **outer carton**, the
one that carries the MRP. Its **part cartons** show that kit (Anik, 2026-09-18: "show the Topico part
cartons the outer kit's prescription"):
- the 5 large kits each have a filler, an inner box and a leaflet;
- the 5 night kits each have a tray, a separator and a leaflet, plus a filler on 2 of them.

That makes 32 part cartons.

How it works:
- **One table, `fluence_part_cartons`** (part product → outer product, part kind). A part points at
  its outer CARTON, not at a kit. It reads whatever kit the outer carton has now: unlink the outer
  and its parts show nothing; link it again and they follow.
- **One rule, `KIT_OF_CARTON` in `fluence.js`:** a carton's own kit, else its outer carton's. A carton
  with a kit of its own is never treated as a part. The dossier, the job card page and the product
  list all read through it. The dossier carries `part_of` (outer code, name, MRP, part kind) and
  `kit.parts`.
- **Edits from a part change the one kit.** `kitForProduct` resolves a part to its outer carton's kit,
  so a part never gets a kit of its own:
  - the revision counter is shared, so a stale save from either carton gets a 409;
  - the revision and audit line say "Saved from part carton FP-266 …";
  - if the outer carton has no kit, the save starts one on the OUTER carton.
- **Guard:** a customer kit cannot be linked to a part carton (409 names the outer). Fluence Master's
  link picker leaves parts out.
- **Screens:**
  - the drawer on a part shows a banner ("Leaflet of FP-263 — a part carton of …"), the outer
    carton's MRP, and every carton of the kit;
  - the printed job card page says "Leaflet of FP-263 … The prescription below is that kit's";
  - Fluence Master marks part rows, and each kit row counts its part cartons.
- **Data:** `scripts/data/fluence-part-cartons-2026-09-18.json` (32 parts, generated from exact names),
  applied by the importer with the same re-checks as the links. Each part name begins with its outer
  carton's condition and price (e.g. "MILD TO MODERATE MELASMA 4710 | …"). Each part also sits in the
  same run of Fluence item codes and carries the same LARGE/NIGHT remark.
- **Left out on purpose:** FP-268/269/270, the generic "SKIN FACT TOPICO" leaflet, filler and inner
  box. They belong to no one kit, and Fluence's sheet marks them Cancelled.

## Prescriptions from the customer master (2026-09-18)

Anik: "Master from Customer.xlsx … review this as one source of truth". Its seven sheets are:
Kits (Master), Kit Lines (Link), Products (Master), All Kit Cards, Search Kit, Source Data
(Original), and the hidden System sheet. Together they hold each kit's party serial, validity,
products in SR order, MRPs, total and type. **There is no day-wise schedule anywhere in it.**

- The importer writes each kit's prescription from the master: its products in SR order, one line
  each, revision 1 by Anik Dua (MD) "from customer master". It does this only for a kit with no
  prescription yet; anything a person enters is never overwritten.
- Screens show it as a plain product list ("Customer master · N products"), with a quiet note that
  the master has no day-wise schedule. The job card prints the same list; there is no "entered after
  finalise" warning for this first revision.
- Result: 312 kits filled (POST M -V2 is a duplicate listing; POST M - V2 carries it). All 312
  compared line by line with the master: 0 mismatches. 343 of 372 Fluence cartons show a
  prescription (311 kit cartons + 32 Topico parts).
- An earlier pass built prescriptions from the warehouse-photo reconciliation workbook. Anik did not
  ask for that. Those 122 were removed from the review database. The builder, reader and data were
  moved out of the worktree into `fluence-rx-tools/retired-photo-prescriptions/` — not deleted,
  and not part of the build.

Still without a prescription (29 Fluence cartons — no kit in the customer master):
- Not in the master, 25 cartons (16 on open orders): the NEO range (FP-357–366), Dr. Fact Shed
  Control and Volu-Boost, Skin Pride A-Clear, Skin Fact Hydra Boost, SkinFact Open Pores, V PRIME,
  V NEO B12, DUPA, M9O2+ / M10O2+ / F9O2+ / F10O2+, Rapid Weight Loss Shield VEG, Telogen Gold MYLC
  and Post Hysterectomy Reset.
- FP-367 PROFACT THAKASSEMIA VEG — looks like a misspelt duplicate of FP-198 PRO FACT THALASSEMIA
  VEG, which carries that master kit.
- FP-268/269/270 — generic Topico leaflet, filler and inner box, marked Cancelled in Fluence's sheet.

## Verification done

- Unit tests: 29 new (formatter/validator, kit matching, kit list price, part labels, prescription state); each guard
  shown to FAIL when its bug is reinstated. Full server suite 2,846/2,846. Client build OK. Schema baseline unchanged.
- Part cartons: `fluence-rx-tools/parts-check.mjs` — 24 checks, written first and failing 21/24 on
  the old code, then 24/24. It ran on a throwaway copy of the review database (`cierp_rxtest`,
  dropped afterwards). It checks:
  - a part shows the outer kit and its cartons;
  - a save from a part changes the one kit, with no kit of its own and a shared stale-save 409;
  - kit list edits from a part;
  - product list and kit rows;
  - a job card re-pointed to a leaflet prints the kit's prescription;
  - linking a kit to a part is refused;
  - a carton with its own kit is unchanged;
  - unlinking and relinking the outer carton;
  - a part whose outer has no kit starts it on the outer.

  Every one of the 372 Fluence cartons on the review database shows the kit the rule says (0
  mismatches). Real Chrome PDF of that job card: the Fluence page prints the kit's prescription
  with the part note.
- Kit links: importer dry run → apply → re-run (0 new links); a deliberately wrong links file had 3 of 4
  pairs refused, each with its reason. 18 manual links each carry a revision note with their evidence.
- The API UAT below was run on a database where "F 1 NEO D3" was still a suggestion. Since all
  suggestions were confirmed, re-run it only on a fresh mirror imported without confirmed links
  (`--links` pointing at a file with an empty `links` list). It writes test prescriptions.
- End-to-end API UAT: 53/53 (single product, stale-save refusal, revisions, permissions,
  multiple products, gang job card product-wise, artwork codes, resolve, kit qty
  validation, blank dimensions, suggestion link with carry-over, unlink, board lookup, isolation).
- Print Planning: button on exactly the Fluence cards (board 11/28, every lane's table, Completed
  45/317); real mouse clicks on a gang card's pill open the product-wise drawer without opening the
  card's job chooser or lifting a drag (both detectors proven against a real open/drag).
- Regression: `origin/main` and this branch served the SAME database side by side —
  24 existing endpoints byte-identical.
- Print: real Chrome PDFs of gang card 440, single card 427 and Swiss Garnier card 448
  — traveler pages text-identical to `origin/main`; Fluence cards gain one page; 448 gains none.
- Screens: the button is on exactly the Fluence rows and no others in all 12 lists checked
  (plus the three Print Planning views above).
- Escape over the Planning Engine closes the drawer first, the engine second.

## Going live (done 2026-09-18)

1. Committed on the branch, rebased on `origin/main`, `npm run verify` green.
2. Production backed up (`npm run db:backup`); `20260917120000_fluence_prescription_kits.sql`
   applied to `ylbfeptgefzimcqnwphy` as the named migration `fluence_prescription_kits`.
3. Pushed to `main` (Vercel builds motionci.in).
4. Kit master loaded: `DATABASE_URL=<prod> node scripts/import-fluence-kits.mjs --production --apply`.
   The switch refuses any remote database that is not `ylbfeptgefzimcqnwphy`, and moves the run
   to the session pooler (5432). Re-running it changes nothing: it never overwrites.

## Open items for Anik

- **FP-354 ANAGEN EXTEND GOLD has no MRP** in the ERP or in Fluence's Product Status Sheet; the kit
  list totals ₹4,896. Get the MRP to print from Fluence.
- **Peri Oral Melanosis Night Active MRP** — the kit list says ₹4,223, the carton (FP-290) and Fluence's
  Product Status Sheet ₹4,867. Confirm the printed MRP with Fluence.
- **29 Fluence cartons have no kit in the customer master** (list above; 16 on open orders) — no prescription until Fluence adds them to the master.
- **Day-wise schedules** — not in the customer master; add them per kit in the drawer, or send a file that has them.
- Carton dimensions for the 149 inner products (to be supplied).
