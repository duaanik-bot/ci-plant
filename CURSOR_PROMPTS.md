# CURSOR AI — MASTER BUILD PROMPT
# Colour Impressions Plant Management System
# ============================================================
# HOW TO USE THIS FILE:
# 1. Open Cursor IDE
# 2. Open this project folder
# 3. Press Ctrl+L (or Cmd+L on Mac) to open Cursor Chat
# 4. Paste the prompt from whichever PHASE you are building
# 5. Let Cursor build. Review. Run. Repeat.
# ============================================================

# ════════════════════════════════════════════════════════════
# PHASE 1 PROMPT — Copy and paste into Cursor Chat to start
# ════════════════════════════════════════════════════════════

You are building the Colour Impressions Plant Management System — a production-grade Next.js 14 web application for a pharmaceutical packaging plant in Patiala, India.

The project already has:
- prisma/schema.prisma (complete 14-table schema)
- prisma/seed.ts (all 12 machines CI-01→CI-12, 8 roles, admin user)
- src/lib/db.ts (Prisma client)
- src/lib/sheet-issue-logic.ts (hard-limit sheet enforcer — Problem 1 fix)
- src/lib/artwork-logic.ts (4-lock artwork approval — Problem 2 fix)
- src/lib/helpers.ts (notifications, audit, auth, OEE, job number)
- package.json with all dependencies
- .env.example with required environment variables

YOUR TASK FOR PHASE 1:

Step 1: Set up the project foundation
- Run: npm install
- Run: npx prisma generate
- Create tailwind.config.ts with shadcn/ui preset
- Create src/app/globals.css with Tailwind directives
- Create src/app/layout.tsx with SessionProvider wrapper
- Create next.config.js

Step 2: Authentication system
- Create src/app/api/auth/[...nextauth]/route.ts using the authOptions template in ALL_API_ROUTES.ts
- Create src/app/(auth)/login/page.tsx — a clean login form with Email + 6-digit PIN fields, Colour Impressions branding, responsive layout
- Create src/middleware.ts — protect all routes except /login
- Create src/types/next-auth.d.ts — extend session types with id, role, permissions, machineAccess

Step 3: Database and seed
- Run: npx prisma db push
- Run: npx prisma db seed
- Verify seed worked: npx prisma studio

Step 4: SOLVE PROBLEM 1 — Sheet issue hard limit
- Create src/app/api/sheet-issues/attempt/route.ts (from ALL_API_ROUTES.ts template)
- Create src/app/api/sheet-issues/[id]/approve/route.ts
- Create src/app/api/sheet-issues/[id]/reject/route.ts
- Create src/app/(dashboard)/stores/issue/page.tsx — the storekeeper's tablet screen:
  * Large QR code scanner using device camera (use ZXing library)
  * On scan: shows job number, product, material, APPROVED qty, ALREADY ISSUED qty, REMAINING qty
  * Number input for qty to issue
  * Submit button calls POST /api/sheet-issues/attempt
  * On HARD STOP: shows red full-screen alert "⛔ HARD STOP — Excess Request Raised. Awaiting supervisor approval." Cannot be dismissed until approval arrives.
  * On success: shows green confirmation with remaining quantity

Step 5: SOLVE PROBLEM 2 — Artwork approval gate
- Create src/app/api/artworks/[jobId]/upload/route.ts — file upload to Cloudflare R2
- Create src/app/api/artworks/[id]/approve-lock/route.ts (from template)
- Create src/app/api/artworks/[id]/reject-lock/route.ts
- Create src/app/api/press/validate-plate/route.ts (from template)
- Create src/app/(dashboard)/artwork/[jobId]/page.tsx — shows 4-lock status:
  * Lock 1: Green if customer doc uploaded, red if not. Upload button for Sales role.
  * Lock 2: 12-point checklist form for QA Officer. Each point is a checkbox. Submit disabled until all 12 checked.
  * Lock 3: Version comparison view for QA Manager. Sign-off button.
  * Lock 4: Auto-generated after Lock 3. Shows plate barcode as large barcode image.
- Create src/app/(dashboard)/press/validate/page.tsx — tablet screen for press operators:
  * Large "SCAN PLATE" button that activates camera
  * On scan: calls POST /api/press/validate-plate
  * GREEN screen = "✅ PRESS CLEARED" with job details
  * RED screen = "❌ DO NOT RUN" with specific reason

