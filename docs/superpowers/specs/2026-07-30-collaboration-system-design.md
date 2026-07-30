# Communication & Collaboration System — Design

*Drafted 2026-07-30. Source: Anik's "Communication & Collaboration System" PRD (19 sections).*
*Status: awaiting Anik's approval. Nothing here is built yet.*

## The objective, restated

No employee should have to phone another to ask for status, clarification or approval. Every
conversation hangs off the exact record it is about, and stays there permanently. Operators
should be able to see whether a job can run without asking planning.

## Decisions taken (Anik, 2026-07-30)

1. **Both tracks in parallel** — readiness/traffic-light and record threads are built together.
2. **Read receipts derive from the read pointer**, not per-message rows. "Read by Rahul, Ankit ·
   unread by Vishal", each with their last-read time. Zero extra rows per message.
3. **All list surfaces get threads in the first wave**, not a pilot subset. Two deliberate
   exclusions follow from the code rather than from taste, both argued in §A3: **Accounts** (four of
   its five tables are period aggregates with no row entity to attach to; its two real registers are
   invoices and POs, which get threads through those entities) and **six of the twelve Masters tabs**
   (`gst_rates`, `sections`, `board_rates`, `users`, and the two config tabs — nothing to discuss).

## What already exists and is inherited, not rebuilt

The messenger shipped on 2026-07-29 (`main@951c02f`) already provides, live on motionci.in:

| PRD asks for | Status |
|---|---|
| §7 DMs, group rooms, department rooms | Live (`conversations` dm/group + Plant Floor, Management) |
| §2 attachments, images, PDFs, voice notes | Live (BYTEA, 4 MB cap, hold-to-record mic) |
| §2 delete own message, timestamps, avatars | Live (10-minute tombstone window) |
| §10 notification centre | Live (bell: approvals desk + personal inbox + plant alerts) |
| §8 smart tags | Live for job cards only (`#CI-JC-0002` → clickable chip) |
| §19 audit trail | Live (`audit_log`, 23 entity types) |
| §18 typing indicators | Live |
| §12/14 the underlying readiness facts | Computed today, mostly never displayed |

Two things are built and unused, and both are near-free wins:

- **`tooling_detail`** already returns a per-item checklist — die, plate, block, shade card, each
  `ready | not_ready | missing`, with hard/soft severity — and the client discards it. §14's
  checklist is largely already computed.
- **`Timeline.jsx`** is a finished per-page history drawer that nothing imports, and
  `GET /timeline` filters by module but never by record, despite `idx_audit_entity(entity,
  entity_id)` already existing. **A parallel session owns wiring or removing it (task_0ec88491) —
  this design depends on that outcome and must not duplicate it.**

---

## Part A — Universal record threads

### A1. The one schema move

`conversations` is welded to job cards:

```sql
kind TEXT CHECK (kind IN ('dm','group','job')),
job_card_id INTEGER UNIQUE REFERENCES job_cards(id) ON DELETE CASCADE
```

Migration **0011** generalises it:

```sql
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entity TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entity_id INTEGER;
-- 'record' joins dm|group|job. 'job' is kept as a legacy synonym so the live
-- Discuss buttons and existing job threads keep working untouched.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (kind IN ('dm','group','job','record'));
-- Backfill the job threads that already exist into the new addressing.
UPDATE conversations SET entity = 'job_card', entity_id = job_card_id
WHERE job_card_id IS NOT NULL AND entity IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_entity
  ON conversations (entity, entity_id) WHERE entity IS NOT NULL;
```

`job_card_id` stays, purely so the existing FK cascade keeps deleting a job's thread with the job.
**It must never become a second way to address the same thread** — that is a split-brain waiting to
happen: a job thread created through the new generic path without `job_card_id` set would be
invisible to the legacy `GET /job-cards/:id/chat`, which would then create a *second* thread for the
same job. Two rules prevent it: the legacy route becomes a thin alias that delegates to the generic
resolver, and the resolver always populates `job_card_id` when `entity='job_card'`. A test asserts
one job can never hold two conversations.

