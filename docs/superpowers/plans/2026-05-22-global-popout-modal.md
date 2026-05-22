# Global Pop-out Modal System — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right-side slide-over experience with a single centered pop-out modal by converting the shared `SlideOverPanel` primitive in place, so its ~25 consumers + `StandardDrawer` + the Customer PO pilot become centered modals with zero call-site edits.

**Architecture:** Build one canonical `GlobalPopoutModal` in `design-system/` (centered, dimmed+blurred backdrop, sticky header/footer, size variants, preview-vs-form close behavior, scroll lock, focus trap, `ds-*` tokens only). Rewrite `SlideOverPanel` into a thin `@deprecated` adapter that forwards to `GlobalPopoutModal` with `mode="preview"` (preserving today's close-on-backdrop+Esc behavior). `StandardDrawer` is untouched and rides the adapter. Delete the orphan `ui/Modal.tsx`. Verify the Customer PO detail in the browser.

**Tech Stack:** Next.js 14 (App Router), React 18, TypeScript, Tailwind 3 (`ds-*` design tokens), lucide-react, Vitest + @testing-library/react (jsdom), `cn` (clsx + tailwind-merge).

**Spec:** `docs/superpowers/specs/2026-05-22-global-popout-modal-design.md`

**Out of scope (later phases):** migrating the 8 roll-their-own bespoke drawers (5 planning, PoNewLineItem, JobCardHubAudit, ShadeCardSpotlight), removing dead slide-over CSS tokens, module-by-module rollout.

---

## File Structure

- **Create** `src/components/design-system/GlobalPopoutModal.tsx` — the canonical centered modal primitive.
- **Create** `src/components/design-system/GlobalPopoutModal.test.tsx` — behavior tests.
- **Modify** `src/components/ui/SlideOverPanel.tsx` — rewrite internals into a forwarding adapter (keep prop API identical).
- **Modify** `src/components/design-system/index.ts` — export `GlobalPopoutModal` + types.
- **Delete** `src/components/ui/Modal.tsx` — orphan centered modal (0 consumers).
- **Verify only** `src/app/(dashboard)/orders/purchase-orders/page.tsx` — Customer PO pilot (optional one-line `widthClass` tweak).
- **Untouched** `src/components/design-system/StandardDrawer.tsx` — still wraps `SlideOverPanel`; converts for free.

Note: `src/components/design-system/**` is exempt from `scripts/check-theme-tokens.sh`. `src/components/ui/SlideOverPanel.tsx` is NOT exempt — the adapter must add no raw color shades or `rounded-(md|lg|xl)` classes (it forwards props only, so this is automatically satisfied).

---

## Task 1: `GlobalPopoutModal` primitive (TDD)

**Files:**
- Create: `src/components/design-system/GlobalPopoutModal.tsx`
- Test: `src/components/design-system/GlobalPopoutModal.test.tsx`

- [ ] **Step 1: Write the failing test file**

Create `src/components/design-system/GlobalPopoutModal.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { GlobalPopoutModal } from './GlobalPopoutModal'

afterEach(() => {
  document.body.style.overflow = ''
})

function setup(props: Partial<React.ComponentProps<typeof GlobalPopoutModal>> = {}) {
  const onClose = vi.fn()
  render(
    <GlobalPopoutModal isOpen onClose={onClose} title="PO SGB/2627" {...props}>
      <p>Body content</p>
    </GlobalPopoutModal>,
  )
  return { onClose }
}

describe('GlobalPopoutModal', () => {
  it('renders title and children when open', () => {
    setup()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('PO SGB/2627')).toBeInTheDocument()
    expect(screen.getByText('Body content')).toBeInTheDocument()
  })

  it('renders nothing when closed', () => {
    const onClose = vi.fn()
    render(
      <GlobalPopoutModal isOpen={false} onClose={onClose} title="Hidden">
        <p>Body content</p>
      </GlobalPopoutModal>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders the optional metadata row', () => {
    setup({ metadata: <span>Acme · ₹1,20,000</span> })
    expect(screen.getByText('Acme · ₹1,20,000')).toBeInTheDocument()
  })

  it('close button (X) always closes', () => {
    const { onClose } = setup({ mode: 'form', hasUnsavedChanges: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preview mode: Escape closes', () => {
    const { onClose } = setup({ mode: 'preview' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preview mode: backdrop click closes', () => {
    const { onClose } = setup({ mode: 'preview' })
    fireEvent.click(screen.getByTestId('gpm-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('form mode: backdrop click does NOT close', () => {
    const { onClose } = setup({ mode: 'form' })
    fireEvent.click(screen.getByTestId('gpm-backdrop'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('form mode: Escape closes when there are no unsaved changes', () => {
    const { onClose } = setup({ mode: 'form', hasUnsavedChanges: false })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('form mode: Escape does NOT close when there are unsaved changes', () => {
    const { onClose } = setup({ mode: 'form', hasUnsavedChanges: true })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders primary and secondary actions and fires their handlers', () => {
    const onPrimary = vi.fn()
    const onSecondary = vi.fn()
    setup({
      primaryAction: { label: 'Save', onClick: onPrimary },
      secondaryAction: { label: 'Cancel', onClick: onSecondary },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(onSecondary).toHaveBeenCalledTimes(1)
  })

  it('locks body scroll while open', () => {
    setup()
    expect(document.body.style.overflow).toBe('hidden')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/design-system/GlobalPopoutModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./GlobalPopoutModal"` (module does not exist yet).

- [ ] **Step 3: Implement the component**

Create `src/components/design-system/GlobalPopoutModal.tsx`:

```tsx
'use client'

import { X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/design-system/Button'
import { cn } from '@/lib/cn'

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'fullscreen'

export type ModalAction = {
  label: string
  loadingLabel?: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
}

export type GlobalPopoutModalProps = {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  /** Secondary line under the title (customer · status · value · date · stage). */
  metadata?: ReactNode
  children: ReactNode
  size?: ModalSize
  /**
   * 'preview' = light read-only popups: backdrop-click AND Escape close.
   * 'form'    = editors/forms: backdrop-click never closes; Escape closes only
   *             when hasUnsavedChanges is false.
   */
  mode?: 'preview' | 'form'
  hasUnsavedChanges?: boolean
  primaryAction?: ModalAction
  secondaryAction?: ModalAction
  /** Replaces the built-in primary/secondary action row. */
  footer?: ReactNode
  bodyClassName?: string
  /** Width override (e.g. migrated SlideOverPanel widthClass). Wins over size. */
  widthClass?: string
  zIndexClass?: string
}

const SIZE_MAX_WIDTH: Record<ModalSize, string> = {
  sm: 'sm:max-w-[420px]',
  md: 'sm:max-w-[640px]',
  lg: 'sm:max-w-[900px]',
  xl: 'sm:max-w-[1180px]',
  fullscreen: 'sm:max-w-[95vw]',
}

export function GlobalPopoutModal({
  isOpen,
  onClose,
  title,
  metadata,
  children,
  size = 'md',
  mode = 'form',
  hasUnsavedChanges = false,
  primaryAction,
  secondaryAction,
  footer: footerOverride,
  bodyClassName,
  widthClass,
  zIndexClass = 'z-[1100]',
}: GlobalPopoutModalProps) {
  // mounted keeps the DOM alive after close so the 220ms exit animation can play.
  const [mounted, setMounted] = useState(isOpen)
  const [visible, setVisible] = useState(isOpen)
  const panelRef = useRef<HTMLDivElement>(null)
  const lastFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (isOpen) {
      setMounted(true)
      const raf = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(raf)
    }
    setVisible(false)
    const t = setTimeout(() => setMounted(false), 220)
    return () => clearTimeout(t)
  }, [isOpen])

  // Body scroll lock while open.
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isOpen])

  // Focus management: remember trigger, focus the panel on open, restore on close.
  useEffect(() => {
    if (isOpen) {
      lastFocused.current = document.activeElement as HTMLElement | null
      const raf = requestAnimationFrame(() => panelRef.current?.focus())
      return () => cancelAnimationFrame(raf)
    }
    lastFocused.current?.focus?.()
  }, [isOpen])

  // Escape handling honoring mode + unsaved changes.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (mode === 'form' && hasUnsavedChanges) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, mode, hasUnsavedChanges, onClose])

  // Focus trap: keep Tab/Shift+Tab within the panel.
  function handleTrapKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return
    const root = panelRef.current
    if (!root) return
    const focusables = root.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (!mounted) return null

  const handleBackdropClick = () => {
    if (mode === 'preview') onClose()
  }

  const builtInFooter =
    primaryAction || secondaryAction ? (
      <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
        {secondaryAction ? (
          <Button
            type="button"
            variant="secondary"
            className="min-h-[40px] min-w-[6rem] flex-1 sm:flex-initial"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        {primaryAction ? (
          <Button
            type="button"
            className="min-h-[40px] min-w-[6rem] flex-1 sm:flex-initial"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled || primaryAction.loading}
          >
            {primaryAction.loading ? (primaryAction.loadingLabel ?? '…') : primaryAction.label}
          </Button>
        ) : null}
      </div>
    ) : null

  const footer = footerOverride ?? builtInFooter

  return (
    <div
      className={cn(
        'fixed inset-0 flex items-end justify-center sm:items-center sm:p-4',
        zIndexClass,
      )}
      role="presentation"
      aria-hidden={!isOpen}
    >
      {/* Backdrop — dimmed + blurred, fades in/out. Decorative; X button is the a11y close. */}
      <div
        data-testid="gpm-backdrop"
        aria-hidden="true"
        onClick={handleBackdropClick}
        className={cn(
          'absolute inset-0 bg-ds-main/60 backdrop-blur-sm transition-opacity duration-200',
          visible ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Panel — centered, scales + fades in/out. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={handleTrapKeyDown}
        className={cn(
          'relative z-[1] flex w-full flex-col outline-none',
          'max-h-[100dvh] rounded-t-ds-lg sm:max-h-[88vh] sm:w-[90vw] sm:rounded-ds-lg',
          'bg-ds-card text-ds-ink shadow-ds-drawer',
          'transition-all duration-200 ease-out',
          visible
            ? 'translate-y-0 opacity-100 sm:scale-100'
            : 'translate-y-4 opacity-0 sm:translate-y-0 sm:scale-95',
          SIZE_MAX_WIDTH[size],
          widthClass,
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-ds-line/25 bg-ds-elevated/60 px-4 py-3 md:px-6 md:pb-4 md:pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="ds-typo-heading min-w-0 pr-2">{title}</h2>
            {metadata ? (
              <div className="mt-1.5 text-sm leading-snug text-ds-ink-muted">{metadata}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-ds-sm p-1.5 text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div
          className={cn(
            'min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 text-sm text-ds-ink md:px-6',
            bodyClassName,
          )}
        >
          {children}
        </div>

        {footer ? (
          <footer className="shadow-ds-drawer-foot shrink-0 border-t border-ds-line/30 bg-ds-elevated/60 px-4 py-3 md:px-6 md:pt-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/design-system/GlobalPopoutModal.test.tsx`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/design-system/GlobalPopoutModal.tsx src/components/design-system/GlobalPopoutModal.test.tsx
git commit -m "feat(ui): add GlobalPopoutModal centered modal primitive"
```

---

## Task 2: Rewrite `SlideOverPanel` into a forwarding adapter (TDD)

Repoint the shared primitive so all ~25 consumers + `StandardDrawer` render as centered modals, preserving today's close-on-backdrop+Escape behavior via `mode="preview"`.

**Files:**
- Modify: `src/components/ui/SlideOverPanel.tsx` (full rewrite of internals; prop API unchanged)
- Test: `src/components/ui/SlideOverPanel.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/SlideOverPanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SlideOverPanel } from './SlideOverPanel'

