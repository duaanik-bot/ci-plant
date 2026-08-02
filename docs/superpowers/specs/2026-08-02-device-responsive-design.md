# Device-specific responsive experience — iPad Air, Redmi Pad 2, phones

**Date:** 2026-08-02 · **Branch:** `responsive-devices` off `origin/main` (3d0a29f)
**Sanction:** Anik sanctioned commit → push → deploy to prod for this session, out loud.
**Hard constraint:** desktop UI must not change. Not "should not" — *cannot*, by construction.

## Device matrix (real usable viewports, CSS px)

| Device | Portrait | Landscape | DPR | Primary orientation |
|---|---|---|---|---|
| iPhone 17 Pro | 402×874 | — | 3 | portrait |
| iPhone 17 Pro Max | 440×956 | — | 3 | portrait |
| Android common (Samsung FHD+) | 384×832 | — | ~3 | portrait |
| Android large (Pixel) | 412×915 | — | ~2.6 | portrait |
| Android small (Galaxy S base) | 360×780 | — | 3 | portrait |
| Redmi Pad 2 11″ | 800×1280 | 1280×800 | 2 | **landscape** |
| iPad Air 11″ | 820×1180 | 1180×820 | 2 | **landscape** |
| iPad Air 13″ | 1024×1366 | 1366×1024 | 2 | **landscape** |

## The core problem and the mechanism

Tablets in landscape report 1180–1366 CSS px — *above* the desktop breakpoint. Width
alone cannot separate an iPad in landscape from a small laptop. The separator is the
**primary pointing device**: `@media (pointer: coarse)` is true on every touch
tablet/phone and false on every mouse/trackpad desktop. An iPad with a Magic Keyboard
still reports `coarse` (primary input remains touch — correct for our use). A
Windows touch-laptop reports `fine` (mouse primary) and keeps the desktop UI. We use
`pointer: coarse`, never `any-pointer` (that would catch touch-screen laptops).

## Tiers

| Tier | Media condition | Devices | Treatment |
|---|---|---|---|
| **phone** | `(max-width: 767.98px)` | all phones | Cards not tables, bottom nav, bottom sheets, portrait-first, one-hand reach |
| **tab-portrait** | `(min-width: 768px) and (max-width: 1023.98px)` | tablets held upright | Priority columns, comfortable targets |
| **tab-landscape** | `(min-width: 1024px) and (pointer: coarse)` | iPad/Redmi landscape | Full console: everything on screen, bigger targets, no horiz scroll for primary data |
| **desktop** | `(min-width: 1024px) and (pointer: fine)` | laptops/monitors | **Byte-identical behaviour to today** |

Phones at `<768px` are *always* restyled regardless of pointer (a 360px window on a
desktop is not a real use case; the desktop guarantee is defined at ≥1024 + fine).
768–1023 affects only tablets-portrait in practice (no meaningful laptop lives there;
current code already applies its existing `sm:`/`md:` rules in that band — we tune,
not fork, there).

### Implementation channels

1. **Tailwind custom variants** (tailwind.config.js `screens` + `variants` via plugin):
   - `ph:` → `@media (max-width: 767.98px)`
   - `tp:` → `@media (min-width:768px) and (max-width:1023.98px)`
   - `tl:` → `@media (min-width:1024px) and (pointer: coarse)`
   - `touch:` → `@media (pointer: coarse)` (any touch tier)
   Desktop utilities (`lg:` etc.) are never *added* to in this project except where a
   `tl:` override must re-assert the desktop value (it can't — `tl:` can never match
   desktop, so desktop needs no re-assertion; that is the whole point).
2. **index.css blocks** under the same media conditions for multi-property primitives.
3. **JS tier hook** `useTier()` returning `'phone' | 'tabp' | 'tabl' | 'desktop'` from
   matchMedia, for components that must render a different tree (DataTable cards,
   Modal sheet, AppLayout nav). Components early-return the new tree for
   phone/tablet and fall through to the **unmodified** desktop JSX otherwise.