Every thread is then addressed as `(entity, entity_id)` and inherits messages, attachments, voice
notes, read pointers, tombstones, typing and bell notifications with no further work.

**Cascade gap to close deliberately:** only job cards cascade today. Other entities' threads
would outlive a deleted record. Rather than 20 FKs, migration 0011 adds a nightly-safe
`DELETE FROM conversations WHERE entity IS NOT NULL AND NOT EXISTS (…)` sweep is **rejected** —
too clever. Instead each entity in the registry declares its table, and the thread is deleted in
the same transaction as the record by a shared `dropThreads(entity, ids, qc)` helper called from
the existing delete paths (orders, order lines, job cards, requisitions, POs, invoices…). Records
with no delete path need nothing.

### A2. The entity registry — one file, both sides

`server/src/record-entities.js` (mirrored by a thin client map) is the single source of truth:

```js
export const ENTITIES = {
  order:          { table: 'orders',            number: 'po_number',      label: 'Sales Order',   link: id => `/orders?open=${id}` },
  order_line:     { table: 'order_lines',       number: null,             label: 'Order Line',    link: id => `/planning?line=${id}` },
  job_card:       { table: 'job_cards',         number: 'jc_number',      label: 'Job Card',      link: id => `/production?jc=${id}` },
  job_stage:      { table: 'job_stages',        number: null,             label: 'Stage',         link: id => `/floor?stage=${id}` },
  requisition:    { table: 'requisitions',      number: 'pr_number',      label: 'Requisition',   link: id => `/procurement?pr=${id}` },
  purchase_order: { table: 'purchase_orders',   number: 'po_number',      label: 'Purchase Order',link: id => `/procurement/po/${id}` },
  grn:            { table: 'grns',              number: 'grn_number',     label: 'GRN',           link: id => `/procurement?grn=${id}` },
  invoice:        { table: 'invoices',          number: 'invoice_number', label: 'Invoice',       link: id => `/invoices/${id}` },
  dispatch:       { table: 'dispatches',        number: 'challan_number', label: 'Challan',       link: id => `/dispatch/challan/${id}` },
  fg_lot:         { table: 'fg_lots',           number: 'lot_number',     label: 'FG Lot',        link: id => `/finished-goods?lot=${id}` },
  extra_sheet:    { table: 'extra_sheet_requests', number: 'xs_number',   label: 'Extra Sheets',  link: id => `/extra-sheets?xs=${id}` },
  shade_card:     { table: 'shade_cards',       number: 'sc_number',      label: 'Shade Card',    link: id => `/shade-cards?sc=${id}` },
  tool:           { table: 'tools',             number: 'code',           label: 'Tool',          link: id => `/tooling?tool=${id}` },
  product:        { table: 'products',          number: 'code',           label: 'Product',       link: id => `/masters?tab=products&id=${id}` },
  material:       { table: 'materials',         number: 'code',           label: 'Board',         link: id => `/masters?tab=boards&id=${id}` },
  customer:       { table: 'customers',         number: null,             label: 'Customer',      link: id => `/masters?tab=customers&id=${id}` },
  vendor:         { table: 'vendors',           number: null,             label: 'Vendor',        link: id => `/masters?tab=vendors&id=${id}` },
  machine:        { table: 'machines',          number: null,             label: 'Machine',       link: id => `/masters?tab=machines&id=${id}` },
  employee:       { table: 'employees',         number: null,             label: 'Employee',      link: id => `/masters?tab=employees&id=${id}` },
  requisition_line: { table: 'requisition_lines', number: null,           label: 'PR Line',       link: id => `/procurement?pr_line=${id}` },
};
```

Rules: an entity key not in this map is refused (400) — the client can never invent a thread
target. `number` drives the thread's title and the smart-tag chip text. `link` drives §9's
cross-linking and the notification deep link. Keys reuse the existing `audit_log` vocabulary; the
known singular/plural drift there (`product` vs `products`, `machine` vs `machines`) is normalised
**here**, and `record-entities.test.js` asserts every key resolves to a real table and that the
audit vocabulary maps onto it.

