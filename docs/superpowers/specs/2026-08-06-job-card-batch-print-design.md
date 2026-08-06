# Job Cards — timeline, row select, and one PDF for the whole print run

**Date:** 2026-08-06
**Screen:** Job Cards register (`client/src/pages/Production.jsx`)

## The problem

Printing job cards was one card at a time: open the card, print it, go back, open
the next. Ten jobs was ten trips through the print dialog. The plant wanted the
travelers for a day's work as **one** document it could send to the printer once,
or save as a single PDF.

Two things had to exist before that was possible:

1. A way to say **which** cards — the register has 74 and no notion of a date window.
2. A way to **pick** cards — there was no selection of any kind.

## Design

### 1. Timeline filter

A chip row under the status tabs: `All · Today · Yesterday · This Week · Custom`.

**The anchor is `planned_date`** — the day the job is meant to run on the press.
That is what "print today's job cards" means on the floor: the travelers for the
work about to happen. The two rejected alternatives:

- `created_at` (the traveler's "Released" line) says when paperwork moved, not
  when work happens.
- `delivery_date` is the customer's date and is null across most of the register.

**"This Week" is Monday → today**, not a rolling seven days. On a Tuesday that is
two days. Sunday counts *back* to its own Monday rather than forward into a week
that has not started.

Every chip carries a live count, computed with the same `inTimeline` the list
filters by — a chip cannot promise a number the list then contradicts.

**A card with no planned date is outside every preset.** That is not a silent
drop: the screen counts them and says so ("N cards with no planned date — not in
any timeline"), because an undated job in the queue is exactly what a planner
wants to notice.

Order of narrowing is **tab → timeline → search**, so each count means what it
says: tab counts stay the true plant totals, timeline chips count within the
chosen tab, and only the search narrows what is finally listed.

### 2. Row selection

A checkbox on each card header; a bar appears once anything is ticked:
`N selected · Select all N shown · Clear · Export PDF (N)`.

**Selection is not pruned when the tab or timeline changes.** Gathering Monday's
cards and Tuesday's into one print run is the point; a selection that emptied
itself on a tab click would make that impossible. The bar always reports the full
count, so nothing is ever selected invisibly.

"Select all shown" *adds* the visible cards to whatever was picked elsewhere;
un-ticking removes only the visible ones.

### 3. Batch print

`/production/jobcards/print?ids=…` fetches each card's full record and stacks the
travelers, one A4 per card, behind a **Print / Save as PDF** button.

**The traveler was extracted to `components/JobCardSheet.jsx`.** Both print pages
render that one component, so there is no batch layout to drift: a card printed
alone and the same card printed inside a batch are the same piece of paper. This
is asserted on the source in `server/src/jobcard-timeline.test.js` — neither page
may grow a traveler of its own — and was verified at runtime by comparing the
rendered text of a card on both pages (identical, 1278 chars).

Page breaks are `break-after: page` on every sheet but the last. Deliberately
**not** `break-inside: avoid`: a gang traveler legitimately runs past one page,
and forcing each whole would leave half an A4 blank on every card in the batch.

The print dialog does **not** auto-fire. It would open over a page the planner
has not seen, and a mis-tick would already be at the printer.

A card that fails to load is **named** on screen and excluded. Printing 9 of 10
silently is the one outcome worse than failing — the missing traveler is the job
that then runs without paper.

## What was not built

- No server change. The register already returns `planned_date`, and
  `/job-cards/:id` already returns everything the traveler needs.
- No generated-PDF path. Rebuilding the traveler in the jsPDF/autoTable engine
  would be a second copy of the layout, and that engine shares page width by
  content — wrong tool for an A4 spec sheet. Browser print → "Save as PDF"
  produces one intact file and also prints direct, which was the actual goal.
- No migration, no DDL.

## Files

| File | Change |
|---|---|
| `client/src/components/JobCardSheet.jsx` | **new** — the traveler, extracted |
| `client/src/lib/jobCardTimeline.js` | **new** — presets, range, counts |
| `client/src/pages/JobCardBatchPrint.jsx` | **new** — the stacked print run |
| `client/src/pages/JobCardPrint.jsx` | now renders the shared sheet |
| `client/src/pages/Production.jsx` | timeline chips, selection, Export PDF |
| `client/src/App.jsx` | route for the batch page |
| `client/src/index.css` | `.print-page-break` |
| `server/src/jobcard-timeline.test.js` | **new** — 17 tests |

## Verification

- 1292 server tests pass (17 new).
- `npm run build -w client` passes.
- Verified in the running app against a seeded local database: chip counts
  (All 3 / Today 1 / Yesterday 1 / This Week 2) matched the seeded planned dates
  exactly; custom range 05→06 Aug returned exactly the two dated cards; the
  unplanned notice appeared with correct singular grammar; selection bar,
  select-all and Export PDF all behaved; the batch page rendered both travelers
  with exactly one page break; the `break-after: page` rule was confirmed live in
  the loaded stylesheet inside a print media block. No console errors.
