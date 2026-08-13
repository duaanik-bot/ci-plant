# Customer WIP: a cumulative list, managed in bulk

2026-08-12 · Status Sheet + Import WIP List

## The problem

A customer's WIP list is the set of items **they** are chasing. Today the plant
can mark a line WIP by hand or by uploading the customer's own sheet, but three
things stop that list from behaving like a list:

1. **It cannot be read as cumulative.** `/wip-apply` only ever writes `wip=true`
   and never clears, so the *records* already accumulate. What does not
   accumulate is the **view**: `/status-sheet` and `/wip-match` are both scoped
   to pending lines (`ol.qty > ol.dispatched_qty AND ol.completed_at IS NULL`),
   so the moment a product completes or dispatches it drops out of the sheet
   *and out of the matcher's candidate set*. Re-import the customer's next list
   and a product they are still chasing lands in "unrecognised", because the
   only thing that changed is that we finished it.
2. **There is no way to say "not WIP".** The flag is read as a boolean, so
   "the customer never mentioned it" and "the customer told us it is not in
   progress" are the same blank.
3. **Everything is one line at a time.** A 60-line list is 60 dropdowns.

## The four decisions

| Decision | Choice |
|---|---|
| What the sheet holds | Pending lines **or** any line carrying a WIP record |
| WIP states | Three: `true` / `false` / `NULL` |
| Remarks | New `order_lines.remarks`, edited inline |
| Export's excluded "Status" | The new Pending/Completed/Dispatched column |

### WIP is a tri-state, and the column already allows it

`order_lines.wip` is a **nullable** boolean, so this needs no migration:

- `true` — **WIP.** On the customer's list; they are waiting on it.
- `false` — **Non-WIP.** On the list, and the customer has told us it is *not*
  in progress. A deliberate negative, not an absence.
- `NULL` — **not on the list at all.** This is what "Remove from WIP" writes,
  and it is the escape hatch requirement 1 means by *"unless products are
  explicitly removed"*.

`wip_date` rides the record, not the truth value: stamped for `true` **and**
`false` (both are things the customer said, on a day), cleared only on removal.
A date with no record is a stale claim — the rule the current code already
states, extended to the third state.

### Scope: `pending OR wip IS NOT NULL`

```sql
WHERE ol.status <> 'cancelled'
  AND ( <the existing pending predicate>
        OR ol.wip IS NOT NULL )
```

`wip IS NOT NULL` is exactly "has a WIP record" under the tri-state, so a
removed line falls straight back to the pending-only rules and a finished line
the customer still chases stays visible. The same widened predicate is applied
to `/wip-match`'s candidate query — that single change is what makes a
re-imported list cumulative in practice rather than only in the table.

**Overdue stays a pending-only question.** `overdue_days` is forced to 0 for a
line that is completed or dispatched. Without this, widening the query would
quietly inflate the Overdue KPI with lines that are already out of the door —
the sheet would report a worse plant than the one that exists.

### Derived line status

Read in SQL, one value per line, and it is a **cascade** — a dispatched line is
not also reported as completed:

```
dispatched  ol.status = 'dispatched' OR ol.dispatched_qty >= ol.qty
completed   ol.completed_at IS NOT NULL          (produced, not yet out)
pending     otherwise
```

## What gets built

### Server

- `db.js` — `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS remarks TEXT`.
- `GET /status-sheet` — widened predicate, `line_status`, `remarks`, and the
  overdue clamp above.
- `PATCH /status-sheet/line/:id` — accepts `remarks`; `wip` accepts `null` and
  the date logic follows the tri-state.
- `POST /status-sheet/lines/bulk` *(new)* — `{ line_ids, wip }` in one
  transaction, one audit row per line. Every statement inside runs on the
  transaction's own client: on prod the pool is `max: 1`, so a stray `q()`
  inside `tx()` self-deadlocks.
- `POST /status-sheet/wip-match` — candidates widened to match the sheet, and
  each line reports its `wip` state and `line_status` so the review modal can
  say what it is about to change.

### Client — `StatusSheet.jsx`

- **Status chips** (Pending / Completed / Dispatched) and **customer chips**,
  both multi-select, both narrowing the same searched set the KPI cards count.
- **Selection + dock** — `DataTable selectable`, with Mark as WIP / Mark as
  Non-WIP / Remove from WIP. A collapsed gang row stands for several order
  lines, so selection expands to its **member line ids** before it is sent;
  the dock names how many real lines it is about to write.
- **Remarks** — inline editable cell, debounced, optimistic like every other
  edit on this sheet.
- **WIP cell** — three options, replacing the Yes/No pair.
- **Export** — every visible column except the status column, plus EDD (already
  present) and Remarks. With two or more customers in view the workbook is
  built as one section per customer with `sheetPerSection`, which the exporter
  already turns into one worksheet each, every sheet keeping its own frozen
  header and auto-filter.

### `client/src/lib/wipExport.js` *(new, pure)*

Partitioning rows into customer sections and dropping the excluded column is
the one piece here with real branching, so it lives in a pure module and is
tested from `server/src/wip-export.test.js` — the established route, since
`node --test` cannot import `.jsx`.

## Testing

`npm test -w server` (never `node --test src/`). New tests cover:

- the tri-state date rule, including that removal clears the date
- the widened scope predicate: a dispatched line with a WIP record is in, the
  same line after removal is out
- the status cascade, including a line both completed and dispatched
- overdue is zero for a non-pending line
- export sections: one per customer, ordered, status column absent, Remarks and
  EDD present; a single customer produces a single unsectioned sheet

## Deliberately not built

- No backfill of `wip=false`. Every existing row stays `NULL`/`true` and reads
  exactly as it does today.
- No change to what WIP *means* downstream. `WipChip` is truthy-only, so
  Planning, Production and the station boards keep showing a chip for `true`
  and nothing for `false` — which is correct, and needs no edit.
