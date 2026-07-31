# Shade Cards — Seven Tabs, One Per Holder

**Date:** 2026-07-31
**Module:** Quality → Shade Cards (`/shade-cards`, module key `shade_cards`)
**Builds on:** [2026-07-30-shade-card-simplification-design.md](2026-07-30-shade-card-simplification-design.md)
**Goal:** make the module answer "what is waiting on me right now" without
reading a single status. Every pending queue becomes its own tab, named for
whoever is holding the card.

---

## 1. What is changing

| | today | after |
|---|---|---|
| Tabs | 4 — Register / To Issue / Reports / Retired Numbers | 7 |
| Dashboard tiles | 9, six of which duplicate a tab | 4, none of which duplicate a tab |
| To Issue driven by | the card register | the sales order book |
| Draft cards surfaced | nowhere | own tab |
| Sent-to-customer cards | a tile | own tab |
| Cards out with printing | a tile | own tab |
| Server endpoints | 19 | 20 (`/to-issue` added) |

The previous spec removed six status tabs in favour of tiles-as-filters. This
is not a reversal of that call. Those tabs were a *taxonomy* — one per status,
including statuses nobody acts on. These are *queues* — one per party holding
the ball, and a queue only exists if somebody has to do something about it.
Status `rejected` gets no tab for exactly that reason; it lives in the Register
and is chased from With Customer.

## 2. The tab strip

```
Register 600 │ To Send 0 │ With Customer 0 │ To Issue 99 │ On Floor 0 │ Reports │ Retired
└─ reference ┘ └──── ours to do ────┘      └─ ours ─┘   └ theirs ┘   └── reference ──┘
                            └─ customer holds it ─┘
```

Left to right is the card's own journey: we make it, we send it, the customer
holds it, we issue it, the floor holds it, it comes back. A user who reads the
strip once never has to be told the lifecycle again.

`SubTabs` already renders counts and scrolls horizontally
(`overflow-x-auto scrollbar-none`), so seven tabs need no component change and
degrade to a swipe below `lg`.

### Labels

Requested labels, tightened for a strip that now holds seven items:

| requested | shipped | why |
|---|---|---|
| Register | Register | unchanged |
| To issue (take data from sales order) | To Issue | unchanged label, rebuilt source |
| Pending on live floor | On Floor | "pending" on five of seven tabs is noise |
| Reports | Reports | unchanged |
| Retired Numbers | Retired | strip width |
| Pending with customer | With Customer | |
| Pending to send for customer approval | To Send | |

`To Send` / `To Issue` are the two things *we* owe. `With Customer` / `On Floor`
are the two things someone owes *us*. That parallelism is the whole navigation
model, and it is why "pending" is dropped rather than kept — the grouping says
it more clearly than the word did.

## 3. Production data this is designed against

Read from the live mirror on 2026-07-31:

| fact | count |
|---|---|
| Active shade cards | 600 — **all** `approved` |
| Cards in `draft` / `sent` / `rejected` | 0 |
| Open issues (cards out with printing) | 0 |
| Cards linked to an order line | 1 |
| Approved and in date | 258 |
| Approved but past 365 days | 306 |
| Approved with no `creation_date` at all | 36 |
| Live sales order lines | 99, all `pending` |
| Distinct products behind them | 85 |
| Live lines with a job card | 0 |

**Three of the four new tabs are empty on day one.** That is the correct
reading of the data, not a defect: the four-status lifecycle shipped on
2026-07-30 and has never been driven — every card is the bulk import sitting in
`approved`. To Send, With Customer and On Floor are where cards will land the
first time somebody creates one. Each therefore needs an empty state that
explains the emptiness rather than implying breakage (§6).

**Over half the register cannot be printed against.** 306 expired plus 36 with
no date means only 258 of 600 cards clear the printing gate. This is pre-existing
and not caused by this work, but it is invisible today and the tile row is the
right place to say it.

## 4. To Issue — rebuilt sales-order-first

Today's To Issue starts from approved cards and asks "is there work waiting for
this?". That inverts the question the plant actually asks, and it is structurally
blind to the 68 live order lines that have **no shade card at all** — the single
biggest backlog in the module.

After: **one row per live sales order line**, and each row states what that line
needs from this module.

### Bands — grouped by action needed

| band | lines today | action |
|---|---|---|
| 1. No card yet | **68** | Create card |
| 2. Ready to issue | **15** | Issue |
| 3. Expired card | **16** | Renew |
| 4. Waiting on approval | 0 | none — link to To Send / With Customer |
| 5. With printing already | 0 | none — informational, collapsed |

Sums to 99. Within each band, rows sort by the existing three urgency tiers
(`WORK_TIERS`: on a press → in triage → order open), then by `queue_pos`.

**The bands are evaluated in a fixed order and a line lands in the first that
matches**, which is what makes them a partition rather than five overlapping
filters:

```
no card            → 1
open issue         → 5     custody outranks everything: it is not in the cabinet
status ≠ approved  → 4
expired by age     → 3
otherwise          → 2
```