### A3. Mounting on every module without building 17 drawers

This is what makes "all surfaces at once" tractable. `ChatDock` is already mounted globally in
`AppLayout` and already listens for `ci-chat-open`. Extending its payload from `{jobCardId}` to
`{entity, entityId}` means **any row anywhere opens a full thread in the existing panel** — no
module needs a detail drawer.

So mounting a module = adding one cell:

```jsx
// client/src/components/ThreadCell.jsx
<ThreadCell entity="order" id={row.id} summary={threads[row.id]} />
```

which renders a comment icon, an unread count, and a red dot when the unread contains a mention.

Two shared-infrastructure additions are required and are the only changes to `ui.jsx`:

1. **`rowClass` prop on `DataTable`** — there is no per-row decoration hook today; the `<tr>`
   class is computed internally, so §4's "entire row lightly highlighted" is impossible without it.
   It appends to the internally-computed class rather than replacing it, so the group rail, the
   selected-row tint and the stripe keep working.
2. **A `threadColumn(entity, threads, idOf)` factory** so a page adds the column in one line.
   `idOf` is explicit and **not** defaulted to `row.id`: `DataTable` keys rows by `r.id ?? i` while
   several pages identify rows differently — Orders' Pendency sub-table and Status Sheet both use
   `line_id`. A factory that assumed `row.id` would silently attach every Pendency row's comments
   to the wrong record, or to nothing.

The existing row-click guard (`closest('button, a, input, …')`) already means a button inside a
row never triggers row navigation, so the cell is safe to drop into any table.

**Surfaces, and the cost of each:**

*Cheap — shared `DataTable`, one column each:* Sales Orders (+ Pendency lines), Procurement
requisitions, Procurement GRN, Planning, Artwork, Dispatch register, Invoices, Warehouse (RM
stock, FG stock, batches), Shade Cards, Tooling, Status Sheet, and Masters — but Masters gets
threads on the **six** tabs whose entity is in the registry (products, boards, customers, vendors,
machines, employees), not all twelve. Threads on `gst_rates`, `sections`, `board_rates` and `users`
have no plausible conversation; the config-driven table means adding one later is a single line.

*Hand-mounted — bespoke tables or card lists, one cell added per renderer:* Procurement POs (card
list), Job Cards (card list — already has Discuss, becomes the generic cell), Print Planning
(kanban card), Live Floor `JobRow` + Section station table, Finished Goods (six raw tables),
Extra Sheets (raw table), Tracking (custom list).

*Explicitly out of scope, with reason:* **Accounts.** Four of its five tables are period
aggregates with no stable row entity — there is nothing to attach a conversation to. Its Sales
Register and Purchase Register rows are invoices and POs, which get threads through those
entities. This is a deliberate exclusion, not an oversight.

*Live Floor nuance:* a Live Floor row is a `job_stages` row, not a job. A stage-level thread would
fragment one job's conversation across ten stages. **Decision: Live Floor rows show the JOB's
thread** (`entity: 'job_card'`), so the printing operator and the planner are in the same
conversation. `job_stage` stays in the registry for stage-specific incidents raised deliberately.

### A4. Unread indicators without N+1 (§4)

One batched call per page, not per row:

```
GET /threads/summary?entity=order&ids=1,2,3…      → { "12": { comments: 4, unread: 2, mentioned: true, last_at } }
```

Single query: `conversations` joined to `conversation_members` (mine) with a lateral count of
`messages` above my watermark, plus an `EXISTS` on `message_mentions` for the mention flag. Capped
at the ids the page actually renders. `DataTable` windows rows at 60, so the page passes only
visible ids and re-requests on window growth.

Three visual states, matching the PRD: unread → row tint + blue dot + count; **mentioned → red
badge and a higher-priority tint**; read → nothing. Opening the thread advances the watermark,
which clears both.

### A5. Read receipts, derived (§5)

