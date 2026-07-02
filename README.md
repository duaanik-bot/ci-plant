# Colour Impressions — Plant ERP

Fresh-stack production management software for a pharma/FMCG packaging carton plant.
React + Vite front-end, Express + SQLite back-end. One command to run, zero configuration.

## Run it

```bash
npm install     # once
npm run dev     # starts server (:4000) + app (:5173)
```

Open **http://localhost:5173**. The database seeds itself with realistic demo data
on first run (file: `server/ci-erp.db`).

Reset to fresh demo data anytime:

```bash
npm run seed
```

To start with an **empty** plant instead, delete `server/ci-erp.db`, run once, then
delete the demo rows from Masters — or ask for a blank-seed variant.

## The workflow (left to right in the nav)

```
Orders → Planning → Artwork → Production → Dispatch
              ↘ Raise PR → Procurement → GRN → QC → Inventory
```

1. **Orders** — enter the customer PO with product lines.
2. **Planning** — assign printing machine + date; sheets are auto-computed from
   ups + wastage. Three readiness gates show live: Artwork / Tooling / Material.
   Material short? One click raises a Purchase Requisition.
3. **Artwork** — two approvals (Customer, QA shade/text). Both ticked = artwork
   locks automatically. One flag, one truth.
4. **Production** — "Create Job Card" only works when all three gates are green
   (no bypasses). Stages run strictly in sequence, one at a time:
   Printing → Coating → Foiling → Embossing → Die-cutting → Pasting → QC
   (routing derives from the product spec). Starting the first stage issues board
   stock FIFO and writes the ledger. Completing the last stage closes the job,
   credits finished goods and feeds Dispatch — all in one transaction.
5. **Dispatch** — produced lines appear automatically. Make a challan, print it
   (browser print → PDF). Order completes itself when fully dispatched.
6. **Procurement** — PR → approve → convert (creates a real PO) → receive (GRN →
   quarantine batch) → QC accept (releases to stock) or reject.
7. **Inventory** — live stock position, batch register, full movement ledger,
   finished goods. Every quantity change is a ledger row.
8. **Reports** — production register, scrap by stage, customer sales, dispatch
   register, machine load. Live — no pivot refresh.

## KPIs on the dashboard

Orders in hand (value/lines/cartons) · Jobs on floor · Produced this month ·
Scrap % · Ready-to-dispatch value · On-time % · Material shortages · WIP by
stage · Machine status · Live alert feed.

## Design decisions (why this won't rot like the last build)

- **One stock ledger** (`stock_movements`) — GRN, QC release, consumption,
  FG receipt, dispatch and adjustments all write the same table, in the same
  transaction as the change. No parallel stock systems.
- **One state machine** for order lines (`helpers.js`) — every status change is
  validated. No route can skip a step.
- **One artwork flag** (`artwork_locked`) — set by the one approval endpoint the
  gate actually reads.
- **No JSON blobs** — routing derives from typed product columns.
- **Readiness gate has no bypass** — artwork + tooling + material, checked on
  every job-card creation.
- Typed schema, FK constraints ON, WAL mode, audit log on every mutation.

## Stack

| Layer | Choice |
|---|---|
| Front-end | React 18, Vite, Tailwind, lucide-react |
| Back-end | Express 4, better-sqlite3 (transactions, FK on) |
| Database | Single file `server/ci-erp.db` — back it up by copying |

Migrating later to Postgres/multi-user: the schema is plain SQL and the API is
plain REST — lift-and-shift friendly.
