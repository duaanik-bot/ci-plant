# Master File Repository & Auto-Sync — Design

**Date:** 2026-07-30
**Status:** Approved for planning
**Module keys touched:** `masters`, `orders`, `planning`, `artwork`, `production`,
`print_planning`, `floor`, `procurement`, `dispatch_invoice`

---

## 1. Problem

Approved artwork, output/imposition files, customer-approved PDFs and shade-card
scans have no home in the ERP. Today they live on WhatsApp, on the DTP machine
and in email, and every department that needs one asks for it again.

The goal is a single source of truth: a file is uploaded once, promoted to the
Product Master, and from then on it travels with the product through every
record the plant creates — without anyone re-uploading it, and without any
department ever working from a superseded version.

### What the code actually looks like today (verified 2026-07-30)

Three findings shaped this design, and each contradicts an assumption in the
originating requirements document.

1. **There is no artwork file upload in the ERP at all.** `/artwork` is approval
   *flags* only — `order_lines.artwork_customer_ok`, `artwork_qa_ok`,
   `artwork_locked`. Files exist in exactly two places: `shade_card_docs` and
   `message_attachments` (chat). So this is not a de-duplication exercise. It is
   "build file handling once, in the right place, before it gets built five
   times." **Nothing needs migrating.**

2. **The 4 MB ceiling is real and was already learned the hard way.** Commit
   `5c17abf` — *"the 15 MB upload limit was never true in production"*. Vercel
   refuses a request body past ~4.5 MB before Express ever sees it, so both
   existing file features are hard-capped at 4 MB. A print-ready approved artwork
   PDF is 5–50 MB; an output/imposition file or a native `.ai`/`.cdr` is
   routinely 20–200 MB. **The two headline categories cannot fit through the
   current pipe at all.** This is the reason the design does not store bytes in
   Postgres.

3. **Two patterns already exist that this must ride, not reinvent.**
   - `server/src/record-entities.js` — a closed `(entity, entity_id)` registry
     that already makes conversations work on 20 record types, `product`
     included.
   - The **"Sync Master?"** modal in `client/src/pages/Artwork.jsx:719`, with the
     buttons `Update Master` / `This Job Only`, already ships for text fields
     (`output_number`, `shade_card_number`, `block_number`). The file prompt is
     that same question applied to files and must reuse the same words.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Supabase Storage**, bytes never through the Vercel function | The whole feature is a lie at a 4 MB cap; output and native artwork files are the point |
| D2 | **Pin at lock, flag afterwards** | A dispatched batch must be provable against the artwork it actually ran on |
| D3 | **Three tables** — `files` / `product_files` / `record_files` | One job each; "one active file per slot" becomes a DB guarantee |
| D4 | **Two permission tiers**, `master_files` flag, **no admin bypass** | Same reasoning `db.js` already gives for `xs_approver` |
| D5 | **Five versioned slots + one open `supporting` drawer** | Resolves "up to 5 files" vs six listed categories |
| D6 | **No "appears to be newer" inference** | The system can honestly know only that the checksum differs |
| D7 | Master promotion & propagation are **Product-only** in wave 1 | Tables are polymorphic; other masters get plain attachments |
| D8 | **Nothing is hard-deleted** | Soft delete + archive; GC touches only uncommitted uploads |

### D6 in full, because it is a deliberate narrowing

The requirements ask the system to detect *"this appears to be a newer approved
artwork."* All the system can honestly know is that the checksum differs from
the active master and that the filenames differ. Anything more — parsing a
revision out of a filename — is a guess that will eventually be wrong, and one
wrong "this is newer" teaches the plant to click through the prompt without
reading it. The modal therefore states **facts** (which version the master
holds, who promoted it, when, both filenames side by side) and lets the person
decide.

### D7 in full

`record_files` is polymorphic over `ENTITIES` from day one, so any record type
can carry attachments. But *master promotion* and *pin propagation* apply only
to `products` in wave 1. A board PO, a machine or a customer simply shows no
master files — correct, not a gap. Extending promotion to another master later
is new code against the same tables, never a data migration.

