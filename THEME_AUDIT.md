# Colour Impressions SaaS — Theme & UI Consistency Audit

> **Date:** 14 May 2026  
> **Scope:** Full codebase scan of `/src` — app shell, all modules, design-system components, utility libs  
> **Purpose:** Identify visual inconsistencies that undermine the product's enterprise/SaaS presentation before sales demos

---

## Executive Summary

The design system foundation is **solid** — a well-defined token layer (`design-tokens.css`), a `ds-*` Tailwind palette, a `Button`, `Badge`, `StatusBadge`, `KpiTile`, `CardSection`, `PageHeader`, `EnterpriseTableShell`, and `StandardDrawer` component library. However, **~399 raw Tailwind color instances** are scattered across the codebase, bypassing the token layer. Combined with border-radius fragmentation, shadow inconsistencies, an unprofessional sidebar, and a few structural issues, the product currently reads like it was built by multiple developers without enforced standards — which is exactly what it cannot look like in a sales context.

**Token adoption rate: ~92% of color usage is correct (4,732 DS vs 399 raw). The remaining 8% is concentrated in ~15 hot files and is fully fixable.**

---

## Issue Inventory (Priority Order)

---

### 🔴 CRITICAL — Fix Before Any Demo

---

#### Issue 1 — Wrong App Title (Metadata Leak)

**File:** `src/app/layout.tsx` line 14

```ts
// CURRENT (BAD)
title: process.env.NEXT_PUBLIC_APP_NAME ?? 'Salary & Employee Management',

// FIXED
title: process.env.NEXT_PUBLIC_APP_NAME ?? 'Colour Impressions — Plant Management',
```

**Impact:** Any browser tab, SEO crawl, or screen share will show "Salary & Employee Management" if the env var is missing. This is a critical branding failure in a demo.

---

#### Issue 2 — Enterprise Table Styles Use Raw Tailwind in Light Mode

**File:** `src/lib/enterprise-table-styles.ts`

The most reused table utility across every data module uses DS tokens in dark mode but raw Tailwind neutrals in light mode. This creates a two-tier appearance.

| Token | Current (light mode) | Should Be |
|-------|---------------------|-----------|
| Table header bg | `bg-slate-50` | `bg-[var(--bg-elevated)]` |
| Header text | `text-neutral-500` | `text-[var(--text-secondary)]` |
| Header border | `border-neutral-200` | `border-[var(--border)]` |
| Body bg | `bg-white` | `bg-[var(--bg-card)]` |
| Body divider | `divide-neutral-200` | `divide-[var(--border)]` |
| Row hover | `hover:bg-slate-50` | `hover:bg-[var(--bg-elevated)]` |
| Cell text | `text-neutral-900` | `text-[var(--text-primary)]` |
| Muted cell | `text-neutral-500` | `text-[var(--text-secondary)]` |

**Impact:** Every table in the product (POs, Job Cards, Inventory, Hub ledgers, Billing) shows raw grays instead of the token-controlled palette. In light mode they look fine on a white screen but immediately look wrong when the app skin changes.

---

#### Issue 3 — Orphaned / Unused Font Variables

**Files:** `src/app/layout.tsx`, `src/app/(dashboard)/director/command-center/layout.tsx`, `tailwind.config.ts`

- `layout.tsx` only loads **Inter** under `--font-sans`
- `tailwind.config.ts` exposes `font-po-dashboard` → `var(--font-po-predictive)` and `font-designing-queue` → `var(--font-designing-queue)`, but **neither variable is ever loaded** — these resolve to the `ui-monospace` system fallback (Courier/monospace), so PO numbers and designing queue items render in a system monospace font on machines that have no JetBrains Mono installed
- Only `--font-director-cc` is actually loaded (JetBrains Mono in the director layout)

**Fix:** Either load JetBrains Mono globally as all three custom font vars, or replace the three Tailwind font classes with `font-mono` (which at least is explicit about monospace intent).

---

### 🟠 HIGH — Fix Before Sales Presentation

---

#### Issue 4 — Sidebar Navigation: Emoji Headers & Rainbow Border Colors

**File:** `src/app/(dashboard)/SidebarNav.tsx`

