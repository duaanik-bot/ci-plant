# Global Pop-out Modal System — Design

**Date:** 2026-05-22
**Status:** Approved (Approach A)
**Author:** Anik Dua + Claude

## Goal

Replace the right-side drawer / slide-over experience with a single reusable
**centered pop-out modal** system across the entire work tree. This is a
presentation-layer refactor only. No backend logic, APIs, data flow, routing,
DB schema, business rules, status logic, validation, or module wiring changes.

Existing click triggers, form fields, validation, save/update/delete/submit
actions, selected-row state, keyboard/accessibility behavior, and unsaved-change
warnings are all preserved.

## Current State (as explored)

- **Stack:** Next.js 14 (App Router), Tailwind 3, `@radix-ui/react-dialog` (available,
  lightly used), framer-motion, lucide-react, sonner. Design tokens are `ds-*`
  utility classes (`bg-ds-card`, `bg-ds-main`, `border-ds-line`, `text-ds-ink`,
  `text-ds-ink-muted`, `text-ds-ink-faint`, `bg-ds-elevated`, `shadow-modal`,
  `shadow-ds-drawer`, `rounded-ds-lg`, `rounded-ds-md`, `rounded-ds-sm`).
- **`SlideOverPanel`** (`src/components/ui/SlideOverPanel.tsx`) is the shared base
  primitive: right-rail slide-over with sticky header (title + headerMeta + close),
  scroll body, optional sticky footer; mounted/visible state drives a 220ms exit
  animation; Escape closes. **25 files import it directly.**
- **`StandardDrawer`** (`src/components/design-system/StandardDrawer.tsx`) wraps
  `SlideOverPanel`, adding a `title`/`metadata`/`primaryAction`/`secondaryAction`/
  `footer` API. Used in 2 files.
- **`Modal`** (`src/components/ui/Modal.tsx`) is an orphan centered modal (sizes
  sm/md/lg/xl/full, backdrop blur, scale-in, Esc + click-outside close, scroll
  lock, `ds-*` tokens). **0 consumers** — to be folded in / deleted.
- **Customer PO detail** (`src/app/(dashboard)/orders/purchase-orders/page.tsx`,
  the `<SlideOverPanel>` block ~line 1346) uses `SlideOverPanel` directly. Sections
  already map onto the spec: PO summary (customer/value), tooling readiness bar,
  line items (`PoDrawerSpotlightLines`), status dropdown, full-page editor link.
- **Bespoke drawers that roll their own DOM** (need manual migration, later phases):
  `planning/PlanningJobDetailDrawer`, `planning/OperatorHandshakeDrawer`,
  `planning/PlanningReadinessDrawer`, `planning/PlanningPoSummaryDrawer`,
  `planning/PlanningProductDetailDrawer`, `po/PoNewLineItemDrawer`,
  `production/JobCardHubAuditDrawer`, `hub/ShadeCardSpotlightDrawer`.

## Approach (A): Convert the shared primitive in place

Rewrite `SlideOverPanel`'s internals from a right-rail slide-over into a **centered
pop-out modal**, keeping its prop API identical so all 25 consumers + `StandardDrawer`
+ the Customer PO pilot convert with **zero call-site edits**. Introduce
`GlobalPopoutModal` as the canonical, fully-featured export; `SlideOverPanel`
becomes a thin deprecated alias that forwards to it. The orphan `Modal` is removed.
Roll-their-own drawers are migrated in later phases.

Rejected alternatives: (B) build fresh + rewrite all 25 call sites — far more churn
and per-site regression risk; (C) opt-in modal alongside the existing slide-over —
leaves two systems and side drawers alive, failing the "no side drawer anywhere" goal.

## Component: `GlobalPopoutModal`

**Location:** `src/components/design-system/GlobalPopoutModal.tsx`

**Props**

```ts
type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'fullscreen'

type ModalAction = {              // mirrors StandardDrawerAction
  label: string
  loadingLabel?: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}

type GlobalPopoutModalProps = {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  metadata?: ReactNode            // optional sub-line / metadata row
  children: ReactNode
  size?: ModalSize                // default 'md'
  /** 'preview' = light read-only popups: backdrop-click AND Esc close.
   *  'form'    = editors/forms: backdrop-click does NOT close; Esc closes
   *              only when hasUnsavedChanges is false. */
  mode?: 'preview' | 'form'       // default 'form'
  hasUnsavedChanges?: boolean     // default false
  primaryAction?: ModalAction
  secondaryAction?: ModalAction
  footer?: ReactNode              // overrides built-in action row
  bodyClassName?: string
  /** Escape hatch for width overrides migrated from SlideOverPanel widthClass. */
  widthClass?: string
  zIndexClass?: string            // default 'z-[1100]'
}
```

**Sizes (desktop max-width):**

| size       | max-width |
|------------|-----------|
| sm         | 420px     |
| md         | 640px     |
| lg         | 900px     |
| xl         | 1180px    |
| fullscreen | 95vw      |

Body `max-h-[88vh]`; internal scroll only when content overflows. `widthClass`,
when passed, wins over the size token (preserves migrated overrides).