---

## 3. Data model

All of this goes in `server/src/db.js` → `init()`, then
`npm run db:baseline`, then a named migration
`supabase/migrations/0010_master_files.sql`. Every statement is idempotent and
ordered after the table it touches, per `CLAUDE.md`.

```sql
-- ── The bytes. Written once, never updated. ─────────────────────────────────
-- A row is created when an upload is SIGNED and only becomes visible to the
-- rest of the ERP when it is COMMITTED, which is when we have confirmed the
-- object actually landed in the bucket.
CREATE TABLE IF NOT EXISTS files (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,          -- 'products/1372/8f3a…-artwork.pdf'
  file_name TEXT NOT NULL,                   -- what the operator saw on their machine
  mime TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum TEXT,                             -- sha-256 hex; NULL above 25 MB (§5)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  uploaded_by TEXT,
  uploaded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_pending
  ON files (created_at) WHERE status = 'pending';

-- ── The Master File Repository. ─────────────────────────────────────────────
-- One ACTIVE row per (product, category) for the five real slots. Every
-- superseded row stays forever as history.
CREATE TABLE IF NOT EXISTS product_files (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN
    ('approved_artwork','output_file','customer_approved_pdf',
     'shade_card_scan','printing_reference','supporting')),
  version_no INTEGER NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  replace_reason TEXT,                       -- optional, captured at promotion
  superseded_by INTEGER REFERENCES product_files(id),
  promoted_from_entity TEXT,                 -- which module it was promoted FROM
  promoted_from_id INTEGER,                  -- NULL when promoted in Masters
  created_by TEXT,
  created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  archived_by TEXT
);

-- THE slot rule, enforced by Postgres rather than by hopeful code. 'supporting'
-- is excluded: it is the open drawer that may hold many active documents.
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_files_active
  ON product_files (product_id, category)
  WHERE status = 'active' AND category <> 'supporting';

CREATE INDEX IF NOT EXISTS idx_product_files_product
  ON product_files (product_id, category, version_no DESC);

-- ── What a NON-product record carries. ──────────────────────────────────────
-- Either its own attachment (file_id) or a PIN to a master version
-- (product_file_id). Never both, never neither.
CREATE TABLE IF NOT EXISTS record_files (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity TEXT NOT NULL,                      -- a key from record-entities.js
  entity_id INTEGER NOT NULL,
  file_id INTEGER REFERENCES files(id),
  product_file_id INTEGER REFERENCES product_files(id) ON DELETE RESTRICT,
  category TEXT,                             -- transaction attachments only
  note TEXT,
  pinned_at TIMESTAMPTZ,
  pinned_reason TEXT,                        -- artwork_locked | jc_finalised | dispatched
  uploaded_by TEXT,
  uploaded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  CHECK ((file_id IS NULL) <> (product_file_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_record_files_rec
  ON record_files (entity, entity_id) WHERE deleted_at IS NULL;

-- Backstop for double-pinning. The real idempotency is in pinRecordFiles().
CREATE UNIQUE INDEX IF NOT EXISTS ux_record_files_pin
  ON record_files (entity, entity_id, product_file_id)
  WHERE product_file_id IS NOT NULL AND deleted_at IS NULL;

-- ── Download history. Deliberately NOT audit_log. ───────────────────────────
-- Every operator opening the artwork on every job would flood the plant's
-- global History drawer into uselessness. Surfaced in the file's own history.
CREATE TABLE IF NOT EXISTS file_downloads (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  entity TEXT, entity_id INTEGER,            -- which screen it was pulled from
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_downloads_file
  ON file_downloads (file_id, at DESC);

-- ── Permission. Same shape and same reasoning as xs_approver. ───────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS master_files INTEGER NOT NULL DEFAULT 0;
UPDATE users SET master_files = 1
WHERE email IN ('md@motionci.com', 'plant@motionci.com')
  AND NOT EXISTS (SELECT 1 FROM users WHERE master_files = 1);
```

