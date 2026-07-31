# Shade Card Module — Simplification

**Date:** 2026-07-30
**Module:** Quality → Shade Cards (`/shade-cards`, module key `shade_cards`)
**Goal:** rebuild the module around the seven real steps the plant follows, so it
can be operated with no training and maintained without holding twelve statuses
in your head. Nothing the ERP currently refuses may start being allowed, and no
existing data may be lost.

---

## 1. The real process

1. Create the shade card.
2. Dispatch it to the customer for approval.
3. Customer approves, signs and stamps it.
4. The approved card comes back and is recorded.
5. Planning issues it to the Printing department.
6. Printing runs colour against it.
7. Printing finishes; the card is returned and marked back in.

Steps 1–4 happen once per card. Steps 5–7 repeat for every job that uses it.
That distinction is the whole design: **one approval lifecycle, one repeating
custody loop.**

## 2. What is being replaced

| | today | after |
|---|---|---|
| Approval statuses | 12 | 4 |
| Physical zones | 3 (`triage`/`vault`/`on_press`) | 2, as a loop |
| Create-form inputs | 17 across 3 panels | 1 picker + 5 optional |
| Register tabs | 6 | 0 (tiles filter instead) |
| Sub-views | 3 (Register / Alerts / Reports) | 2 (Register / Reports) |
| Endpoints | 19 | 19 — 5 removed, 5 added, 1 renamed |
| `ShadeCards.jsx` | 998 lines | target ≈ 500 |

The endpoint count is flat, and deliberately so: five lifecycle endpoints
(`/revise`, both `/orders` links, `/to-vault`, `/print-stations`) are replaced by
five that carry the new requirements (`/prefill`, and the four retire-zone
routes). The saving is in what an operator must understand, not in route count.

### Production data that makes this safe

Checked against Supabase `colour-impressions-prod` on 2026-07-30:

| fact | count |
|---|---|
| Shade cards | 599 — **all** `customer_approved` / `triage` |
| Cards linked to a sales order | 0 |
| Cards carrying an artwork code | 0 |
| Revisions raised | 0 |
| Documents attached | 0 |
| Products with `output_number` | 5 of 1594 |
| Products with `party_artwork_code` | 1417 of 1594 |
| Products with free-text `shade_card_number` | 896 |

The twelve-status lifecycle has never been driven in the plant — the cards are a
bulk import sitting in a single state. Collapsing it therefore rewrites code,
not history.

## 3. Lifecycle

```
  draft ──Dispatch──▶ sent ──Record Approval──▶ approved
                       │  ▲                        │
                  Reject│  └──── Re-send ──────────┘
                       ▼        (renew / re-confirm)
                    rejected
```

`SHADE_STATUSES = ['draft', 'sent', 'approved', 'rejected']`

```js
TRANSITIONS = {
  draft:    ['sent'],
  sent:     ['approved', 'rejected'],
  approved: ['sent'],       // renewal after expiry, or a re-confirmation
  rejected: ['sent'],       // corrected and sent again
}
```

Deletion stays a soft `active = 0`, reversible, on any status.

### Two deliberate calls

**`expired` stops being a status.** Expiry is already derived from
`creation_date` + 365 days by `isExpiredByAge()`. Holding it as a status *as
well* meant one fact with two sources that could disagree. All age tracking and
every alarm survive unchanged; expiry simply becomes derived-only.

**`approved → sent` is the renewal edge.** A card past 365 days must be
re-approvable. Recording a fresh approval resets `creation_date`, restarting the
age clock. Without this edge an expired card would be a dead end.

### The custody loop

`In Store ⇄ With Printing`, repeatable, recorded per issue in
`shade_card_issues`. Not a status on the card — a card that is out on press is
still `approved`. Current holder is derived: the issue row with
`returned_at IS NULL`.

## 4. Data model

### `shade_cards` — two new columns

| column | type | purpose |
|---|---|---|
| `order_line_id` | `INTEGER REFERENCES order_lines(id)` | the permanent Sales Order link; every auto-populated field resolves through it |
| `output_no` | `TEXT` | the Output Code — absent from the card today |

Both nullable: the 599 legacy cards have no order line. Required by the create
form for anything new.

`order_line_id` is chosen over `order_id` because every field the PRD asks to
auto-populate — Order Quantity, Product, Board details, Print specs, AW code,
Output code, Revision — is line-level. The order is reached by join, so a card
navigates to its Sales Order in one click and the order lists its cards.