`conversation_members` already holds `last_read_message_id` and `last_seen_at`. Migration 0011
adds `last_read_at TIMESTAMPTZ` (when the pointer last advanced — distinct from `last_seen_at`,
which is merely the last fetch).

For any message *M*: **read by** = members with `last_read_message_id >= M.id`; **unread by** =
the rest; each reader's time is their `last_read_at`.

The middle tick needs care. `last_seen_at` is stamped only inside the thread-messages endpoint
(`chat.js:331`) — i.e. only when someone *opens that thread*, which is the same act that advances
the read watermark. Defining "delivered" from it would make delivered and read collapse into one
state and the middle tick would be decoration. Instead migration 0011 adds `users.last_active_at`,
stamped cheaply on authenticated requests, and:

- **✓ sent** — persisted.
- **✓✓ delivered** — the recipient's app has been active since it was posted
  (`users.last_active_at > M.created_at`). Meaningful: they were in the ERP, so it reached them.
- **✓✓ read (blue)** — their watermark passed it.

Clicking the ticks lists "Rahul read at 10:12 AM / Ankit delivered / Vishal — not seen since
yesterday", plus total viewers and last viewed. Cost: zero rows per message, one column on `users`.
Honest limitation, stated in the UI copy: for older messages the read time means "had read by",
exact only for the newest.

### A6. @mentions and teams (§3)

Migration 0011 adds:

```sql
CREATE TABLE mention_targets (           -- users AND team aliases in one namespace
  id …, kind TEXT CHECK (kind IN ('user','team')),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT NOT NULL UNIQUE,           -- 'anik', 'planning-team'
  label TEXT NOT NULL,                   -- 'Anik Dua (MD)', 'Planning Team'
  member_ids JSONB                       -- teams only
);
CREATE TABLE message_mentions (
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES mention_targets(id) ON DELETE CASCADE,
  user_id INTEGER,                       -- expanded recipient (a team fans out)
  PRIMARY KEY (message_id, target_id, user_id)
);
```

Seeded teams: Planning, Production, Quality, Procurement, Accounts, Management — membership from
the existing `users.role` / `sections` / `is_management` grants, editable in Masters → Users.

Composer: typing `@` opens the same searchable picker the `#` tagger uses, with keyboard
navigation. Stored as `@[handle]` and rendered as a highlighted, clickable chip that opens the
person's profile card (name, role, stations, current unread). A mention notifies the target
through the existing `notify()` — **bypassing the 120-second watching suppression**, because a
mention is addressed at you personally. Mention inbox = a filter over `notifications` where
`kind='mention'`; badge count comes free. Email and mobile push stay out of scope (§3 marks them
optional/future).

### A7. Discussion depth (§2)

All of this lands in the one shared thread component, so it appears on every module at once.

```sql
message_reactions (message_id, user_id, emoji, PRIMARY KEY (message_id, user_id, emoji))
message_versions  (id, message_id, body, edited_by, edited_at)   -- §19 edit history
ALTER TABLE messages ADD COLUMN parent_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN pinned_at TIMESTAMPTZ, ADD COLUMN pinned_by TEXT;
ALTER TABLE messages ADD COLUMN edited_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN resolved_at TIMESTAMPTZ, ADD COLUMN resolved_by TEXT;
```

- **Threaded replies** — `parent_id` one level deep only. Slack-style: a parent shows "3 replies"
  and expands inline. Deeper nesting is refused at the API, because two levels of indent on a
  plant phone is unreadable.
- **Edit** — rewrites `body`, stamps `edited_at`, appends the previous body to `message_versions`.
  An edited message shows "edited" with the history on click. Editing is allowed indefinitely for
  your own text messages (unlike the 10-minute delete window) because the history is preserved.
- **Pin / resolve** — pinned messages surface at the top of the thread; resolving marks the whole
  conversation done, greys the row's comment cell, and is reversible. Both audited.
- **Quote** — client-side: inserts a `> ` blockquote referencing the message id, rendered as a
  jump-to-original link.
- **Copy link** — `#/…?thread=order:12&msg=98`; opening it deep-links the dock to that message
  and highlights it.