### The key move: a live master file is not a row

An unpinned master file is **never materialised**. A record's file panel is
computed on read as:

```
  its own attachments          record_files WHERE file_id IS NOT NULL
+ its pins                     record_files WHERE product_file_id IS NOT NULL
+ if a slot is unpinned:       product_files WHERE status='active'
                               for the product this record resolves to
```

So "the latest approved master automatically travels with every new record"
costs **zero writes and cannot drift** — there is no copy to go stale. Pinning
is the only thing that writes, and it happens once per record, at lock.

### `ON DELETE RESTRICT` on the pin is intentional

Deleting a product whose artwork a dispatched job pinned is **refused**. That is
correct for traceability, and rare in practice: this ERP deactivates products
(`products.active = 0`) rather than deleting them.

---

## 4. Storage layer

`server/src/storage.js` — one interface, two drivers:

```js
putUrl(key, { mime, size })  // → { url, method, headers }  signed, 2 h TTL
getUrl(key, { inline })      // → signed download URL,       5 min TTL
head(key)                    // → { exists, size }           verifies the commit
remove(key)                  // → GC for abandoned pending rows
```

- **`local`** — writes `server/.filestore/` (gitignored); URLs point at our own
  Express routes. This is what `npm run dev` uses.
- **`supabase`** — Storage REST over global `fetch`. **No new npm dependency.**

Selected by `FILE_STORAGE`, defaulting to `local` whenever `DATABASE_URL` is
unset — preserving the repo's "local development needs no `.env`" property.

Different TTLs for different risks: 90 MB over plant wifi can outlive a short
upload window, so upload URLs get 2 hours; download URLs get 5 minutes because
they are handed to a browser and should not be forwardable for long.

### Bytes never pass through the Vercel function

This is the property that makes the whole feature possible, and every endpoint
below preserves it. Upload = browser PUTs straight to the bucket.
Download/preview = the server **302-redirects** to a signed URL.

---

## 5. Upload — three legs

1. **`POST /api/files/sign`** — `{ entity, entity_id, category, file_name, mime,
   size_bytes, checksum }`. Server checks permission, validates the category
   against the entity, checks size against the per-category ceiling, sanitises
   the filename, mints a `storage_key`, inserts a `pending` `files` row, returns
   the signed PUT URL.
2. **Browser PUTs the bytes straight to the bucket**, with a real progress bar
   off XHR upload events.
3. **`POST /api/files/:id/commit`** — server `head()`s the object, confirms it
   exists and its size matches what was declared, and flips `status='ready'`.
   **Only now does the file exist to the ERP.** What happens next depends on
   whether the prompt is warranted (§6):
   - **Prompt not warranted** — the `record_files` attachment row is written in
     the same request, and the response carries no `prompt`.
   - **Prompt warranted** — *no row is written yet.* The response carries the
     `prompt` payload, and exactly one of its three outcomes writes it.

   A committed-but-unresolved file is therefore `ready` with nothing pointing at
   it — swept by the same GC pass described below.

**Size ceilings** become a declared number rather than a platform accident:

| Category | Ceiling |
|---|---|
| `approved_artwork`, `output_file` | 250 MB |
| `customer_approved_pdf`, `shade_card_scan`, `printing_reference`, `supporting` | 25 MB |

Checked client-side **at pick time** — the lesson from `5c17abf`, tell the
operator before the bytes leave the machine and name the actual size — and again
server-side at sign. `multer` is not involved anywhere in this flow.

`defParamCharset`-equivalent care: filenames arrive as JSON, not multipart, so
the mojibake bug fixed in `5c17abf` cannot recur here. Filenames are still
sanitised (path separators, control characters, length) before becoming part of
a `storage_key`.

### Checksums are computed only below 25 MB

`crypto.subtle.digest` needs the whole file as one `ArrayBuffer`. Doing that to
a 200 MB output file on a plant tablet is a stall the operator will read as a
crash. So the browser computes a sha-256 **only for files ≤ 25 MB**; above that
`checksum` stays NULL, which the schema already allows.