`shade_card_orders` is retained as the quiet "also used on these orders" list
for repeat orders of the same product.

### `shade_card_issues` — new

```sql
CREATE TABLE IF NOT EXISTS shade_card_issues (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shade_card_id INTEGER NOT NULL REFERENCES shade_cards(id) ON DELETE CASCADE,
  issued_to     TEXT NOT NULL,
  department    TEXT NOT NULL DEFAULT 'printing',
  issued_by     TEXT,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_card_id   INTEGER REFERENCES job_cards(id),
  machine_id    INTEGER REFERENCES machines(id),
  returned_by   TEXT,
  received_by   TEXT,
  returned_at   TIMESTAMPTZ,
  condition     TEXT CHECK (condition IN ('good','soiled','damaged','lost')),
  remarks       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_issues_open
  ON shade_card_issues (shade_card_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sc_issues_card ON shade_card_issues (shade_card_id, id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_issues_job_card_id ON shade_card_issues (job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_issues_machine_id ON shade_card_issues (machine_id);
```

The partial unique index is the guarantee that a card is in exactly one place:
a second issue while one is open fails at the database, not at a code check that
someone can forget.

`job_card_id` is what lets printing-complete auto-close the row, preserving
today's auto-return behaviour.

### `shade_card_legacy_numbers` — new, the retire zone

```sql
CREATE TABLE IF NOT EXISTS shade_card_legacy_numbers (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  sc_number   TEXT,
  sc_date     TEXT,
  promoted_to INTEGER REFERENCES shade_cards(id),
  retired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_by  TEXT,
  restored_at TIMESTAMPTZ,
  restored_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_fk_sc_legacy_product_id ON shade_card_legacy_numbers (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_legacy_promoted_to ON shade_card_legacy_numbers (promoted_to);
```

### The duplicate free-text twin

`products.shade_card_number` and `products.shade_card_date` are a second shade
card system, hand-typed in four places (Product Master, Planning spec editor,
Artwork queue, Job Card spec editor), each with its own age chip.

The overlap on prod:

- **599** products carry both, and the numbers **agree in all 599** — pure redundancy
- **297** carry a free-text number with **no card behind it** — an orphan nobody can approve, issue or track
- **12** have dates that disagree between the two sources

Resolution, in three parts:

1. **Read-only everywhere.** No UI offers the field as an input again. Every
   surface displays the module's card with a click-through to it.
2. **Back-filled.** Where a card exists the columns are synced from the module,
   which fixes the 12 disagreeing dates. They become a derived cache, never a
   source.
3. **Retire zone, reversible.** A Retire action moves a product's free-text
   value into `shade_card_legacy_numbers` and clears the product columns.
   Restore puts it back. Orphans additionally offer **Create card from this
   number** — one click makes a real `approved` card carrying the existing date,
   recorded as `promoted_to`.

Nothing is deleted, and every step is undoable.

### Columns kept but retired from use

These stay in the database and in `db.js` — marked deprecated in comments,
written by nothing:

`internal_qc_stamp`, `internal_signatory`, `internal_approval_date`,
`approval_requirement`, `superseded_by`, `dock_zone`, `dock_since`,
`issued_machine_id`, `issued_operator`, `issued_job_card_id`, `issued_at`,
`verified`, `verified_at`, plus the `shade_card_revisions` table and
`customers.shade_approval_requirement` / `products.shade_approval_requirement`.

**Why not drop them:** dropping columns on the live plant database is
irreversible even behind a backup, and the value of the drop is tidiness rather
than function. Keeping them keeps `db.js` and prod in agreement, and means the
whole change can be reverted in code alone with no data migration to undo.
Every one is either nullable or `NOT NULL` with a default, so inserts that
ignore them succeed. A follow-up cleanup can drop them once the new module has
run a few weeks in the plant.

`customer_stamp`, `customer_signature`, `customer_contact_name`,
`customer_designation`, `customer_company` are **kept and used** — step 3 of the
process is the customer signing and stamping.

## 5. Server

### `shade-flow.js` — rewritten, pure, unit-tested

