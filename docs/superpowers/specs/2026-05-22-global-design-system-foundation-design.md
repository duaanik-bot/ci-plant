# Global Design System — Foundation Sub-Project

> **Date:** 2026-05-22
> **Program:** Colour Impressions Global UI Standardization & Visual Governance
> **This spec:** Sub-project 1 of N — the **Foundation**. Everything else (per-module rollouts) rides on this.

---

## 1. Context

Colour Impressions is a Next.js 14 (App Router) manufacturing OS with a Prisma/NextAuth
backend, ~107 dashboard pages, and an **already-mature** `ds-*` design-token system
(`src/styles/design-tokens.css`, Tailwind `ds-*` palette, `Button`/`Badge`/`StatusBadge`/
`CardSection`/`KpiTile`/`PageHeader`/`EnterpriseTableShell`, light/dark via `next-themes`).

A product-wide visual governance program mandates standardizing every screen against a master
reference (Linear/Stripe/Attio-inspired premium SaaS). This is **visual standardization only** —
no business logic, workflow, routing, permission, API, schema, calculation, or validation changes.

The full program is too large for one spec. It is decomposed into a **Foundation** (this spec)
plus subsequent per-module rollout specs. The Foundation establishes the tokens, typography,
theme behavior, shared component library, the single modal component, and the always-visible
app shell that every later module change depends on.

### Decisions locked with stakeholder (2026-05-22)
1. **Brand color → blue `#2563EB`.** Replace orange (`#f5820d` / runtime `#F97316`) everywhere,
   including removing the runtime orange override in `src/lib/accent-theme.ts`.
2. **Centered `GlobalPopoutModal` everywhere.** All side drawers are migrated to one centered
   modal component (drawer migration of *module-specific* drawers happens in module rollouts;
   Foundation builds the component + migrates the *shared* drawers).
3. **Foundation first**, then module-by-module rollout (each module = its own spec → plan).
4. **Evolve existing components + `App*` aliases.** Do NOT build a parallel `App*` set. Restyle
   the existing canonical components to the new tokens and add `App*` names as thin re-exports.

---

## 2. Scope

### In scope (Foundation)
- **Design tokens**: rebrand to blue; add `ds-card` (16px) / `ds-modal` (18px) radii; recolor
  `--ds-focus`; align status-badge palette to spec hexes.
- **Runtime override removal**: rewrite `accent-theme.ts` so blue is the source of truth.
- **Typography**: load Geist (primary) + a mono for technical text; remove the tangled
  `--font-sans` indirection and the 3 orphaned mono font vars from the prior audit.
- **Theme toggle**: collapse 3-mode (Light/System/Dark) → **2-mode (Light/Dark)**, persisted,
  positioned between Notifications and User Profile in the top nav.
- **Component library**: restyle canonical components to new tokens; add `App*` re-export aliases
  (`AppButton`, `AppCard`, `AppTable`, `AppInput`, `AppSearch`, `AppBadge`, `AppToolbar`, `AppTabs`).
- **`GlobalPopoutModal`**: new single centered-modal component with spec-mandated sizes/behavior.
- **Shared drawer migration**: point `StandardDrawer`, `Drawer`, `IndustrialSheet`,
  `SlideOverPanel` at `GlobalPopoutModal` (so consumers get centered modals without per-call edits).
- **App shell**: restyle `DashboardShell` top nav to the new standard; wire the new theme toggle.

### Out of scope (deferred to module rollouts)
- The 107 page bodies and module-specific drawers/modals.
- Removing/migrating the orphaned `pharma-*` theme (tracked, handled in a later cleanup spec).
- Sidebar emoji/rainbow cleanup beyond the shared shell (audit Issue 4) unless in `DashboardShell`.
- Border-radius/raw-color sweeps inside individual module files.

### Non-goals (program-wide, never)
No changes to business logic, workflow sequence, routing, permissions, APIs, backend, schema,
data structures, calculations, validation, approval/production/inventory/purchase/dispatch/billing/
planning/reporting logic, user journeys, module hierarchy, or navigation structure.

---

## 3. Design

### 3.1 Token changes (`src/styles/design-tokens.css`)
Blue replaces orange while preserving the existing variable architecture (semantic vars +
`ds-*` RGB-triplet mirrors + `.dark` overrides):