The only thing a NULL checksum costs is the "identical file, no prompt"
shortcut in §6 — so for a big output file the prompt always fires. That is the
correct default anyway: it asks rather than assumes.

### Garbage collection is lazy, because there is no cron

`vercel.json` defines no cron jobs and this design does not add one. GC runs
**opportunistically inside `POST /api/files/sign`**: before minting a new key,
sweep up to 20 rows that are either `pending` or `ready`-with-nothing-pointing-
at-them and older than 24 h, removing their objects. Bounded work on a request
that is already doing storage I/O, and self-healing — the sweep only matters
when uploads are happening, which is exactly when abandoned rows appear.

---

## 6. The "Update Master?" prompt

Fires at commit, and only when **all four** hold:

1. the record resolves to a product, **and**
2. the category is one of the five slots (not `supporting`), **and**
3. the user holds `master_files`, **and**
4. the file's checksum differs from the active master in that slot.

It is the existing `Sync Master?` modal, unchanged in shape:

| Situation | Body |
|---|---|
| Slot empty | "Save this as the **Approved Artwork** in the Product Master? It will then travel with every future job for CI-1372." |
| Slot holds an older version | "The Product Master holds **Approved Artwork v2**, promoted 12 Jul by Ramesh — `carton-front-v2.pdf`. Replace it with `carton-front-v3.pdf` as **v3**?" |
| Checksum matches the active version | *No prompt.* Link the existing master version instead of storing a second copy of the same bytes. |

Buttons: **`Update Master`** · **`This Job Only`** · **`Cancel`** — exactly as
`Artwork.jsx:722` reads today.

- **`Update Master`** → optional one-line reason, then a new `product_files` row
  at `version_no = max+1`; the previous active row flips to `archived` with
  `superseded_by` set and `archived_at`/`archived_by` stamped;
  `promoted_from_entity`/`promoted_from_id` record which module it came from.
- **`This Job Only`** → a plain `record_files` attachment. The master is untouched.
- **`Cancel`** → the committed file is discarded and its object removed.

A user **without** `master_files` never sees the prompt; their upload is always
a transaction attachment. This is deliberate — the prompt is not a teaser for a
permission you do not have.

---

## 7. Pinning and drift

`pinRecordFiles(entity, id, reason)` copies the currently-active `product_files`
ids into `record_files` with `pinned_at` and `pinned_reason`. It is idempotent:
if the record already carries any pin, it returns without writing.

| Trigger | Record pinned | Hook site |
|---|---|---|
| `artwork_locked = 1` | `order_line` | `server/src/routes/orders.js` |
| Job card finalised | `job_card` | `server/src/helpers.js` (`finaliseBlock` path) |

The existing DangerZone rollback deletes the pins, because the line genuinely is
open again.

### Dispatch is read-through, not a third pin

**Corrected 2026-07-30 during planning.** An earlier draft named "dispatch
created" as a third trigger. It is not buildable and not needed:

`dispatches` has no `product_id` — a challan hangs off an *order* and carries
many `dispatch_lines`, each with its own product. So there is no single product
whose master files could be pinned to a `dispatch`. (The
"all lines must be for the same product" 409 in `routes/dispatch.js` is scoped
to one FG-box endpoint, not a table-level rule.)

It is also redundant. Every `dispatch_line` points at an `order_line`, and that
line was pinned at artwork lock — so the chain *challan → line → pin* already
proves what a dispatched batch was printed against. The Dispatch panel
therefore **reads through** to its lines' `order_line` pins and adds nothing of
its own, which is exactly the "reference only" role the requirements gave it.

### What the panel shows once a record is pinned

One consistent rule — *show the pin, and show how the master differs from it*:

| State | Presentation |
|---|---|
| Pinned version, master unchanged | Normal. `MASTER · v2` |
| Pinned v2, master now active at v3 | **Amber**: `Master moved to v3 · this job ran v2`, with a link to view both |
| Slot empty at pin time, master filled later | **Muted**: `Output File v1 · added to master after this job locked` — viewable, clearly not what the job ran on |