The sidebar uses emoji as section identifiers (`📊 DASHBOARD`, `📋 ORDERS`, `🔧 TOOLING HUB`, `🏭 PRODUCTION EXECUTION`, `🏭 PRODUCTION`, etc.) and 10 different raw Tailwind border-left colors to distinguish sections.

**Problems:**
1. Emoji in nav headers looks like a personal Notion page, not an enterprise B2B SaaS product
2. Two sections share the same emoji (`🏭`) — looks like a copy-paste error
3. The 10 different border colors (blue, emerald, orange, rose, teal, lime, indigo, purple, violet, warning) create visual chaos with no semantic meaning

**Current border colors (11 sections, 10 different colors):**
```
DASHBOARD       → border-l-blue-500
ORDERS          → border-l-blue-500     ← duplicate
TOOLING HUB     → border-l-emerald-500
PROD EXECUTION  → border-l-orange-500
PRODUCTION      → border-l-rose-500
INVENTORY       → border-l-teal-500
STORES          → border-l-ds-warning/90  ← only one using DS token
QUALITY         → border-l-lime-500
DISPATCH        → border-l-indigo-500
REPORTS         → border-l-purple-500
MASTERS         → border-l-violet-500
```

**Recommended fix:** Replace emojis with small Lucide icons (already imported) and collapse to 3–4 semantic colors using DS tokens:
- Brand/primary (`border-l-ds-brand`) for Orders, Production
- Neutral (`border-l-ds-lineStrong`) for Inventory, Stores, Masters
- Warning/amber (`border-l-ds-warning`) for Quality, Dispatch
- Muted (`border-l-ds-ink-faint`) for Reports, Dashboard

---

#### Issue 5 — Border Radius Fragmentation

**Scope:** 300+ instances across the codebase

The DS defines three radii: `rounded-ds-sm` (6px), `rounded-ds-md` (10px), `rounded-ds-lg` (12px). Many components use the default Tailwind scale instead:

| Tailwind Class | DS Equivalent | Used In |
|----------------|---------------|---------|
| `rounded-sm` | `rounded-ds-sm` | scattered |
| `rounded-md` | `rounded-ds-sm` or `rounded-ds-md` | widespread |
| `rounded-lg` | `rounded-ds-md` | Hub components |
| `rounded-xl` | `rounded-ds-lg` | modals, login |
| `rounded-2xl` | — (no DS equivalent) | remove |

**Worst offenders:**
- `HubPlateDashboard.tsx` — **86 non-DS border radius instances**
- `HubToolingKanbanDashboard.tsx` — 46
- `PoImportDrawer.tsx` — 29
- `director/command-center/page.tsx` — 27
- `hub/shade-card-hub/page.tsx` — 22
- `HubInventoryShell.tsx` — 20

The cards on the Plate Hub and Tooling Hub Kanban boards feel visually "rounder" than the rest of the app, breaking the uniform surface language.

---

#### Issue 6 — Shadow Inconsistency

**Scope:** ~20+ files

The DS defines: `shadow-ds-depth-sm` (subtle), `shadow-ds-depth` (card), `shadow-ds-drawer` (panels).

Many modules use standard Tailwind shadows: `shadow-xl`, `shadow-2xl`, `shadow-lg`, `shadow-md`.

Most critical instances:
- Login page card: `shadow-xl` → should be `shadow-ds-depth`
- `ci-hub-modal-panel` in globals.css: `shadow-2xl` → should be `shadow-ds-drawer`
- `HubPlateDashboard.tsx` modal panels: `shadow-xl shadow-black/40`
- Multiple Hub spotlight drawers

---

#### Issue 7 — Login Page Non-Conformance

**File:** `src/app/(auth)/login/page.tsx`

The login page is the first thing any visitor or demo viewer sees. It uses:

| Issue | Current | Should Be |
|-------|---------|-----------|
| Card radius | `rounded-xl` | `rounded-ds-lg` |
| Card shadow | `shadow-xl` | `shadow-ds-depth` |
| Text token | `text-foreground` (shadcn) | `text-ds-ink` |
| Title size | `text-2xl font-bold` | `ds-typo-heading` |
| No brand accent | Plain white card | Subtle `border-ds-brand/20` accent on card top or logo treatment |