```js
SHADE_STATUSES, TRANSITIONS, transitionBlocker(card, to), labelFor(status)

SHADE_CARD_LIFE_DAYS = 365            // unchanged
ageDays(card, now), isExpiredByAge(card, now)   // unchanged

printingEligibility(card, now)  → { eligible, reason }
  // one rule: approved and not expired. No `requirement` argument, no `hard`
  // flag — with internal approval gone, every approval block is hard.

codeMatch(card, line)           → { ok, mismatches: [{ field, card, order }] }
  // compares artwork_no and output_no against the effective order line.
  // A blank on either side passes: the card inherits both at creation, so a
  // mismatch means a master moved after the customer signed. Only 5 of 1594
  // products carry an output code, so blocking on absence would stop the plant.

issueBlocker(card, openIssue)   → string | null
returnBlocker(openIssue)        → string | null
holderOf(openIssue)             → { issued_to, department, since } | null
```

Deleted: `approvalClass`, `effectiveRequirement`, `productionEligibility`,
`DOCK_ZONES`, `dockIssueBlocker`, `dockReturnBlocker`, `APPROVAL_METHODS`
classification into digital/physical channels (the method itself stays as a
plain recorded value).

### `routes/shadecards.js`

| endpoint | change |
|---|---|
| `GET /shade-cards` | unchanged shape; decorated with holder + code-match |
| `GET /shade-cards/meta` | statuses, approval methods, departments, life days |
| `GET /shade-cards/:id` | detail: issues, events, docs (no revisions) |
| `GET /shade-cards/prefill/:orderLineId` | **new** — the auto-populate payload |
| `POST /shade-cards` | takes `order_line_id`; inherits everything from it |
| `PUT /shade-cards/:id` | reduced `EDIT_COLS` |
| `POST /shade-cards/:id/status` | 4 targets: `sent`, `approved`, `rejected` |
| `POST /shade-cards/:id/issue` | **rewritten** — `issued_to` + `department`, optional job card / press |
| `POST /shade-cards/:id/return` | **new**, replaces `/return-to-vault` |
| `POST/GET/DELETE …/docs` | unchanged |
| `GET /shade-cards/alerts` | unchanged rules, statuses remapped |
| `GET /shade-cards/reports` | revision-history table removed |
| `GET /shade-cards/legacy` | **new** — retire zone: retired + orphan candidates |
| `POST /shade-cards/legacy/retire` | **new** |
| `POST /shade-cards/legacy/:id/restore` | **new** |
| `POST /shade-cards/legacy/:id/promote` | **new** — create a real card from an orphan |
| `DELETE /shade-cards/:id` | unchanged soft delete |

Removed: `/revise`, `/orders` link + unlink (folded into create),
`/to-vault`, `/return-to-vault`, `/print-stations` (superseded by `/meta`
carrying departments and by the existing employees/machines lists).

### Alerts — kept, remapped

Every alarm you asked to retain survives, with its trigger rewritten onto the
new statuses:

| alarm | trigger |
|---|---|
| Pending customer approval | `status = 'sent'` |
| Approval overdue | `status = 'sent'` and `expected_approval_date < today` |
| Expiring | `age_days` within 30 days of 365 |
| Expired | `age_days >= 365` |
| **Long-pending return** | open issue older than 7 days |
| Artwork drift | approved card's `artwork_no ≠ product.party_artwork_code` |
| Output drift | approved card's `output_no ≠ product.output_number` |
| Master changed after approval | unchanged |

Long-pending return is new and comes straight from the PRD.

## 6. Client

### One screen

```
┌─ Shade Cards ─────────────────────────────────── [+ New Shade Card] ─┐
│  599      12         540        8            3           4      2    │
│  Total  Pending    Approved  Issued to   With         Returned Overdue│
│         Approval             Printing    Printing                    │
│                                                    2  Age alerts     │
├──────────────────────────────────────────────────────────────────────┤
│  🔍 search anything                                                   │
│  Card No   SO   Customer   Product   AW/Output   Status  Held by  Age │
└──────────────────────────────────────────────────────────────────────┘
```

Eight tiles, exactly as specified. **Each tile is the filter** — clicking one
filters the table beneath it. That removes all six tabs and the separate Alerts
sub-view. Age alerts and Overdue are tiles, so an alarm is one click from the
rows causing it.

`Issued to Printing` counts issues raised (a throughput number);
`With Printing` and `Returned` filter on custody.

### The create form

One panel. Pick the Sales Order line; everything else arrives read-only:

| auto-populated | source |
|---|---|
| Sales Order, Order Quantity | `orders` / `order_lines` via `order_line_id` |
| Customer | `orders.customer_id` |
| Product, Description | `products` through the line |
| Artwork Code (AW) | `party_artwork_code`, honouring `spec_override` |
| Output Code | `output_number`, honouring `spec_override` |
| Board details | `board_name`, `gsm`, parent/child sheet |
| Printing specifications | `colors`, `colour_type`, `coating`, `special` |