| Variable | Old | New |
|---|---|---|
| `--brand-primary` | `#f5820d` | `#2563EB` |
| `--brand-primary-hover` | `#d9700b` | `#1D4ED8` |
| `--brand-bg-soft` / `--brand-bg-strong` | orange rgba | blue rgba `(37,99,235,…)` |
| `--ds-accent-rgb` | `245 130 13` | `37 99 235` |
| `--ds-accent-hover-rgb` | `217 112 11` | `29 78 216` |
| `--ds-kpi-rgb` | `245 130 13` | `37 99 235` |

Dark theme: primary blue shifts to `#3B82F6` per spec (`--ds-accent` override added under `.dark`).
Semantic success/warning/error/info keep their existing tokens (already spec-compatible).

### 3.2 Radius & shadow (`tailwind.config.ts`)
- **Add** `borderRadius`: `ds-card: '16px'`, `ds-modal: '18px'`. Keep `ds-sm/md/lg` (6/10/12).
- Mapping convention (documented for module rollouts): inputs → `rounded-ds-md` (10),
  buttons → `rounded-ds-lg` (12), cards → `rounded-ds-card` (16), modals → `rounded-ds-modal` (18),
  badges → `rounded-full`.
- Recolor `boxShadow.ds-focus` from orange rgba to `rgba(37,99,235,0.2)`.

### 3.3 Runtime override (`src/lib/accent-theme.ts`)
Rewrite `BRAND` to blue (`accent #2563EB`, hover `#1D4ED8`, RGB `37 99 235` / `29 78 216`,
`primaryHsl`/`ringHsl` to the blue HSL `217 91% 60%`). `applyAccentPreset` keeps its signature
(callers unchanged) but now applies blue. Default stored preset stays a no-op-equivalent so blue
is consistent regardless of stored value.

### 3.4 Typography
- `src/app/layout.tsx`: load `Geist` (next/font) as `--font-geist` (sans) + keep a mono
  (`Geist_Mono` or retain IBM Plex Mono) as `--font-mono`. Apply both vars to `<body>`.
- `tailwind.config.ts`: `fontFamily.sans` → `['var(--font-geist)','Inter','system-ui','sans-serif']`.
  Remove the 3 orphaned mono families (`po-dashboard`, `designing-queue`) or repoint them to
  `var(--font-mono)`; keep `director-cc` repointed to `--font-mono`.
- `design-tokens.css`: repoint `--font-heading/body/label/small` to `var(--font-geist)` and
  `--font-mono` to the loaded mono var. Remove dead `--font-jakarta`/`--font-plex-mono` references.

### 3.5 Theme toggle (`src/components/theme/ThemeToggle.tsx`)
Two buttons only — **Light** and **Dark** (remove the System button and all `system`/`resolvedTheme`
branches). Sun/moon affordance per spec layout (`☀ Light [toggle] Dark 🌙`). Persist via
`next-themes` (already localStorage-backed); 200ms color transition; no flicker
(`suppressHydrationWarning` already on `<html>`). `Providers` `ThemeProvider` config set to
`enableSystem={false}` so System cannot be reached.

### 3.6 Component library
Restyle existing canonical components (`Button`, `Badge`, `StatusBadge`, `CardSection`,
`DataTable`, `InputField`, `SelectDropdown`, `ActionBar`, etc.) to the new tokens/radii. Do **not**
change their public props/APIs (module pages already consume them).

Add `App*` aliases in `src/components/design-system/index.ts` as thin re-exports:
`AppButton = Button`, `AppCard = CardSection`, `AppTable = DataTable`, `AppInput = InputField`,
`AppSearch` = the search input variant, `AppBadge = Badge`, `AppToolbar = ActionBar`,
`AppTabs` = the tabs component (create a minimal `Tabs` if none exists). Aliases let the program's
vocabulary be used going forward without duplicating implementations.

### 3.7 `GlobalPopoutModal` (new — `src/components/design-system/GlobalPopoutModal.tsx`)
Built on the existing `@radix-ui/react-dialog` dependency.
- **Sizes**: `sm 420 / md 640 / lg 900 / xl 1180 / fullscreen 95vw` (prop `size`).
- **Layout**: centered; sticky header; sticky footer; only body scrolls; `rounded-ds-modal`.
- **Backdrop**: `rgba(0,0,0,.45)` + `blur(2px)` (cap at 2px — no heavy glassmorphism).
- **Behavior**: lock background scroll; page visible underneath; focus enters + traps; restore
  focus on close; ESC closes; always-visible close button (all native to Radix Dialog).
- **Animation**: 180ms; open `opacity 0→1` + `scale .98→1`; close reverse (framer-motion present;
  or CSS — implementation detail in the plan).