DESIGN REQUIREMENTS:
- Use shadcn/ui components throughout (Button, Input, Form, Card, Badge, Alert, Table, Tabs)
- Tailwind CSS for all styling
- Mobile-first — all screens must work on 10" Android tablet at 1280×800
- Dark mode support
- Loading states on all async operations
- Error handling with toast notifications (use sonner library)
- Every form must show validation errors inline

IMPORTANT RULES:
- Never use demo/mock data — all data comes from the Prisma database
- Every API route must check authentication and role permissions
- Every write operation must call createAuditLog()
- Use TypeScript strictly — no 'any' types
- Use Zod for all API input validation

After completing Phase 1, the system should:
1. Allow login with email + PIN
2. Storekeeper on tablet cannot issue more sheets than approved — hard stop works
3. Press operator cannot start press without approved plate barcode scan
4. All actions are logged in audit_log

Start with Step 1. Show me each file as you create it.


# ════════════════════════════════════════════════════════════
# PHASE 2 PROMPT — Run after Phase 1 is complete and tested
# ════════════════════════════════════════════════════════════

Phase 1 is complete. Now build Phase 2 — Job lifecycle and inventory core.

Build these in order:

1. JOBS MODULE
   - src/app/api/jobs/route.ts — GET (list) and POST (create with BOM explosion)
   - src/app/api/jobs/[id]/route.ts — GET (full detail) and PUT (update)
   - src/app/api/jobs/[id]/card-pdf/route.ts — generate printable job card PDF with QR code using @react-pdf/renderer
   - src/app/(dashboard)/jobs/page.tsx — active jobs board. Table with columns: Job#, Customer, Product, Qty, Status (badge), Due Date, Days Remaining (red if <2), Actions. Sortable, filterable.
   - src/app/(dashboard)/jobs/new/page.tsx — new job form:
     * Customer selector (searchable dropdown)
     * Product name input
     * Qty ordered input
     * Imposition input (system auto-calculates net sheets and shows preview)
     * Machine sequence (drag-to-reorder list of CI machines)
     * Board material selector
     * Due date picker
     * BOM preview card showing: net sheets, approved sheets, waste allowance, material reservation status
   - src/app/(dashboard)/jobs/[id]/page.tsx — job detail with tabs:
     * Overview (customer, status, dates, qty)
     * Stages (timeline of all stages with timestamps)
     * Materials (BOM lines with issued vs approved)
     * QC Records (all checks)
     * Artwork (version history + lock status)
     * Cost (material cost actual vs planned)

2. INVENTORY MODULE
   - src/app/api/inventory/route.ts — GET all with stock levels
   - src/app/api/inventory/grn/route.ts — POST new goods receipt
   - src/app/api/inventory/[id]/release/route.ts — POST QA release from quarantine
   - src/app/api/inventory/alerts/route.ts — GET materials at/below reorder point
   - src/app/(dashboard)/inventory/page.tsx — 4-column stock view:
     * Quarantine (red) | Available (green) | Reserved (amber) | Finished Goods (blue)
     * Per material with qty, value, age, lot numbers
     * Reorder point indicator
   - src/app/(dashboard)/inventory/grn/page.tsx — goods receipt form
   - src/app/(dashboard)/inventory/release/[id]/page.tsx — QC release form with instrument readings

3. PRODUCTION STAGES MODULE
   - src/app/api/stages/start/route.ts — POST start stage (scan job QR + machine)
   - src/app/api/stages/[id]/complete/route.ts — PUT complete stage with qty
   - src/app/(dashboard)/shopfloor/page.tsx — TABLET VIEW:
     * Full screen, large text, designed for 10" tablet
     * Shows: current active job on this machine, qty produced today, qty remaining, stage name
     * Large "START STAGE" and "COMPLETE STAGE" buttons
     * QR scanner for job card
     * Sheet remaining indicator (progress bar — goes red when near limit)

4. OEE LIVE DISPLAY (public, no login)
   - src/app/api/oee/live/route.ts (from template)
   - src/app/oee/page.tsx — TV dashboard:
     * Three press cards (CI-01, CI-02, CI-03)
     * OEE gauge (circular progress) for each
     * Current job on each press
     * Sheets produced today vs target
     * Active alerts (excess requests, QC fails)
     * Auto-refreshes every 60 seconds
     * Dark theme — designed to be read from 3 metres away