---

#### Issue 8 — Button Pattern Fragmentation

4 parallel button patterns exist simultaneously:

1. **`Button.tsx`** (design-system) — canonical, has full variant set (`primary`, `secondary`, `danger`, `ghost`, `success`, `warning`, `info`, `icon`, `utility`)
2. **`ci-btn-save-industrial`** (globals.css) — duplicate of `Button primary`
3. **`ci-btn-procurement`** (globals.css) — another duplicate with `shadow-md`
4. **Inline ad-hoc** — dozens of `className="rounded-md bg-[var(--warning)] px-2 py-1 text-xs ..."` patterns scattered throughout Hub modules

**Fix:** Delete `ci-btn-save-industrial` and `ci-btn-procurement` from globals.css. Replace all inline button patterns in Hub modules with `<Button variant="warning" size="sm">`, `<Button variant="danger" size="sm">` etc.

---

### 🟡 MEDIUM — Fix for Consistency

---

#### Issue 9 — Raw Color Usage in Top Offender Files

**399 total instances** of raw Tailwind color values bypassing the DS token layer. These are concentrated:

| File | Raw Color Instances | Module |
|------|--------------------|----|
| `orders/procurement/page.tsx` | **83** | Procurement |
| `ShadeCardSpotlightDrawer.tsx` | 39 | Hub |
| `HubInventoryShell.tsx` | 32 | Hub |
| `hub/shade-card-hub/page.tsx` | 31 | Hub |
| `ShadeCardKanbanBoard.tsx` | 23 | Hub |
| `EmbossHubSpotlightDrawer.tsx` | 16 | Hub |
| `OperatorProfileDrawer.tsx` | 15 | Industrial |
| `hub/shade-card-hub/settings/page.tsx` | 11 | Hub |
| `hub/dies/settings/page.tsx` | 11 | Hub |
| `ProductionReadinessBar.tsx` | 9 | Orders |

Most common pattern is `bg-gray-100 text-gray-700` for status badges instead of `<StatusBadge>` or `<Badge tone="neutral">`.

---

#### Issue 10 — Orphaned Pharma Theme

**Files:** `tailwind.config.ts`, `src/styles/design-tokens.css`, plus 4 component files

A full `pharma-*` color palette (14 CSS variables covering `app`, `surface`, `hover`, `primary`, `secondary`, `tertiary`, `action`, `action-hover`, `border`, `ready`, `blocked`, `pending`) exists but is only used in 4 files:
- `rfq/new/page.tsx`
- `masters/customers/new/page.tsx`  
- `orders/designing/[poLineId]/page.tsx`
- `components/designing/AwGroupEditDrawer.tsx`

These 4 files have a visually distinct look from the rest of the app. This theme system should either be **adopted app-wide** or **removed**, and those 4 files migrated to the `ds-*` tokens.

---

#### Issue 11 — `tokens.ts` Still Uses Raw Tailwind Colors

**File:** `src/components/design-system/tokens.ts`

```ts
// CURRENT (BAD) — uses neutral-200, neutral-800, emerald-500
export const ACTION_PILL_NEUTRAL = `... border-neutral-200 bg-transparent text-neutral-800 ...`
export const PUSHED_CHIP_CLASS = `... border-emerald-500/35 bg-emerald-500/12 text-emerald-700 ...`

// SHOULD BE
export const ACTION_PILL_NEUTRAL = `... border-[var(--border)] bg-transparent text-[var(--text-primary)] ...`
export const PUSHED_CHIP_CLASS = `... border-[var(--success)]/35 bg-[var(--success-bg)] text-[var(--success)] ...`
```

These tokens are imported by many pages — fixing here propagates automatically.

---

#### Issue 12 — SidebarNav Is Defined But Not Rendered

**File:** `src/app/(dashboard)/SidebarNav.tsx`

`SidebarNav` is defined as a component but is **not imported anywhere in the codebase**. The `DashboardShell.tsx` uses a horizontal mega-menu top nav instead. If `SidebarNav` is a planned left-rail nav, it needs to be integrated; if abandoned, it should be deleted to avoid dead code confusion.