**Structure (top → bottom):**
- **Backdrop:** `fixed inset-0`, centered flex, `bg-ds-main/50 backdrop-blur-sm`,
  fades in/out.
- **Panel:** `bg-ds-card rounded-ds-lg shadow-modal`, flex column, `max-h-[88vh]`,
  scale+fade entrance.
  - **Header (sticky, shrink-0):** `title` (`ds-typo-heading`), optional `metadata`
    row (`text-ds-ink-muted`), always-visible top-right close button (lucide `X`).
    Border-bottom `border-ds-line`.
  - **Body (flex-1, overflow-y-auto):** `children`. Padding `px-4 py-4 md:px-6`.
  - **Footer (sticky, shrink-0, optional):** present only when `footer` or an action
    is supplied. Built-in row = secondary (left/`variant="secondary"`) + primary,
    matching `StandardDrawer`'s current footer markup. Border-top `border-ds-line`.

**Behavior:**
1. Centered on screen, background dimmed + blurred.
2. Size dynamic via `size` prop; `widthClass` override honored.
3. Never oversized: width capped by size token, height capped at 88vh; footer/header
   sticky so body never leaves dead space.
4. Internal body scroll only when content is long.
5. **Body scroll lock** while open (`document.body.style.overflow`), restored on close.
6. **Escape:** `mode="preview"` → closes. `mode="form"` → closes only when
   `hasUnsavedChanges === false`.
7. **Backdrop click:** `mode="preview"` → closes. `mode="form"` → ignored.
8. **Close button (X):** always visible top-right, always closes (caller decides
   whether to guard via its own onClose; the X is the deliberate exit).
9. **Accessibility:** `role="dialog"`, `aria-modal="true"`, labelled by title; focus
   moves into the modal on open and is restored to the trigger on close; focus trap
   keeps Tab within the modal.
10. **Animation:** reuse SlideOverPanel's `mounted`/`visible` state pattern for a
    220ms scale+fade exit (no new dependency).

**Responsive:**
- Desktop: size px max-width, centered.
- Tablet (`< md`): `width: 90vw`.
- Mobile (`< sm`): near-fullscreen, rounded top corners, footer pinned to bottom.

## Migration mechanics (Phase 1)

- **`SlideOverPanel`** keeps its exact prop signature (`title`, `headerMeta`,
  `isOpen`, `onClose`, `children`, `footer`, `widthClass`, `backdropClassName`,
  `panelClassName`, `animateEnter`, `zIndexClass`) and becomes a thin adapter that
  renders `GlobalPopoutModal` (maps `headerMeta` → `metadata`, `widthClass` →
  `widthClass`, passes footer through). The adapter forwards **`mode="preview"`** so
  it preserves current SlideOverPanel behavior exactly — today it closes on *both*
  backdrop-click and Escape, and `preview` keeps that. (`GlobalPopoutModal`'s own
  default for fresh, directly-authored usage is `mode="form"`, the safer default for
  editors; only the legacy adapter overrides to `preview`.) Marked `@deprecated`
  in a JSDoc comment pointing to `GlobalPopoutModal`. The right-rail slide
  transform/`translate-x` styling is removed.
- **`StandardDrawer`** is unchanged externally (still wraps `SlideOverPanel`), so its
  2 consumers convert for free. Its `StandardDrawerAction` shape is reused by
  `GlobalPopoutModal` (or shared from one location).
- **Customer PO pilot:** no change to `purchase-orders/page.tsx` is required beyond
  the primitive swap. Choose `size="lg"` (or `xl`) via the existing `widthClass`/size
  path if the default feels narrow. Verify in browser.
- **Orphan `Modal`** (`src/components/ui/Modal.tsx`): delete after confirming 0
  consumers (already confirmed).

## Verification (Phase 1 gate)

Customer PO detail, verified in the browser via the preview tools:
- Row click still opens the detail (centered modal, not a rail).
- Background dims + blurs; page does not scroll behind the modal.
- PO summary, tooling readiness bar, line-item list, status dropdown, and
  "Open full-page editor" link all render cleanly with no dead space and correct
  internal scroll when line items are long.
- Status change still fires `handleStatusChange` (business logic untouched).
- Esc + backdrop both close (PO detail rides the adapter default `mode="preview"`,
  matching today's behavior — status edits apply immediately on change, no dirty-form
  guard needed).
- No console/network errors; existing tests still pass.

## Out of scope for Phase 1 (later phases)

- Migrating the 8 roll-their-own bespoke drawers (5 planning, PoNewLineItem,
  JobCardHubAudit, ShadeCardSpotlight).
- Removing dead slide-over-specific CSS/tokens (`shadow-ds-drawer`,
  `shadow-ds-drawer-foot`) once no consumer remains.
- Module-by-module rollout + per-module browser verification.

## Non-goals / guardrails

- No new colors — `ds-*` tokens only.
- No backend, API, routing, schema, or business-logic edits.
- No renaming of public props that would break existing call sites in Phase 1.