- **Size mapping doc** (for module rollouts): status/approval/remarks → `sm`; tooling/material → `md`;
  PO/planning/artwork/job-card/dispatch detail → `xl`; reports/large editors → `fullscreen`.

### 3.8 Shared drawer migration
`StandardDrawer`, `Drawer`, `IndustrialSheet`, `SlideOverPanel` are reimplemented as thin wrappers
that render `GlobalPopoutModal` (preserving their existing prop signatures where feasible) so that
every consumer of a *shared* drawer immediately becomes a centered modal with no per-call-site edits.
Module-specific drawers (Planning/Hub/PO/etc.) are migrated in their own module specs. If a shared
drawer's prop surface can't cleanly map to the modal, the plan flags it for case-by-case handling
rather than silently changing behavior.

### 3.9 App shell (`src/app/(dashboard)/DashboardShell.tsx`)
Restyle the always-visible top nav (surfaces, borders→whitespace, typography, button variants) to
the new tokens. Wire the 2-mode `ThemeToggle` between Notifications and User Profile. **No nav
structure / hierarchy / routing changes.** Sidebar emoji/rainbow cleanup only if it lives in the
shell; otherwise deferred.

---

## 4. Component / unit boundaries
- **Tokens layer** (`design-tokens.css` + `tailwind.config.ts` + `accent-theme.ts`): single source
  of truth for color/radius/shadow/type. Consumers depend only on token names, not hexes.
- **`GlobalPopoutModal`**: one purpose (centered overlay surface). Consumed via `size` + slots
  (header/body/footer). Internals replaceable without breaking consumers.
- **Canonical components + `App*` aliases**: stable public props; restyle is internal.
- **Shared drawers**: adapters over `GlobalPopoutModal`; isolate the migration blast radius.

---

## 5. Error / edge handling
- **Theme flash**: rely on existing `suppressHydrationWarning` + `next-themes`; verify no FOUC on
  hard reload in both themes.
- **Stored `system` preference**: with `enableSystem={false}`, any persisted `system` value
  resolves to a concrete theme; toggle defaults to Light if value is unknown.
- **Drawer prop mismatch**: any shared-drawer prop that can't map to the modal is flagged in the
  plan, not silently dropped.
- **Token regressions**: `ds-focus` and shadcn `--primary`/`--ring` must all flip to blue together
  (split-brain orange ring is the failure mode to check).

---

## 6. Acceptance criteria
1. Primary actions, focus rings, KPIs, and accents render **blue** across the app shell, login, and
   the Customer PO reference screen in **both** light and dark — with **no** residual orange
   (runtime override removed; grep for orange hexes returns only intentional non-brand uses).
2. Theme toggle shows exactly **Light / Dark**, persists across reload, transitions in ~200ms, no flash.
3. `GlobalPopoutModal` exists with all 5 sizes and the full behavior contract (scroll lock, focus
   trap/restore, ESC, sticky header/footer, body-only scroll, 2px backdrop blur, 180ms animation).
4. Opening any **shared** drawer (`StandardDrawer`/`Drawer`/`IndustrialSheet`/`SlideOverPanel`)
   renders a centered modal, not a side panel.
5. `App*` aliases exported and type-check; existing component props unchanged.
6. Geist is the active sans font; the 3 orphaned mono vars no longer fall back to system monospace.
7. `npm run typecheck` passes; dev-server visual pass on shell + login + Customer PO in both themes
   shows no broken layouts, no console errors.
8. **Zero** changes to routing, permissions, APIs, schema, or any business/workflow logic.

---

## 7. Verification plan
- `npm run typecheck`.
- Dev server (`npm run dev`): visual pass on the app shell, login page, and Customer PO screen in
  both light and dark; open a shared drawer to confirm centered-modal behavior; toggle theme to
  confirm 2-mode + persistence + no flash.
- Grep audit: confirm no remaining orange brand hexes (`f5820d`, `F97316`, `d9700b`, `EA580C`) in
  token/runtime/shell files.

---

## 8. Follow-on sub-projects (not this spec)
Module rollout specs, each its own spec → plan → implementation, in suggested order:
Customer PO → Planning → Artwork → Tooling Hub → Production → Purchase → Inventory → Quality →
Dispatch → Billing → Reports → Masters → Administration. Each migrates its pages, module-specific
drawers→`GlobalPopoutModal`, radius/raw-color sweeps, and applies the module accent color as a
subtle accent only. A separate cleanup spec handles the orphaned `pharma-*` theme.