Never a silent swap, in any of the three states. The amber language matches what
cutting variance and shade-card expiry already use.

**No backfill.** Records that exist when this ships carry no pins. An *open*
line whose product later gains master files shows them live; a closed job card
shows nothing, which is honest — we do not know what it actually ran.

---

## 8. API

```
POST   /api/files/sign                  → { file_id, upload: { url, method, headers } }
POST   /api/files/:id/commit            → { file, prompt? }   prompt = the Update Master? payload
DELETE /api/files/:id                   → discard an uncommitted file (Cancel)

GET    /api/files/:id/download          → 302 signed URL, + file_downloads row
GET    /api/files/:id/preview           → 302 signed URL, inline disposition

GET    /api/records/:entity/:id/files   → { attachments[], pinned[], master[] }
POST   /api/records/:entity/:id/files   → attach a committed file to a record
DELETE /api/record-files/:id            → soft delete

GET    /api/products/:id/files          → { slots[], history[] }
POST   /api/products/:id/files/promote  → { product_file }   promote a ready file into a slot
POST   /api/product-files/:id/archive   → archive an active version
POST   /api/product-files/:id/restore   → re-promote an archived version as a NEW version
GET    /api/product-files/:id/downloads → this version's download history
```

`:entity` is validated through `entityOr400()` before it can reach SQL — the
same gate conversations use. Restore never rewinds in place; history is
append-only.

**The panel's read model.** `GET /api/records/:entity/:id/files` returns three
lists, and drift is a field on the entries rather than a fourth list:

- `attachments[]` — this record's own files
- `pinned[]` — each carries
  `drift: null | { kind: 'moved', master_version, master_file_id }`
- `master[]` — active master versions in slots that were **not** pinned, each
  carrying `added_after_lock: true` once the record is pinned at all

That is the §7 table expressed as data: one rule — show the pin, and show how
the master differs from it.

---

## 9. Client

| File | Purpose |
|---|---|
| `client/src/components/FilePanel.jsx` | The panel. `<FilePanel entity="job_card" id={jc.id} />` |
| `client/src/components/FileViewer.jsx` | Preview modal |
| `client/src/lib/upload.js` | Three-leg upload with progress, size pre-check, checksum |

The panel renders **two visually distinct groups** — *From Product Master*
(indigo, `MASTER · v3` chip, matching the blue already assigned to `product` in
`Timeline.jsx` `ENTITY_META`) and *On this record* (neutral). Columns: File Name
· Type · Category · Version · Uploaded By · Date · Source · Preview · Download.
On plant tablets it collapses to cards, the `.ci-line-item` treatment
Procurement already uses.

### Preview

| Type | Behaviour |
|---|---|
| PDF | `<iframe>` at the signed URL — browsers render PDF natively, no pdf.js in the client bundle |
| JPG / PNG / SVG | `<img>`, pan and zoom. `<img>` does not execute script inside an SVG, so this is safe by construction |
| AI / CDR / everything else | *"Preview not supported — Illustrator file, 84 MB"* + Download. No fake preview |

Print reuses `window.print()` on the preview iframe, consistent with the existing
print templates. "Open in new window" is the signed URL. Everything not being
previewed is served `Content-Disposition: attachment`.

### Mount points (wave 1)

| Surface | Page | Entity |
|---|---|---|
| Product Master | `Masters.jsx` → Products | `product` — *the repository editor* |
| Sales Order | `Orders.jsx` | `order_line` |
| Planning | `Planning.jsx` | `order_line` |
| Artwork | `Artwork.jsx` | `order_line` |
| Job Card | `Production.jsx`, `JobCardPrint.jsx` | `job_card` |
| Printing Planning | `PrintPlanning.jsx` | `job_card` |
| Printing / QC | `Section.jsx`, `Floor.jsx` | `job_card` |
| Procurement | `Procurement.jsx` | `purchase_order` (attachments only) |
| Dispatch | `Dispatch.jsx` | `dispatch` — read-through to its lines' `order_line` pins (§7); no pins of its own |