# ════════════════════════════════════════════════════════════
# PHASE 3 PROMPT — QMS Module
# ════════════════════════════════════════════════════════════

Phase 2 complete. Now build Phase 3 — Quality Management System.

1. QC RECORDS
   - src/app/api/qc/record/route.ts — POST QC measurement
   - src/app/api/qc/first-article/route.ts — POST first article approval form
   - src/app/api/qc/final-inspection/route.ts — POST final AQL inspection
   - src/app/(dashboard)/qc/[jobId]/page.tsx — QC forms for a job:
     * First article form: spectrodensitometer ΔE readings per colour (CI-01/02/03 only). Pass = ΔE≤3, Fail = auto-alert. Both operator and QA Officer must sign.
     * In-process form: triggered every 500 sheets. 5-point check with instrument selection.
     * Final inspection form: barcode scan counter (running count of scans), dimensional check fields, shade comparison, AQL sample size auto-calculated from batch qty.

2. NCR + CAPA
   - src/app/api/ncr/route.ts — POST create NCR
   - src/app/api/ncr/[id]/capa/route.ts — PUT update CAPA fields
   - src/app/api/ncr/[id]/close/route.ts — PUT close NCR (QA Manager only)
   - src/app/(dashboard)/qms/ncr/page.tsx — NCR dashboard with severity colour coding and CAPA timeline

3. CoA GENERATOR
   - src/app/api/coa/[jobId]/generate/route.ts — generates PDF with all QC records
   - CoA PDF template using @react-pdf/renderer:
     * Colour Impressions header with address and GSTIN
     * Job details, customer, batch number
     * Table of all QC readings with pass/fail
     * QA Manager signature field
     * Professional pharma-grade layout

4. QA RELEASE
   - src/app/api/dispatch/qa-release/route.ts — POST QA release (QA Manager only). Blocks dispatch if CoA not signed.


# ════════════════════════════════════════════════════════════
# PHASE 4 PROMPT — Dispatch + Reports + MD Dashboard
# ════════════════════════════════════════════════════════════

Phase 3 complete. Now build Phase 4.

1. DISPATCH MODULE
   - Full dispatch flow: pick list → packing slip PDF → e-way bill log → POD upload
   - FIFO pallet selection from FG stock
   - Dispatch blocked if QA release not issued

2. MD DASHBOARD
   - src/app/(dashboard)/page.tsx — home dashboard (MD and Ops Head):
     * Live stats: active jobs, OEE today, open NCRs by severity, dispatch due, pending artworks
     * Wastage trend chart (Recharts line chart — last 30 days, actual vs standard)
     * Top 5 jobs by excess sheet requests this month
     * Machine utilisation bar chart
     * Real-time — react-query with 60-second refetch

3. REPORTS
   - Wastage trend report with export to CSV
   - Job cost report
   - Schedule M audit report PDF — complete batch record for any job number
   - Monthly production summary


# ════════════════════════════════════════════════════════════
# PHASE 5 PROMPT — Final polish and go-live prep
# ════════════════════════════════════════════════════════════

Phase 4 complete. Final phase:

1. PWA configuration — next-pwa setup so tablets can install the app and work offline with sync queue
2. Admin module — user management, role editor, machine master, material master
3. Instrument calibration tracker with due-date alerts
4. WhatsApp notification testing — verify all 10 templates fire correctly
5. Performance audit — all pages must load in <2 seconds on 4G connection
6. Error boundaries on all pages
7. 404 and 500 error pages
8. Print stylesheet for job cards
9. Vercel deployment config — vercel.json with cron for daily MD summary at 18:00 IST


# ════════════════════════════════════════════════════════════
# CURSOR SETTINGS TO USE
# ════════════════════════════════════════════════════════════
# In Cursor Settings → Models:
# - Primary model: claude-3-5-sonnet (best for complex logic)
# - Use "Apply" not "Chat" mode when Cursor writes code to files
# 
# In Cursor Settings → Features:
# - Enable: Codebase indexing
# - Enable: Auto-import
# - Enable: TypeScript strict mode
#
# WORKFLOW:
# 1. Paste phase prompt → Cursor writes files
# 2. Run: npm run dev → check browser
# 3. If error: copy error → paste back to Cursor "Fix this error: [paste]"
# 4. Test each feature manually before moving to next
# 5. After each Phase: git commit -m "Phase X complete"
# ════════════════════════════════════════════════════════════