afterEach(() => {
  document.body.style.overflow = ''
})

describe('SlideOverPanel (modal adapter)', () => {
  it('renders as a centered dialog with title, headerMeta and children', () => {
    render(
      <SlideOverPanel isOpen onClose={vi.fn()} title="PO 123" headerMeta={<span>Acme</span>}>
        <p>Lines</p>
      </SlideOverPanel>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('PO 123')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('Lines')).toBeInTheDocument()
  })

  it('preserves legacy behavior: backdrop click closes (preview mode)', () => {
    const onClose = vi.fn()
    render(
      <SlideOverPanel isOpen onClose={onClose} title="PO 123">
        <p>Lines</p>
      </SlideOverPanel>,
    )
    fireEvent.click(screen.getByTestId('gpm-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preserves legacy behavior: Escape closes', () => {
    const onClose = vi.fn()
    render(
      <SlideOverPanel isOpen onClose={onClose} title="PO 123">
        <p>Lines</p>
      </SlideOverPanel>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders an optional footer', () => {
    render(
      <SlideOverPanel isOpen onClose={vi.fn()} title="PO 123" footer={<button>Do it</button>}>
        <p>Lines</p>
      </SlideOverPanel>,
    )
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/ui/SlideOverPanel.test.tsx`
Expected: FAIL — `getByTestId('gpm-backdrop')` not found (current SlideOverPanel renders a slide-over with a `<button aria-label="Close">` backdrop and no `gpm-backdrop` test id), and `getByRole('dialog')` may resolve but the backdrop assertion fails.

- [ ] **Step 3: Rewrite the adapter**

Replace the entire contents of `src/components/ui/SlideOverPanel.tsx` with:

```tsx
'use client'

import { type ReactNode } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'

export type StandardSlideOverOptions = {
  widthClass?: string
  backdropClassName?: string
  panelClassName?: string
  animateEnter?: boolean
}

type SlideOverPanelProps = StandardSlideOverOptions & {
  title: ReactNode
  headerMeta?: ReactNode
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  zIndexClass?: string
}

/**
 * @deprecated Use {@link GlobalPopoutModal} directly for new code.
 *
 * Retained as a thin adapter so existing call sites keep working unchanged while
 * modules migrate. It now renders a centered pop-out modal (no longer a right-rail
 * slide-over) and forwards `mode="preview"` to preserve the historical behavior:
 * the panel closes on BOTH backdrop-click and Escape.
 *
 * The legacy presentation props `backdropClassName`, `panelClassName`, and
 * `animateEnter` are accepted for source compatibility but no longer affect
 * rendering — the modal owns its own backdrop, surface, and animation.
 */
export function SlideOverPanel({
  title,
  headerMeta,
  isOpen,
  onClose,
  children,
  footer,
  widthClass,
  zIndexClass,
}: SlideOverPanelProps) {
  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      metadata={headerMeta}
      footer={footer}
      widthClass={widthClass}
      zIndexClass={zIndexClass}
      mode="preview"
    >
      {children}
    </GlobalPopoutModal>
  )
}
```

- [ ] **Step 4: Run the new test + the full suite + typecheck**

Run: `npx vitest run src/components/ui/SlideOverPanel.test.tsx`
Expected: PASS — 4 tests green.

Run: `npx tsc --noEmit`
Expected: no errors. (Consumers pass `backdropClassName`/`panelClassName`/`animateEnter` — still in the type, so they typecheck.)

Run: `npx vitest run`
Expected: PASS — full suite green (StandardDrawer's 2 consumers and all SlideOverPanel consumers compile and render).

- [ ] **Step 5: Verify no slide-over CSS remains**

Run: `grep -n "translate-x\|justify-end\|DRAWER_RAIL" src/components/ui/SlideOverPanel.tsx`
Expected: no matches (the rail/slide styling is gone).

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/SlideOverPanel.tsx src/components/ui/SlideOverPanel.test.tsx
git commit -m "refactor(ui): render SlideOverPanel as a centered modal via GlobalPopoutModal"
```

---

## Task 3: Export `GlobalPopoutModal` from the design-system barrel

**Files:**
- Modify: `src/components/design-system/index.ts`

- [ ] **Step 1: Add the exports**

In `src/components/design-system/index.ts`, directly after the existing line:

```ts
export { StandardDrawer } from './StandardDrawer'
export type { StandardDrawerAction } from './StandardDrawer'
```

add:

```ts
export { GlobalPopoutModal } from './GlobalPopoutModal'
export type { GlobalPopoutModalProps, ModalSize, ModalAction } from './GlobalPopoutModal'
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/design-system/index.ts
git commit -m "feat(ui): export GlobalPopoutModal from design-system barrel"
```

---

## Task 4: Delete the orphan `ui/Modal.tsx`

**Files:**
- Delete: `src/components/ui/Modal.tsx`

- [ ] **Step 1: Confirm there are zero consumers**

Run: `grep -rn "components/ui/Modal'" src --include="*.tsx" --include="*.ts" | grep -v "ui/Modal.tsx"`
Expected: no output.

Also run: `grep -rn "from './Modal'" src/components/ui --include="*.tsx" --include="*.ts" | grep -v "Modal.tsx"`
Expected: no output (e.g. `ConfirmDialog.tsx` does not import it).

If either prints anything, STOP — do not delete; report the consumer instead.

- [ ] **Step 2: Delete the file**

Run: `git rm src/components/ui/Modal.tsx`

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no errors; full suite green.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(ui): remove orphan Modal component (0 consumers, superseded by GlobalPopoutModal)"
```

---

## Task 5: Customer PO pilot — browser verification

The Customer PO detail (`src/app/(dashboard)/orders/purchase-orders/page.tsx`, the `<SlideOverPanel>` block ~line 1346) needs no code change beyond the primitive swap. Verify it renders as a clean centered modal, then optionally widen it.

**Files:**
- Verify only (optional one-line tweak): `src/app/(dashboard)/orders/purchase-orders/page.tsx`

- [ ] **Step 1: Start the dev server**

Use the preview tooling: `preview_start` (runs the Next.js dev server). If a server is already running, reuse it.

- [ ] **Step 2: Open the Customer PO list and trigger the detail**

Navigate the preview to the purchase-orders route (`/orders/purchase-orders`). Click a PO row (rows call `setDrawerPoId(po.id)` — same trigger as before). Use `preview_snapshot` to confirm the detail opened.

- [ ] **Step 3: Verify the modal against the checklist**

Confirm (via `preview_snapshot`, `preview_screenshot`, `preview_console_logs`, `preview_network`):
- Detail opens **centered**, not as a right rail.
- Background is **dimmed + blurred**; the page behind does **not scroll** while open.
- Header shows `PO {poNumber}`; the top-right **X** is visible.
- Body sections render with no dead space: PO summary (customer + value), tooling readiness bar (green/yellow/red), line-item list (`PoDrawerSpotlightLines`), PO status `<select>`, and the "Open full-page editor (advanced)" link.
- Line-item list scrolls **inside** the modal when long (it has its own `max-h-[40vh]`); the modal itself caps at `88vh`.
- Changing the PO status `<select>` still fires `handleStatusChange` (watch `preview_network` for the status PATCH/POST; **business logic unchanged**).
- Pressing **Escape** closes; clicking the **backdrop** closes (preview mode — matches today's behavior).
- No console errors in `preview_console_logs`.

- [ ] **Step 4: (Optional) Widen the pilot modal if it feels narrow**

The adapter defaults to `size="md"` (640px). If the PO detail needs more room, pass a width override on the existing `<SlideOverPanel>` (it forwards `widthClass` to the modal). Edit the opening tag at ~line 1346:

```tsx
      <SlideOverPanel
        title={drawerPo ? `PO ${drawerPo.poNumber}` : 'Purchase order'}
        isOpen={Boolean(drawerPoId)}
        onClose={() => setDrawerPoId(null)}
        widthClass="sm:max-w-[900px]"
      >
```

(Remove the now-ignored `backdropClassName`/`panelClassName` props while here, since the adapter no longer uses them.) Re-check in the browser. Skip this step if `md` already looks right.

- [ ] **Step 5: Commit (only if Step 4 changed code)**

```bash
git add "src/app/(dashboard)/orders/purchase-orders/page.tsx"
git commit -m "feat(orders): widen Customer PO detail pilot modal to lg"
```

If no code changed, skip the commit and record the verification result in your task summary.

---

## Task 6: Final green check

- [ ] **Step 1: Full suite + typecheck + token guardrail**

Run: `npx vitest run && npx tsc --noEmit && bash scripts/check-theme-tokens.sh`
Expected: tests green, no type errors, "✓ Theme tokens clean".

- [ ] **Step 2: Lint the changed files**

Run: `npx next lint --file src/components/design-system/GlobalPopoutModal.tsx --file src/components/ui/SlideOverPanel.tsx`
Expected: no errors (no unused vars from the adapter's dropped props).

- [ ] **Step 3: Summarize**

Report: primitive built + tested, SlideOverPanel/StandardDrawer + ~25 consumers auto-converted, orphan Modal removed, Customer PO pilot verified in browser. Note that Phase 2 (8 roll-their-own drawers + dead-CSS cleanup + module rollout) remains.

---

## Self-Review Notes

- **Spec coverage:** sizes (Task 1 `SIZE_MAX_WIDTH`), preview/form + unsaved Escape + backdrop rules (Task 1 tests + impl), scroll lock (Task 1), focus trap + restore + aria (Task 1), sticky header/footer + metadata + actions (Task 1), responsive mobile-fullscreen/rounded-top + tablet 90vw (Task 1 classes), `SlideOverPanel` adapter preserving legacy behavior (Task 2), `StandardDrawer` free conversion (Task 2 suite), barrel export (Task 3), orphan removal (Task 4), Customer PO pilot verification (Task 5), guardrail/typecheck/lint (Task 6).
- **Tokens:** only `ds-*` classes used; `design-system/` is guardrail-exempt and the `ui/` adapter forwards props only (no raw shades / `rounded-(md|lg|xl)`).
- **Type consistency:** `ModalAction`, `ModalSize`, `GlobalPopoutModalProps` defined in Task 1 and exported in Task 3; `mode`/`hasUnsavedChanges` names consistent across impl, tests, and adapter; backdrop `data-testid="gpm-backdrop"` consistent across Task 1 and Task 2 tests.