Because the panel is keyed by `(entity, id)` and `record-entities.js` validates
the entity, a tenth surface is a one-line change.

**Masters → Products** gets the repository editor: five slot cards shown even
when empty (*"No approved artwork yet — Upload"*), each with a version-history
disclosure listing every archived version with uploader, date, reason and a View.

---

## 10. Permissions

Two tiers.

| Tier | Who | May |
|---|---|---|
| 1 | Everyone signed in | View, preview, download; attach a transaction-only file to a record they can already see; soft-delete **their own** attachment within 10 minutes (the window the messenger already uses) |
| 2 | `users.master_files = 1` | Everything above, plus promote, replace, archive and restore master files |

**Admin does not bypass tier 2**, for exactly the reason `db.js` already records
for `xs_approver`: several plant logins carry `role=admin`, and a role check
would hand the power to overwrite approved artwork back to all of them.

Seeded to `md@` and `plant@` on the existing precedent. **Whoever runs DTP
should be granted it in Masters → Users** — they hold the approved files in
practice. The flag is edited alongside `xs_approver` and `is_management`, and is
returned in the auth payload by `server/src/auth.js`.

The requirements' *"View Restricted Files"* is **cut**: there is no notion of a
restricted file in the ERP today and no stated need. A `visibility` column on
`files` is a purely additive migration if that changes.

---

## 11. Audit

Reuses `audit_log`, keyed to **`entity='product'`** rather than a new entity
type — so a product's file lifecycle appears inline in the existing History
drawer under the blue `Box` icon it already has, next to everything else about
that product. No `ENTITY_META` change needed.

| Action | Entity | Detail carries |
|---|---|---|
| `file_promoted` | `product` | category, version, filename, source module |
| `file_replaced` | `product` | category, v2→v3, reason, source module |
| `file_archived` / `file_restored` | `product` | category, version |
| `file_attached` / `file_removed` | the record | category, filename |
| `files_pinned` | the record | which versions, pin reason |

Downloads go to `file_downloads`, not `audit_log` — see §3.

---

## 12. Failure modes

| Failure | Behaviour |
|---|---|
| Upload lands, commit never fires (wifi drops, tab closed) | Row stays `pending`, invisible everywhere. The lazy GC in `sign` sweeps it after 24 h, object included |
| Commit succeeds but the prompt is never answered (tab closed mid-modal) | Row is `ready` with nothing pointing at it — same 24 h sweep |
| Commit fires but the object is not there | `head()` misses → 400 with a readable sentence; `files` row deleted. Never a phantom row pointing at nothing |
| Signed URL replayed with different bytes | Declared size ≠ actual at commit → reject, delete row and object |
| Upload URL expires mid-upload | 2 h TTL; the client surfaces a retry that re-signs rather than failing the whole pick |
| Two people promote the same slot at once | `ux_product_files_active` fails the loser's INSERT. Caught and answered as a **structured 409** (the pattern already used in this codebase) saying the master moved to v3, offering to re-open the prompt against the new state |
| Supabase Storage unreachable | Sign returns "File storage is unavailable", not a 500. Metadata still lists from Postgres — the page degrades to read-only, it does not break |
| Product deleted while a record pinned its artwork | `ON DELETE RESTRICT` refuses the delete. Correct for traceability; rare, since products are deactivated not deleted |
| File left behind by `Cancel` | Explicitly discarded by `DELETE /api/files/:id`; the lazy GC is the backstop if the browser never sends it |

---

## 13. Testing

Node's built-in runner, `server/src/*.test.js`, matching the ~20 existing test
files. Logic is extracted into pure modules so it tests without a database — the
same shape as `board-math.js`, `chat-rules.js` and `readiness-light.js`.