### Desktop no-move proof

- Grep gate: every new CSS rule sits under one of the three media conditions above.
- Runtime gate: at 1440×900 with fine pointer, computed styles of key components and
  full-page screenshots are compared before/after per module.
- `npm run verify` (server tests + client build) green.

## Foundation pieces

- `index.html`: viewport meta gains `viewport-fit=cover` (safe areas). Nothing else.
- Safe areas: `--sat/--sar/--sab/--sal: env(safe-area-inset-*)`; bottom nav and
  docks pad by them; landscape tablets get left/right insets respected.
- Touch targets: 44×44pt min (Apple HIG) / 48dp (Material) on touch tiers only —
  `.ci-touch` utilities bump paddings of Button sm, ActionMenu trigger (28px today),
  checkboxes (16px today), tab pills, table row hit zones.
- Typography: phone floors at 16px for inputs (prevents iOS auto-zoom on focus),
  body text min 13px on touch (11px micro-labels reserved for chips), page titles
  scale down (26→22 phone).
- Scrollbars: hidden on touch tiers (overlay behaviour is native); scroll chaining
  contained on sheets/drawers (`overscroll-behavior: contain`).
- No hover dependence on touch tiers: every hover-revealed affordance (Floor board
  hover spec, row hover actions) must have a visible-at-rest equivalent.

## Component design

### AppLayout / navigation
- **Desktop:** unchanged (fixed 264px glass rail, collapse behaviour intact).
- **Tablet (both orientations):** rail becomes a **72px icon rail**, always visible,
  labels under icons at 10px; groups collapse to dividers; Live Floor badge counts
  kept. Tapping the wordmark area expands a full 264px overlay drawer for group
  browsing. Content gets the remaining width (landscape: 1108–1294px usable).