Typed by hand — only what does not exist anywhere yet: colour system, number of
colours, print reference / colour notes, expected approval date, physical
location, remarks.

**Revision cannot be auto-populated.** It is on the requested list, but the ERP
has no artwork revision anywhere: the only `artwork_rev` in the schema is the
free-text field on `shade_cards` itself, and neither `products`, `order_lines`
nor `orders` carries one. It therefore stays a typed field. Rendering it as an
auto-populated read-only row would produce a permanently blank field that reads
as a bug. Giving revisions a real home is its own piece of work — it belongs in
the Artwork module, keyed to the artwork that gets approved, not invented here.

Effective spec resolution reuses `effectiveProduct(product, line)` from
`helpers.js` so a job-only override is respected exactly as it is elsewhere.

### The drawer

The seven steps as a progress rail, with **exactly one primary button lit at a
time**: Dispatch → Record Approval → Issue to Printing → Record Return. Then
the inherited spec read-only, the issue/return log, documents, and the audit
trail. A user never has to decide which of six buttons applies.

### Search

`rowMatches` already matches any character in any cell. `output_no` and the
current holder are added to the row payload so both become searchable, covering
every field in the PRD's search list.

## 7. Checks and error handling

| check | behaviour |
|---|---|
| Customer approval missing | **Hard block** on printing start. One rule, no per-customer configuration, no acknowledge path. |
| Card past 365 days | **Hard block**, as today. |
| AW / Output code mismatch | **Warn.** Red banner on the card, an alerts tile entry, and a structured-409 on printing start that a supervisor acknowledges. The acknowledgement is audited against the card. |
| Issue while already issued | Refused by the partial unique index. |
| Return with no open issue | `returnBlocker` refuses. |
| Issue an unapproved card | `issueBlocker` refuses — step 5 issues an *approved* card. |

The mismatch warning reuses the existing `SHADE_CARD_NOT_ELIGIBLE` structured-409
and `Section.jsx`'s acknowledge dialog. That plumbing exists today for the
internal-approval soft path being removed, so it is repurposed rather than
rebuilt — one dialog, new message.

**This is a deliberate softening of the original requirement**, which asked that
a code mismatch prevent issuing outright. Decided against a hard block because
only 5 of 1594 products carry an output code: a strict gate would refuse
essentially every job until the product master is filled in.

## 8. Consumers to rewrite

| file | change |
|---|---|
| `server/src/shade-flow.js` | rewritten |
| `server/src/shade-flow.test.js` | rewritten |
| `server/src/routes/shadecards.js` | rewritten |
| `server/src/readiness-light.js` | `shadeState` loses `hard`; batch query drops both requirement joins |
| `server/src/readiness-light.test.js` | 30 shade references updated |
| `server/src/routes/production.js` | approval gate → one rule; new code-mismatch 409; printing-complete closes the open issue row instead of writing `dock_zone` |
| `server/src/helpers.js` | `shadeCardsFor` status list; master fallback reads the derived column |
| `server/src/db.js` | new tables, two new columns, deprecation comments |
| `client/src/pages/ShadeCards.jsx` | rebuilt |
| `client/src/pages/Planning.jsx` | shade inputs → read-only + click-through; gains one-click **Issue to Printing** (step 5) |
| `client/src/pages/Artwork.jsx` | shade inputs → read-only display |
| `client/src/pages/Production.jsx` | shade inputs → read-only display |
| `client/src/pages/Masters.jsx` | shade card number/date read-only; `shade_approval_requirement` removed from customer and product field lists |
| `client/src/pages/Section.jsx` | acknowledge dialog text → code mismatch |
| `client/src/pages/JobCardPrint.jsx` | status labels |
| `client/src/pages/Invoices.jsx` | status labels |

`readiness-light.js` keeps `shade` as a **hard** checklist item: an unapproved
card still stops a printing start, so RED continues to mean what the ERP
actually refuses.

## 9. Migration — `supabase/migrations/0013_shade_card_simplification.sql`

Run `npm run db:backup` first. Order matters:

1. Create `shade_card_issues` and `shade_card_legacy_numbers`.
2. Add `shade_cards.order_line_id` and `shade_cards.output_no`.
3. Remap statuses:

   ```
   customer_approved                        → 'approved'
   rejected, revision_requested             → 'rejected'
   sent_to_customer, customer_reviewing     → 'sent'
   expired AND creation_date present        → 'approved'   (age check re-blocks it)
   otherwise, approval_received_date set    → 'approved'
   otherwise, sent_to_customer_date set     → 'sent'
   otherwise                                → 'draft'

   superseded, archived                     → as above, and active = 0
   ```

   The migration has to satisfy **two** requirements that pull in opposite
   directions: preserve today's gate behaviour, and never invent an approval
   that was never asserted. An earlier draft of this spec satisfied only the
   second, by deriving the new status purely from the dates on each row. That
   was wrong in a plant-stopping way, and only surfaced when the migration was
   run against real data.

   **Verified on production:** all 599 live cards are `customer_approved` with
   `approval_received_date = NULL` — they came from a bulk import
   (`created_by = 'import'`) that never populated the approval dates. A purely
   date-derived remap sends every one of them to `draft`, and because the new
   printing gate hard-blocks anything not `approved`, that would stop printing
   on every shade-carded product in the plant.

   So the three statuses that *are* the plant's record of a customer verdict
   carry across directly. This is not trusting a name: `customer_approved` means
   the customer approved, and such a card clears the gate today — moving it
   anywhere else changes behaviour rather than preserving it.

   `expired` is the mapping that genuinely needed care, because it asserts a
   *lapsed* approval. Carrying it to `approved` is safe only when
   `creation_date` exists, since `isExpiredByAge()` then blocks it independently
   — the gate tests status **and** age. With no date there is nothing to expire
   against, so it would clear for ever; those fall back to `draft`.

   Everything else — `draft`, `internal_review`, `internal_approved`, `revised`
   — asserts no customer approval, falls through to the dates, and defaults to
   `draft`. One intended tightening remains: an `internal_approved` card on a
   product flagged `approval_requirement = 'internal'` can print today and will
   not afterwards, because internal approval is being removed as a concept.
   Production holds none of those.

   Of the 599, **563 carry a `creation_date`** old enough that the derived
   expiry blocks them anyway — which is already true today, so no change. The
   remaining **36 have no `creation_date` at all**, so they never expire and
   clear the gate for ever. That is also today's behaviour and not a regression,
   but it is worth knowing: 36 shade cards in the plant have no age.
4. Convert every `dock_zone = 'on_press'` card into an open `shade_card_issues`
   row carrying its machine, job card and `issued_at`, with
   `issued_to = COALESCE(issued_operator, 'unknown (migrated)')` and
   `department = 'printing'`. The COALESCE matters: `issued_operator` is
   nullable, `issued_to` is `NOT NULL`, and a null would abort the migration.
5. Replace the `status` CHECK constraint with the four-value set.
6. Back-fill `products.shade_card_number` / `shade_card_date` from the newest
   active card per product, fixing the 12 disagreeing dates.
7. Back-fill `shade_cards.output_no` from `products.output_number` where blank.

Steps 3 and 5 must be one transaction: the new constraint would reject the old
values. No column is dropped.

Prod carries 0 revisions, 0 documents, 0 sales-order links and every card in a
single state, so steps 3–4 touch one status value across 599 identical rows.

## 10. Testing

**`shade-flow.test.js`** (rewritten, pure):
- every legal transition, and that each illegal one returns a blocker string
- `approved → sent → approved` renewal resets the age clock
- expiry at 364 / 365 / 366 days
- `printingEligibility`: approved ✓, expired ✗, draft ✗, sent ✗, rejected ✗
- `codeMatch`: equal ✓, different ✗, either side blank ✓ (the plant-stopping case)
- `issueBlocker`: unapproved refused, already-open refused, approved allowed
- `returnBlocker`: no open issue refused

**`readiness-light.test.js`** (updated): shade rows resolve to `ok` / `blocked` /
`na` under the new shape, and a blocked shade still paints the light red.

**Verification** before any deploy:

```bash
npm test -w server
npm run build -w client
npm run verify
npm run db:check          # with DATABASE_URL for the target environment
```

Then the UI is checked in the real running app at a desktop breakpoint, logged
in — never a mock.

## 11. Out of scope

- Dropping the retired columns (a later cleanup, once the module has run in the plant).
- Customer-portal or e-mail dispatch of the card. Step 2 records that it was
  dispatched; it does not send anything.
- Colour measurement, spectrophotometer values, ΔE tolerance.
- Bulk retire of all 297 orphan free-text numbers. The zone lists them; a human
  decides one at a time or by selection.