Custody is tested before age deliberately. An expired card that is out on a
press is band 5, not band 3 — offering "Renew" for a card nobody can physically
hand you is an action that cannot be completed.

**Why band by action and not by press proximity.** The existing worklist bands
by `work_tier`, which is the right axis once Print Planning is running. Right
now **zero** live lines carry a job card, so every one of the 99 would land in
tier 3 and the banding would convey nothing. Action-needed is informative on day
one and press proximity survives inside it as the sort. When planning fills in,
tier 1 rows float to the top of each band automatically.

### Row shape

| column | source |
|---|---|
| Sales Order | `orders.po_number` |
| Customer | `customers.name` |
| Product + code | `products` via the line |
| Order qty | `order_lines.qty` |
| Where the job is | press name · `queue_pos`, or JC number · triage, or "not planned yet" |
| Shade card | `sc_number` + state chip, or "—" |
| Age | card `age_days`, red past 365 |
| Action | per band, above |

### Create card, from the line

The Create action on a band-1 row opens the existing `ShadeCardForm` seeded with
that `order_line_id`, which the existing `GET /shade-cards/prefill/:orderLineId`
endpoint already serves. No new create path, no second form.

**85 distinct products sit behind the 99 lines**, so a card created for one line
satisfies every other live line on the same product. The list re-derives on
save, so those rows move to band 2 together. No dedupe logic is needed — but the
band-1 header states the distinct-product count alongside the line count, so
"68 lines" does not read as "68 cards to make".

## 5. The other three tabs

All three filter rows the page **already loads** from `/shade-cards?all=1`,
which carries `status`, `open_issue_id`, `issued_to`, `department`, `issued_at`
and the derived `with_printing`. No new queries.

### To Send — `status = 'draft'`

Card No · Customer · Product · AW/Output · Created · Age. One action per row:
**Dispatch** (`POST /shade-cards/:id/status` → `sent`), which the drawer already
implements; the row button opens the drawer at that step rather than duplicating
the transition. No bulk dispatch — YAGNI until somebody has more than a handful.

### With Customer — `status = 'sent'`

Card No · Customer · Product · Sent on · Expected approval · Days waiting.

A red band at the top holds rows where `expected_approval_date < today` — this
is the "Approval overdue" alarm from the previous spec, and putting it here
places the alarm directly above the rows causing it. The `Overdue` tile is
retired because this band replaces it.

Actions: Record approval, Record rejection, Re-send — all existing drawer steps.

### On Floor — open issue rows

Card No · Product · Held by · Department · Press / Job card · Issued on · Days
out. Action: **Record return**.

A red band holds rows open more than 7 days — the **long-pending return** alarm
defined in the previous spec but surfaced nowhere until now.

## 6. Empty states

Each empty tab says why it is empty and what fills it. Never "No rows".

| tab | copy |
|---|---|
| To Send | "Nothing waiting to be sent. New cards land here the moment you create one — the 600 cards already in the register arrived as an import and skipped this step." |
| With Customer | "No cards are out for approval. Dispatch one from To Send and it appears here until the customer's verdict is recorded." |
| On Floor | "Every card is in the store. Cards appear here while printing is holding them." |
| To Issue | "The order book needs nothing from this module — every live sales order has an approved card in printing's hands." |

## 7. Tiles — nine become four

The nine tiles were navigation. Six of them are now tabs, so keeping them would
give the same destination two controls. The four that remain are **health**:
facts no tab states, each of which filters the Register on click.

| tile | value | filter |
|---|---|---|
| Total cards | 600 | all active |
| In date | 258 | has a `creation_date` and `age_days < 365` |
| Expired | 306 | `age_days >= 365` |
| No date on record | 36 | `age_unknown` |

The three age tiles partition the register exactly (258 + 306 + 36 = 600), which
is what makes the row readable at a glance: it is one number split three ways,
not four unrelated counters.

They filter on **age alone, never on status**. Every card is `approved` today so
a status clause would be invisibly redundant; the moment drafts exist it would
silently break the partition and the three tiles would stop summing to the
total. Age is also the honest reading of the labels — "in date" is a statement
about the calendar, not about approval.

Retired: `Pending Approval` → With Customer tab. `To Issue` → To Issue tab.
`With Printing` → On Floor tab. `Returned` and `Issued to Printing` → Reports,
where throughput counters belong. `Overdue` → the red band inside With Customer.
`Approved` → superseded by `In date`, which is the number that actually governs
whether a card can be printed against.

The existing red **critical alerts** banner above the tabs is unchanged.

## 8. Server

### New — `GET /shade-cards/to-issue`

The only new endpoint. Returns one row per live order line with its best card
resolved:

```sql
FROM order_lines ol
JOIN orders o ON o.id = ol.order_id
JOIN products p ON p.id = ol.product_id
LEFT JOIN customers c ON c.id = o.customer_id
-- the card that best serves this line: an approved one wins, then newest
LEFT JOIN LATERAL (
  SELECT * FROM shade_cards sc
  WHERE sc.product_id = ol.product_id AND sc.active = 1
  ORDER BY (sc.status = 'approved') DESC,
           sc.creation_date DESC NULLS LAST, sc.id DESC
  LIMIT 1) card ON true
LEFT JOIN LATERAL (
  SELECT id, issued_to, department, issued_at FROM shade_card_issues i
  WHERE i.shade_card_id = card.id AND i.returned_at IS NULL LIMIT 1) open_i ON true
-- how far down the print plan this LINE has travelled (not the product)
LEFT JOIN job_cards jc ON jc.order_line_id = ol.id AND jc.status <> 'closed'
LEFT JOIN machines m ON m.id = jc.machine_id
WHERE ol.status IN ('pending','planned','ready','in_production')
```

The lateral picks **the** card for the line rather than listing every card on the
product, because the tab answers "can this order run", not "how many cards exist".
Approved-wins-then-newest is deliberate: a product with one expired approved card
and one newer draft should read as *expired* (band 3, renewable) rather than
*waiting on approval* (band 4, a slower path).

### Band resolution is a pure function

The SQL fetches; it does not classify. The band is decided by one new pure
function in `shade-flow.js`, sitting alongside `printingEligibility`,
`codeMatch` and `issueBlocker`:

```js
issueBand(card, openIssue, now) → 1 | 2 | 3 | 4 | 5
```

`card` is null for a line with no card. The route calls it per row and returns
`band` in the payload, so client and server cannot disagree about what a row
needs — the same reason `WORK_TIERS` is exported.

This is not decoration. The repository has **no route-level tests**: every
server test in `server/src/*.test.js` is a pure-logic test. Band resolution is
the only new judgement this work introduces and the part that can silently
mislead the floor, so it has to live where it can be tested — a `CASE`
expression buried in a query cannot be.

Age and eligibility reuse `ageDays` / `isExpiredByAge` / `printingEligibility`
from the same module. No new lifecycle logic is introduced anywhere.

### Unchanged

`/shade-cards?all=1` already carries everything To Send, With Customer and On
Floor need. `/shade-cards/alerts` already computes overdue approvals and
long-pending returns; the red bands read from it rather than recomputing.

`to_issue` and `work_tier` stay on the card rows — the Register still uses them
for sorting and search — but nothing navigates by them any more.

## 9. Files

| file | change |
|---|---|
| `server/src/shade-flow.js` | `issueBand()` added — the only new logic |
| `server/src/shade-flow.test.js` | `issueBand` cases appended |
| `server/src/routes/shadecards.js` | `GET /shade-cards/to-issue` added |
| `client/src/pages/ShadeCards.jsx` | 4 tabs → 7, 9 tiles → 4, counts wired |
| `client/src/pages/shade-cards/ToIssue.jsx` | rewritten order-line-first |
| `client/src/pages/shade-cards/ToSend.jsx` | new |
| `client/src/pages/shade-cards/WithCustomer.jsx` | new |
| `client/src/pages/shade-cards/OnFloor.jsx` | new |

Untouched: `ShadeCardDrawer.jsx`, `ShadeCardForm.jsx`, `RetireZone.jsx`,
`lifecycle.js`, `readiness-light.js`, `db.js`. `shade-flow.js` gains one
function and loses nothing, so every existing caller is unaffected.
**No migration** — this spec adds no column and no table.

Each new tab file stays a single presentational component taking `rows` and
callbacks, matching how `ToIssue.jsx` and `RetireZone.jsx` are already written.
`ShadeCards.jsx` keeps ownership of loading and the drawer, so it grows by the
tab definitions and shrinks by five tile definitions — roughly flat at ~300 lines.

## 10. Testing

**Server** — `issueBand()` is the only new logic, and it is the part that can
silently mislead the floor. Cases appended to `shade-flow.test.js`:

- a line with no card at all → band 1
- a line whose card is approved and in date → band 2
- a line whose card is approved and past 365 days → band 3
- a line whose card is approved with **no `creation_date`** → band 2, not band 3
  (36 such cards exist; treating undatable as expired would hide real work)
- a line whose card is `draft` / `sent` / `rejected` → band 4
- a line whose card has an open issue → band 5, even when also expired
  (custody outranks age: the card is not in the cabinet to hand over)
- a product carrying both an expired approved card and a newer draft → band 3
- closed / cancelled order lines never appear

**Client** — each tab renders its empty state when its filter yields nothing.

**Verification** before any deploy:

```bash
npm test -w server
npm run build -w client
npm run verify
```

Then checked in the real running app, logged in, at a desktop breakpoint —
never a mock. Per the concurrent-session convention, `npm run verify` runs
against a detached worktree of this work's own commit, not the shared tree.

## 11. Out of scope

- Bulk dispatch and bulk issue. Single-row actions until volume argues otherwise.
- A compliance view of floor jobs running without a valid card. Considered and
  set aside — On Floor is the chase-the-return list, and mixing "who owes me a
  card" with "who is running without one" makes one tab answer two questions.
- Fixing the 306 expired cards. This work makes the number visible; renewing
  them is plant work, one card at a time, through the existing renewal edge.
- Any change to the four statuses, the custody loop, or the create form.