- **Reactions** — a small emoji set (👍 ✅ 👀 ❗ ❤️). Aggregated counts, click to toggle. "Like /
  acknowledge" from the PRD is the 👍/✅ pair, and an ✅ from a mentioned user is recorded as an
  acknowledgement in the timeline.
- **Rich text** — kept deliberately minimal: bold, italic, lists, links, and `#`/`@` chips. No
  tables, no headings, no colour. Plant phones and a 380px dock panel do not reward a full editor,
  and rich HTML in a permanent audit record is a liability.

### A8. Permissions (§16)

Reuses the existing per-user grant pattern rather than inventing a system. Migration 0011 adds
`users.comment_scope TEXT` (`'all' | 'own_modules' | 'read_only'`, default `'all'`) and two flags,
`can_pin` and `can_resolve` (default: planners, QC and admins). Rules:

- Comment / react / reply: any active login whose `comment_scope <> 'read_only'`, limited to
  records inside their module access where module access is already restricted.
- Edit / delete own message: the author, within the existing windows.
- **Delete anyone's message: nobody.** A message is tombstoned, never removed, per §19.
- Mention a team: any commenter. Mention `@everyone`: `is_management` or admin only, so nobody can
  ring 14 phones by accident.
- Pin / resolve: `can_pin` / `can_resolve` holders.
- Announcements: `is_management` — posts a pinned system message into Plant Floor.

Every one of these is enforced server-side against a fresh database read, never a client claim —
the same rule the extra-sheet approval gate follows.

### A9. Search (§17)

`GET /threads/search` over messages the caller can see, with filters: free text (Postgres
`to_tsvector` on `body`, GIN-indexed), author, entity type, specific record, has-attachment,
mentions-me, unread, resolved, pinned, date range. Results group by conversation and deep-link to
the message. Attachment filenames are searched too, since "the drawing Rahul sent" is how people
actually look.

---

## Part B — Readiness, traffic light and the operator's screen

### B1. The light is derived, never a new source of truth (§12)

`readiness()` already computes every fact. The light is a pure function over the existing gates
plus the stage record, living in a new tested module `server/src/readiness-light.js`:

**RED must mean what the system actually refuses**, or the colour is a lie. `createJobCardForLine`
puts only two things in `blocked[]` — artwork not locked, and board short with *nothing* on order.
Tooling, **including a missing or not-ready die**, goes into `pending[]`: the plant pushes and runs
those jobs today. An earlier draft of this design painted a bad die RED; that would have told an
operator "cannot proceed" about work the ERP permits and the floor routinely does. Corrected:

| Light | Meaning | Condition |
|---|---|---|
| **RED** | The system will refuse this | artwork not locked, OR board short with nothing on order, OR a **hard** shade-card block (rejected / revision-requested / expired under a customer requirement — the only gate that hard-stops a press start) |
| **AMBER** | Runnable, but something is outstanding | every hard stop clear, yet: board on order not in stock (`material_pending`), board in stock but **not yet cut**, die/plate/block `not_ready` or `missing`, shade card soft-pending, or no machine assigned |
| **GREEN** | Start now | every tracked checklist item satisfied |

So a missing die is AMBER with the die named, not RED. The distinction the operator needs is
"will the ERP stop me" (red) versus "I can start but someone should know" (amber), and that maps
exactly onto the existing `blocked[]` / `pending[]` split rather than inventing a second opinion.

"Board cut" is not currently a readiness fact. Derivation, stated precisely because the edge cases
matter: the job's `job_stages` row for `stage='cutting'` is `completed` ⇒ satisfied;
`partially_completed` or `in_progress` ⇒ outstanding (amber, not done); **no cutting stage on the
route at all ⇒ not applicable**, dropped from the denominator like ink. For a gang parent, the
parent's own cutting stage is the one that counts — its children inherit the cut sheets. This is
the only new computation in Part B.

### B2. The checklist and its percentage (§14)

Nine items, each mapping to something already computed:

