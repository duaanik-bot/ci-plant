# Colour Impressions — Plant ERP

Multi-user production management software for a pharma/FMCG packaging carton plant.
React + Vite front-end, Express + PostgreSQL back-end, JWT login with roles.
Runs fully local today; built to go live on Vercel + Supabase when you're ready.

## Run it locally

```bash
npm install     # once (downloads an embedded PostgreSQL automatically)
npm run dev     # starts API (:4000) + app (:5173)
```

Open **http://localhost:5173** and sign in:

| | |
|---|---|
| Email | `admin@ci.local` |
| Password | `admin123` |

Change the password and add your team in **Masters → Users** (admin only).
Demo data seeds itself on first run. Reset it anytime with `npm run seed`
(users are kept). Plant data lives in `server/.pgdata` — back it up by copying.

## Users & roles

| Role | Can do |
|---|---|
| **admin** | Everything, including user management |
| **planner** | Orders, planning, artwork, procurement, masters, dispatch |
| **production** | Start/complete production stages |
| **qc** | GRN QC decisions, artwork QA approval |
| **dispatch** | Create challans |
| **viewer** | Read-only |

Server-side enforcement — the role checks live in the API, not just the UI.
Every mutation is audit-logged with the user's name.

## The workflow

```
Sales Orders → Planning → Artwork → Production → Dispatch
                    ↘ Raise PR → Procurement → GRN → QC → Warehouse
```

Two live views sit on top of the workflow:

- **Live Floor** — every production section (Printing, Coating, Foiling,
  Embossing, Die Cutting, Pasting, QC) as a board: what's running now (with
  operator and elapsed time), what's queued at the section ready to start,
  and what's still upstream. Start/complete stages right from the board.
  Refreshes every 10 seconds.
- **Track** — pick any order line and see its whole life on one timeline:
  SO received → planned → artwork locked → every stage with quantities,
  scrap and operators → FG into the warehouse → each challan out the gate.

1. **Sales Orders** — enter the customer PO with product lines.
2. **Planning** — assign printing machine + date; sheets auto-computed from
   ups + wastage. Three live readiness gates: Artwork / Tooling / Material.
   Material short? One click raises a Purchase Requisition.
3. **Artwork** — two approvals (Customer, QA shade/text). Both ticked = artwork
   locks automatically. One flag, one truth.
4. **Production** — job cards only when all three gates are green (no bypasses).
   Stages run strictly in sequence: Printing → Coating → Foiling → Embossing →
   Die-cutting → Pasting → QC (routing derives from the product spec).
   First stage start issues board stock FIFO with a ledger entry. Final stage
   completion closes the job, credits finished goods and feeds Dispatch —
   one transaction.
5. **Dispatch** — produced lines appear automatically. Make a challan, print it.
   Order completes itself when fully dispatched.
6. **Procurement** — PR → approve → convert (creates a real PO) → GRN
   (quarantine) → QC accept releases stock / reject blocks it.
7. **Inventory** — live stock position, batches, full movement ledger, FG.
8. **Reports** — production register, scrap by stage, customer sales, dispatch
   register, machine load. Live, no pivot refresh.

## Dashboard KPIs

Orders in hand · Jobs on floor · Produced this month · Scrap % ·
Ready-to-dispatch value · On-time % · Material shortages · WIP by stage ·
Machine status · Live alerts.

## Going live later (Vercel + Supabase)

The code is already Postgres-native, so go-live is configuration, not rewrite:

1. Set `DATABASE_URL` to your Supabase connection string — the server then uses
   Supabase instead of the embedded local database (schema auto-creates).
2. Set a strong `JWT_SECRET` environment variable.
3. Deploy: static client build + the Express API on any Node host, or Vercel
   with a serverless wrapper (I'll set this up at go-live).
4. Git: `git init && git add -A && git commit` — `.gitignore` is ready.

## Design decisions (why this won't rot like the last build)

One stock ledger (`stock_movements`) for every quantity change, written in the
same transaction as the change. One state machine for order-line status. One
artwork flag the gate actually reads. No JSON blobs — routing derives from
typed columns. No readiness-gate bypass. FK constraints on, audit log on every
mutation, row locks (`FOR UPDATE`) on concurrent-sensitive flows.

## Stack

| Layer | Choice |
|---|---|
| Front-end | React 18, Vite, Tailwind, lucide-react |
| Back-end | Express 4, node-postgres, JWT (jsonwebtoken), bcryptjs |
| Database | PostgreSQL — embedded locally, Supabase when live |