| Module | Covers |
|---|---|
| `file-rules.js` / `.test.js` | Category validation, per-category size ceilings, mime → preview kind, the four-condition "should the prompt fire?" predicate, filename sanitisation, storage-key minting |
| `product-for-record.js` / `.test.js` | Entity → `product_id` resolution, **including entities that legitimately have none**. Plus a parity test in the spirit of `record-entities.test.js`: every entity in the resolver must exist in `ENTITIES`, and every table/column it names must exist in `db.js` — the guard that stops a schema rename quietly killing the panel |
| `storage.js` | The `local` driver tested directly; the `supabase` driver behind the same interface so tests never touch the network |
| Version chain | promote → promote → archive → restore: `version_no` monotonicity, exactly one active row per slot, unbroken `superseded_by` chain |
| Pin idempotency | Double-lock writes one pin; rollback clears it; re-lock re-pins against the *current* master |

Then `npm run verify` (baseline freshness + server tests + client build) per
`CLAUDE.md`.

---

## 14. Build order

Each step leaves the app working.

1. **Storage + `files` + sign/commit/download, `local` driver.** Nothing
   user-visible; fully tested.
2. **`product_files` + Masters → Products repository editor + version history.**
   The master repository becomes real.
3. **`record_files` + `<FilePanel>` + the read model**, mounted on Planning,
   Artwork and Job Card.
4. **The `Update Master?` prompt** + promotion from a record.
5. **Pinning at the three locks** + the drift presentation.
6. **Remaining mounts** (Orders, PrintPlanning, Section/Floor, Procurement,
   Dispatch) + `file_downloads`.
7. **Supabase driver + bucket + backup extension + deploy.**

---

## 15. Deployment

Follows `DEPLOYMENT.md` §3. The trap to respect: **editing `init()` does not
migrate production.**

1. `init()` change → `npm run db:baseline` → commit the regenerated
   `supabase/migrations/0001_baseline_schema.sql`
2. Named migration `supabase/migrations/0010_master_files.sql`
3. `npm run db:backup` before touching prod
4. `npm run db:check` against Supabase to confirm the drift is exactly this change
5. `npm run verify`

Three new things beyond the usual:

- Create the **private** Supabase Storage bucket `ci-files` in
  `colour-impressions-prod`. Private — no object is publicly reachable; every
  read goes through a short-lived signed URL minted after an auth check.
- Vercel production env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `FILE_STORAGE=supabase`. The service-role key is a **new secret** and must
  never reach the client bundle — it is read only in `server/src/storage.js`.
- **Extend `scripts/backup-prod.mjs` to cover the bucket.** Without this the
  promoted approved artwork is the only thing in the ERP with no backup, and it
  is precisely the thing that cannot be re-derived from anywhere else.

---

## 16. Future scalability — an honest answer

The requirements ask that future features be addable "without changing the
database structure." Strictly, that is not achievable — OCR needs somewhere to
put text. What this design **does** guarantee is that no future feature below
requires changing the three core tables or migrating any data:

| Future feature | How it lands |
|---|---|
| Digital approvals, customer approval workflow, e-signatures | New table referencing `product_files(id)`; `status` gains a value. `created_by`/`effective_from`/`replace_reason` are already there |
| File expiry alerts | Computable today from `effective_from`, exactly as the shade-card 1-year engine already works. One additive `expires_at` column only if per-file override is wanted |
| OCR / document indexing | New `file_text` table keyed on `file_id` |
| Automatic artwork comparison between versions | `superseded_by` already forms the chain — comparison is a pure read |
| Cloud storage optimisation, CDN, lifecycle tiering | `storage_key` is opaque and the driver is swappable. Already done |
| AI-assisted document validation | Reads `files` + `file_text`; writes its verdict to its own table |

---

## 17. Explicitly out of scope

- Any backfill of historical records
- Master promotion for customers, vendors, boards, tools or machines (D7)
- Restricted-visibility files (§10)
- Inference that one file is "newer" than another (D6)
- Replacing the `shade_card_docs` or chat attachment systems — both keep working
  unchanged; converging them onto `files` is a separate, later piece of work