---

#### Issue 13 — Inconsistent Page Container Widths

Some pages use `max-w-7xl`, some use `max-w-6xl`, some use `max-w-[1920px]` (header), some have no max-width at all. On wide screens this creates wildly different content widths across modules.

**Recommendation:** Standardize to `max-w-[1600px] mx-auto px-4 sm:px-6` as the page root wrapper across all module pages.

---

### 🔵 LOW — Polish Items

---

#### Issue 14 — `ds-toolbar` and `ds-toolbar-search` Use `bg-white` Instead of Token

**File:** `src/app/globals.css` lines 25, 28

```css
/* CURRENT */
.ds-toolbar { @apply ... bg-white ...; }
.ds-input   { @apply ... bg-white ...; }

/* SHOULD BE */
.ds-toolbar { @apply ... bg-[var(--bg-card)] ...; }
.ds-input   { @apply ... bg-[var(--bg-card)] ...; }
```

In dark mode these toolbars stay white, making them stand out incorrectly.

---

#### Issue 15 — `PageHeader` Title Size Duplication

**File:** `src/components/design-system/PageHeader.tsx` line 20

```tsx
<h1 className="text-lg font-semibold tracking-tight text-ds-ink md:text-lg">
```

Both responsive sizes are `text-lg` — the `md:text-lg` is redundant and suggests the responsive scaling was removed/forgotten. Should be `text-base md:text-xl` or use `ds-typo-heading`.

---

## What Is Already Working Well ✅

- **Color token system**: `ds-*` Tailwind palette + CSS variable layer is well-architected and correctly handles dark mode via the `.dark` class
- **`Button.tsx`**: Full variant system, correct token usage, forwardRef — production quality
- **`Badge.tsx` + `StatusBadge.tsx`**: Correct DS token mapping, covers all semantic states
- **`CardSection.tsx`, `KpiTile.tsx`, `PageHeader.tsx`**: All use DS tokens correctly
- **`EnterpriseTableShell.tsx`**: Wrapper is correct (issue is in the imported style constants)
- **`StandardDrawer.tsx`**: Clean, DS-aligned
- **Dark mode architecture**: Solid — the `.dark` class + CSS var swap approach is correct
- **Density control**: UI density toggle (Dense/Comfortable) is implemented and works
- **Accent preset system**: `applyAccentPreset` + `getStoredAccentPreset` is a nice extensible pattern

---

## Recommended Fix Sequence (Claude Code Prompts)

Use these prompts in sequence. Each is self-contained.

---

### Prompt 1 — Fix App Title & Font Loading

```
In src/app/layout.tsx:

1. Change the metadata fallback title from 'Salary & Employee Management' to 'Colour Impressions — Plant Management'

2. Add JetBrains_Mono font loading alongside Inter:
   - Load JetBrains_Mono with subsets: ['latin'], weights ['400','600','700'], variable '--font-po-predictive', display: 'swap'
   - Apply both font variables to the <body> className: `${inter.variable} ${jetbrainsMono.variable}`

3. In the director/command-center/layout.tsx, remove the local JetBrains_Mono load since it will now be loaded globally — just keep the className wrapper with the variable.
```

---

### Prompt 2 — Fix Enterprise Table Styles (Highest Impact)

```
In src/lib/enterprise-table-styles.ts, replace all hardcoded Tailwind gray/neutral/slate 
values in the light-mode portions of each string with CSS variable equivalents:

- Replace `text-neutral-900` with `text-[var(--text-primary)]`
- Replace `text-neutral-500` with `text-[var(--text-secondary)]`
- Replace `bg-slate-50` with `bg-[var(--bg-elevated)]`
- Replace `border-neutral-200` with `border-[var(--border)]`
- Replace `divide-neutral-200` with `divide-[var(--border)]`
- Replace `bg-white` with `bg-[var(--bg-card)]`
- Replace `hover:bg-slate-50` with `hover:bg-[var(--bg-elevated)]`

Keep all `dark:` variants as-is — they already use DS tokens correctly.
```

---

### Prompt 3 — Fix Design System Tokens File