- **Phone:** no side rail. **Bottom tab bar** (5 slots: Dashboard, Floor, Orders,
  Warehouse, More) within thumb reach, 64px + safe-area, glass. "More" opens a
  full-screen sheet listing every granted module grouped as today. Top bar slims to
  40px: wordmark → page title, chat/bell stay (they are the plant's two counters).
- Floating docks (Timeline capsule, Chat dock, toasts): on phone they stack **above
  the bottom bar** (`bottom: calc(64px + safe-area + 8px)`); on tablets inset from
  edges; never overlap row actions (the old `⋯`-covered bug).

### DataTable — the big one
Column spec gains optional metadata (all optional → zero change for untouched pages):
- `priority: 1|2|3` — 1 = always visible, 2 = tablet+, 3 = desktop-only (tablet
  hides; phone relegates to card detail).
- `card: { role }` — `title | subtitle | status | metric | detail | actions` placement
  hints for the phone card renderer.
- Fallback when a page passes no metadata: first text column = title, StatusBadge
  column = status, right-aligned columns = metrics (first two), rest = details.

**Desktop & tab-landscape:** the *same* `<table>` code path (desktop untouched).
On `tl:` only, CSS relaxes cell padding (px-2→px-3), row min-height 44px, hides
`priority 3` columns via `.ci-p3` col classes so the rest breathe — **no horizontal
scroll** except when a page explicitly opts its table out (`allowScroll`).
**Tab-portrait:** same table, hides priority 2+3, wider tap rows.
**Phone:** `useTier()==='phone'` renders a **card list** instead of `<table>`:
- Card: title line (bold, wraps 2 lines), status chip right; subtitle line; metric
  row (label:value pairs, tabular-nums); collapsed by default.
- Tap = `onRowClick` if the page has one; **chevron expands** in-place detail grid of
  every remaining column (progressive disclosure), including priority-3 data.
- Row actions (`ActionMenu` column) render as a `⋯` at card top-right → bottom sheet.
- Select mode: leading checkboxes appear when `selectable`; select-all in header bar.
- Search/export toolbar: search full-width, export beside it; windowing (60-row
  IntersectionObserver) reused as-is.
- Group headers (gang violet rows): a violet-railed section header card.

### Modal → bottom sheet (phone)
Same portal/backdrop/API. Phone: sheet pinned to bottom, full width, rounded top,
max-h 92dvh (dvh not vh — URL bar), drag-handle bar, footer buttons full-width
stacked, safe-area padded, `overscroll-behavior: contain`. Keyboard: `max-height`
uses `visualViewport` offset via small hook so focused inputs stay visible.
Tablet: centered but `wide` modals cap at 90vw. Desktop untouched.

### SearchableSelect (phone)
Menu min-width 460 → `min(460, 100vw-24)`; on phone the menu opens as a **bottom
sheet** with the search input pinned at top (16px font kills iOS zoom), options
44px tall. Tablet keeps popover with 44px options.

### ActionMenu (touch)
Trigger 28→40px on touch tiers. Phone: items render in a bottom sheet (danger
separated); tablet keeps popover with 44px rows.

### Tabs / GroupedTabs / SubTabs
Already scroll horizontally with edge fades — keep, but on touch: pill height ≥40px,
`scroll-snap-type: x proximity`, and GroupedTabs on phone flattens captions into a
single scrolling rail (captions become tiny overline inside first pill of group).

### KPI cards / KpiRow
Phone: 2-up grid always; compact variant forced; a `KpiRow` with >4 cards becomes a
horizontal snap-scroll rail (one row) so it stops eating half the first viewport.
Tablet landscape: existing grid counts already fit; tablet portrait: cap at 3-up.

### Forms (`ci-form-grid`, line items)
Phone: single column, 16px inputs, sticky submit footer inside sheets. Tab-portrait:
2-col. Line-item grids (`ci-line-item-grid` md 5-col) stack to labelled 2-col.

### Floor surfaces (Section, SortPaste, Floor, PrintPlanning, Gang kanban)
- Machine lanes / kanban columns: horizontal snap-scroll lanes on tablet (a lane =
  86vw phone / 320px tablet), never vertical-stacked-by-accident.
- Hand-rolled `<table>`s in Section/SortPaste get the same phone card treatment via a
  shared `StationQueueCards` built on the DataTable card primitives.
- Hover-only board spec (`a7a89bb` moved board to hover) gets a tap-to-peek
  equivalent on touch (chip tap toggles a one-line reveal).

## Page-by-page pass (all 31)

Module order: Floor group (Floor, Section, SortPaste, Logbook, ExtraSheets,
FinishedGoods) → Planning group (Planning, PrintPlanning, Orders, Production,
Artwork, Tooling, ShadeCards + drawer) → Supply (Procurement, Inventory, GRN flows,
CuttingVariances) → Overview/Admin (Dashboard, Track, StatusSheet, Reports, Masters,
Accounts, Dispatch, DispatchInvoice, Invoices, COA, Challan) → auth/print (Login;
print routes JobCardPrint/POPrint/Invoice untouched — they are A4 print surfaces).
Each page: audit at 402/800/1180/1280 → apply primitives → hand-fix leftovers
(chip wraps, truncations, grid collapses, sticky headers where long lists).

## QA matrix (mandatory before ship)

Viewports: 360×780, 384×832, 402×874, 412×915, 440×956, 800×1280, 820×1180,
1024×1366, 1180×820, 1280×800, 1366×1024 — plus desktop 1440×900 control.
Checks per screen: no horizontal body scroll (phones/tablets), no clipped/overlapped
text, no hidden actions, tap targets ≥44px, safe-area respected, keyboard doesn't
bury focused input, modals fit, docks don't cover content, KPI strips sane, empty
states centered, dark—n/a (no dark mode by Anik's rule).
Desktop control: screenshot + computed-style diff = zero change.
`npm run verify` green (baseline check, server tests, client build).

## Out of scope

Print routes' A4 layout; server/API; business logic; dark mode; PWA/manifest;
the deprecated `mobile-tablet-ui` branch (superseded — its traps honoured:
backdrop-filter ignored on table-cell → pinned cells paint opaque tints; display
classes never applied to inline elements without `-inline` twins).