| Item | Source |
|---|---|
| Artwork approved | `readiness.artwork` (`artwork_locked`) |
| Board available | `readiness.material` / `material_pending` |
| Board cut | cutting stage completed (new derivation, B1) |
| Plate ready | `tooling_detail` family `plate` |
| Die ready | `tooling_detail` family `die` (hard) |
| Shade approved | `tooling_detail` family `shade_card` + `productionEligibility` |
| Ink available | **not modelled anywhere.** Shown as an untracked item, greyed, excluded from the percentage until ink stock exists. Stated honestly rather than faked green. |
| Machine assigned | `job_cards.machine_id` |
| Job released | `job_cards.finalised_at` |

Percentage = satisfied ÷ tracked (so ink does not permanently cap the plant at 89%). 100% ⇒ GREEN
unless overridden. Each item carries its own state — `ok`, `pending`, `blocked` — reusing
`tooling_detail`'s existing three states, and the whole checklist renders in the pattern the plant
already knows from `LineClearance` ("6 of 9 confirmed").

### B3. Manual "Ready to Run" (§13)

```sql
ALTER TABLE job_cards ADD COLUMN ready_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_cards ADD COLUMN ready_override_by TEXT,
                      ADD COLUMN ready_override_at TIMESTAMPTZ,
                      ADD COLUMN ready_override_reason TEXT;
```

`POST /job-cards/:id/ready-override { on, reason }`, reason mandatory, permitted to planners,
production heads and admins. It **never writes a gate** — the checklist keeps showing the truth
underneath, and the card shows "GREEN — manual override by Dharminder · <reason>". Every flip is
audited and notifies the assigned press operator through the existing bell. Turning it off returns
the card to its computed light.

It lives on `job_cards`, not `order_lines`, deliberately: an operator runs a *card*, and for a gang
that card is the parent serving several lines — overriding the parent is exactly the statement
"this press run may start". Planning's per-line light stays computed, so a gang member's own
readiness is never silently rewritten by the parent's override; the member row shows the computed
light with a note that its gang parent is overridden.

The same reason `tooling_ok` needs care in the checklist: it is an **absolute** override of the whole
tooling gate (`toolingGateOk` short-circuits on it), so a job can pass tooling with a die that is
physically not ready. The checklist must therefore render the per-family truth from
`tooling_detail` **and** label the override — "Die: not ready · accepted by planning" — never a
green tick that hides it. Showing green there is how an operator ends up at a press with no die.

### B4. Print Planning card density (§11)

Measured today: ~138 px baseline, seven stacked rows, ~26 px of it pure margin; a lane shows about
two cards before it grows. Target ~72–80 px, roughly doubling cards per screen:

- Merge product and customer onto one line (`product · customer`, truncated).
- Fold the sheets/colours chip, readiness and delivery date into one metrics row.
- Readiness becomes **icon-only** traffic-light dots with tooltips, replacing the two text-labelled
  "Board"/"Tooling" pills.
- Collapse the footer entirely when there is no operator (today it renders an empty `<span/>`).
- Replace the always-mounted 28 px `ActionMenu` button with a hover-revealed one, so the header row
  drops to its 20 px text height.
- Reduce `px-3.5 py-2.5` to `px-3 py-2`.
- Progress bar stays (running jobs), hold reason stays — both are load-bearing.

`Card` is local to `PrintPlanning.jsx` and reused by nothing else, so this is contained.

### B5. The operator's answer (§15)

The Live Floor `JobRow` gains the same traffic-light dot and its checklist on tap. An operator
sees, without asking: green = start now, amber = what is still missing, red = blocked and why.
This reuses the Part A thread cell too, so the operator can ask *in place* rather than walking to
planning.

---

## Part C — Per-record activity timeline (§6)

`audit_log` already records everything the PRD lists. Two things unlock per-record history, and
**both belong to a parallel session's task (task_0ec88491)**: mounting the finished `Timeline`
component, and adding an `entity_id` filter to `GET /timeline` (its composite index already exists).
As of this writing that session has already added `import Timeline from './Timeline.jsx'` to
`AppLayout.jsx`, so the mount is happening — this design must not touch either file.