```
In src/components/design-system/tokens.ts:

1. Replace ACTION_PILL_NEUTRAL:
   Change `border-neutral-200 bg-transparent text-neutral-800`
   To `border-[var(--border)] bg-transparent text-[var(--text-primary)]`
   And `dark:border-border/20 dark:text-ds-ink` → remove (now handled by vars)

2. Replace PUSHED_CHIP_CLASS:
   Change `border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300`
   To `border-[var(--success)]/35 bg-[var(--success-bg)] text-[var(--success)]`
```

---

### Prompt 4 — Fix globals.css (toolbar and button classes)

```
In src/app/globals.css:

1. In .ds-toolbar, replace `bg-white` with `bg-[var(--bg-card)]`
2. In .ds-input, replace `bg-white` with `bg-[var(--bg-card)]`
3. In .ds-toolbar-search, it extends .ds-input so no change needed
4. Delete the .ci-btn-save-industrial and .ci-btn-procurement class definitions entirely 
   (these are duplicates of the Button component and should be replaced with 
   <Button variant="primary"> in any JSX that uses these class names)
5. In .ci-hub-modal-panel, replace `shadow-2xl` with `shadow-ds-drawer`
```

---

### Prompt 5 — Fix Login Page

```
In src/app/(auth)/login/page.tsx:

1. Replace `rounded-xl` with `rounded-ds-lg` on the card container
2. Replace `shadow-xl` with `shadow-ds-depth` on the card container
3. Replace `text-foreground` with `text-ds-ink` wherever it appears
4. Replace `text-2xl font-bold` on the heading with `text-[22px] font-semibold`
5. Add `border-t-2 border-t-ds-brand/30` to the card's className to give it 
   a subtle brand accent stripe at the top — professional SaaS login feel
```

---

### Prompt 6 — Fix Sidebar Navigation (Biggest UX Win)

```
In src/app/(dashboard)/SidebarNav.tsx:

1. Remove all emoji from section title strings. Replace with plain text:
   - '📊 DASHBOARD' → 'DASHBOARD'  
   - '📋 ORDERS' → 'ORDERS'
   - '🔧 TOOLING HUB' → 'TOOLING HUB'
   - '🏭 PRODUCTION EXECUTION' → 'PRODUCTION EXEC.'
   - '🏭 PRODUCTION' → 'PRODUCTION FLOOR'
   - '📦 INVENTORY' → 'INVENTORY'
   - '🏪 STORES' → 'STORES'
   - '✅ QUALITY' → 'QUALITY'
   - '🚚 DISPATCH' → 'DISPATCH'
   - '📈 REPORTS' → 'REPORTS'
   - '⚙️ MASTERS' → 'MASTERS'

2. Collapse the 10 different borderColor values to 3 semantic ones using DS tokens:
   - dashboard, orders, design → 'border-l-ds-brand'
   - tools, execution, production → 'border-l-ds-warning'
   - inventory, stores, quality, dispatch → 'border-l-ds-ink-faint/50'  
   - reports, masters → 'border-l-ds-line'
   
   Update each section's `borderColor` property accordingly.

3. The SidebarNav component is defined but never imported anywhere.
   Either: (a) import it into DashboardShell.tsx as a left rail sidebar, 
   or (b) delete the file if the horizontal mega-menu is the chosen nav pattern.
```

---

### Prompt 7 — Fix Hub Module Border Radius (Largest File)

```
In src/components/hub/HubPlateDashboard.tsx (86 instances) and 
src/components/hub/HubToolingKanbanDashboard.tsx (46 instances):

Do a bulk find-and-replace:
- `rounded-2xl` → `rounded-ds-lg`
- `rounded-xl` → `rounded-ds-lg`  
- `rounded-lg` → `rounded-ds-md`
- `rounded-md` → `rounded-ds-sm`
- `rounded-sm` (standalone, not as part of `rounded-ds-sm`) → `rounded-ds-sm`

Also replace shadow values:
- `shadow-xl` → `shadow-ds-depth`
- `shadow-2xl` → `shadow-ds-drawer`
- `shadow-lg` → `shadow-ds-depth`

Be careful not to touch `rounded-ds-*`, `rounded-full` (used for circular elements 
like colour swatches and avatars — intentional), or class names inside string 
comparisons/logic.
```

---

### Prompt 8 — Resolve Pharma Theme (Strategic Decision Required)

```
The pharma-* color system (14 CSS variables in design-tokens.css, 14 Tailwind 
aliases in tailwind.config.ts) is only used in 4 files:
  - src/app/(dashboard)/rfq/new/page.tsx
  - src/app/(dashboard)/masters/customers/new/page.tsx
  - src/app/(dashboard)/orders/designing/[poLineId]/page.tsx
  - src/components/designing/AwGroupEditDrawer.tsx

OPTION A (Remove): Delete the pharma-* CSS variables from design-tokens.css, 
delete the pharma color key from tailwind.config.ts, and replace all pharma-* 
class usages in the 4 files above with their ds-* equivalents:
  - pharma-app → ds-main
  - pharma-surface → ds-card  
  - pharma-border → ds-line
  - pharma-primary → ds-ink
  - pharma-secondary → ds-ink-muted
  - pharma-action → ds-brand
  - pharma-action-hover → ds-brand-hover
  - pharma-ready-bg / pharma-ready-fg → use success token
  - pharma-blocked-bg / pharma-blocked-fg → use error token
  - pharma-pending-bg / pharma-pending-fg → use warning token

OPTION B (Adopt): Keep the pharma system and consistently use it for the 
RFQ/Customer/Designing flow as a intentional sub-theme skin.
```

---

### Prompt 9 — Standardize Page Container Widths

```
Audit all page root <div> wrappers in:
  src/app/(dashboard)/**/*.tsx  (top-level page.tsx files only, not components)

For any that do NOT have a consistent container wrapper, add:
  <div className="mx-auto max-w-[1600px] px-4 sm:px-6 py-4">

For any that already use max-w-7xl, max-w-6xl, or other widths, 
standardize to max-w-[1600px].

The DashboardShell header uses max-w-[1920px] — leave that as-is, 
it's for the full-bleed header bar.
```

---

## Impact Matrix

| Issue | Visual Impact | Effort | Priority |
|-------|--------------|--------|----------|
| Wrong app title | 🔴 High (identity) | 5 min | P0 |
| Enterprise table raw colors | 🔴 High (every table) | 30 min | P0 |
| Orphaned font variables | 🟠 Medium (monospace fallback) | 20 min | P1 |
| Sidebar emoji + rainbow | 🔴 High (nav is always visible) | 20 min | P1 |
| Border radius fragmentation | 🟠 Medium (corner feel) | 2–3 hrs | P1 |
| Shadow inconsistency | 🟡 Low-Medium | 1 hr | P2 |
| Login page polish | 🔴 High (first impression) | 15 min | P1 |
| Button fragmentation | 🟠 Medium | 2 hrs | P2 |
| Raw colors in Hub/Procurement | 🟠 Medium (module-specific) | 3–4 hrs | P2 |
| Orphaned pharma theme | 🟡 Low (contained) | 1 hr | P3 |
| tokens.ts raw colors | 🟡 Low (subtle) | 10 min | P2 |
| SidebarNav dead code | 🟡 Low | 5 min | P3 |
| Page container widths | 🟡 Low-Medium | 1 hr | P3 |
| toolbar bg-white in dark | 🟡 Low (dark mode only) | 5 min | P2 |
| PageHeader title redundancy | 🔵 Negligible | 2 min | P3 |

**Total estimated fix time: ~12–15 hours of focused dev work across all prompts.**

---

## Files That Are Clean — Do Not Touch

These files already follow DS conventions correctly and should not be modified as part of this audit:

- `src/components/design-system/Button.tsx`
- `src/components/design-system/Badge.tsx`
- `src/components/design-system/StatusBadge.tsx`
- `src/components/design-system/CardSection.tsx`
- `src/components/design-system/StandardDrawer.tsx`
- `src/components/design-system/KpiTile.tsx`
- `src/components/design-system/AppLayout.tsx`
- `src/components/ui/EnterpriseTableShell.tsx` (wrapper only — styles are in the lib file)
- `src/styles/design-tokens.css`
- `src/components/design-system/index.ts`