This design adds exactly one thing on top: interleaving a record's thread messages into the same
feed, so "commented" appears alongside "approved" and "status changed" — one chronological story per
record, which is what §6 asks for. If that session instead removes the Timeline, per-record history
moves into this build as a tab inside the thread panel, using the same query.

Of §6's eleven event types, nine already land in `audit_log` today; **"mentioned" and "commented"
arrive with Part A**. One is thin: **"assigned"** is only audited where a machine or operator
assignment happens to be written, not as a first-class event — so the timeline will show it
unevenly until assignment is audited consistently. Flagged rather than papered over; it is a
one-line addition at each assignment site and can ride along.

---

## Explicitly deferred, with reasons

- **Realtime (§18 "no page refresh")** — the API runs as Vercel serverless functions that cannot
  hold a websocket. Live push means the browser subscribing to Supabase directly, which requires
  row-level-security policies on every chat table designed from scratch; done carelessly it is a
  data-leak surface. The 3-second poll already reads as instant. Realtime gets its own hardened
  phase. Optimistic send, infinite scroll and lazy loading of older messages **are** in scope now —
  they need no new infrastructure.
- **Exact per-message read receipts** — per Anik's decision; revisit only if the plant asks.
- **Email and mobile push notifications** — §3 marks both optional/future.
- **Voice-note transcription, translation, message search inside audio** — not asked for.

## Shipping

Built in parallel as decided, but **shipped as two deploys**, because a live plant should not take
both blast radii at once:

1. **Deploy 1 — Part B (readiness).** Self-contained, no shared-component changes, immediate floor
   value. Migration adds four `job_cards` columns.
2. **Deploy 2 — Part A (threads).** Migration 0011, the shared `ui.jsx` additions, and every module
   mount. Larger surface, needs the fuller review pass.

Both go through the established gate: `npm run verify`, an adversarial review wave, browser
verification against the real app with UAT-scoped data, prod backup, migrations applied to Supabase
before the code, clean-worktree verify of the exact commit, then push.

## Where this design has already been corrected

An automated four-lens design review was attempted and **failed outright** — every agent died on
API overload, so it produced nothing. Rather than claim a review that did not happen, the highest-
risk claims were checked by hand against the running code, and three were wrong:

1. **A missing die was going to be painted RED.** `createJobCardForLine`'s `blocked[]` holds only
   artwork and board-with-nothing-on-order; tooling lands in `pending[]`. RED would have told
   operators "cannot proceed" about jobs the plant runs every day. Now AMBER (§B1).
2. **The "delivered" tick was meaningless.** It was defined from `last_seen_at`, which is stamped
   only when someone opens the thread — the same act that marks it read, so the two states
   collapsed. Now derived from a new `users.last_active_at` (§A5).
3. **The thread column assumed `row.id`.** Orders' Pendency table and Status Sheet key rows by
   `line_id`, so comments would have attached to the wrong record or vanished. The id accessor is
   now explicit (§A3).

The remaining design risk therefore sits mostly in what was *not* re-checked by hand. The review
should be re-run before implementation starts, and its findings folded in.

## Risks I am watching

- **`ui.jsx` is shared by every page.** Adding `rowClass` is additive, but a mistake there is
  plant-wide. It gets its own test and a careful review.
- **Thread orphaning.** Covered by `dropThreads()` in the existing delete transactions, not by a
  cleanup job.
- **Notification volume.** Threads on 17 modules plus mentions could turn the bell into noise. The
  existing replace-then-insert rule (one unread row per conversation per user) and the
  watching-suppression window are what keep it survivable; mentions deliberately pierce both.
- **Masters threads on 12 tabs** are the least-proven value in the PRD. They are cheap (one
  column), so they ship, but I expect the real usage to be customers, products and boards.
- **"Ink available" has no data model.** Shown as untracked rather than green. If the plant wants
  it enforced, ink stock needs modelling — a separate project.
