# Global Design System — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the standardized visual foundation — rebrand orange→blue, add card/modal radii, Geist typography, a 2-mode theme toggle, the canonical `GlobalPopoutModal`, and `App*` component aliases — so every later per-module rollout rides on it. Strictly visual: no logic/workflow/routing/schema changes.

**Architecture:** The app already drives nearly all color/accent through CSS variables (`--brand-primary`, `--ds-accent-*`) and a `ds-*` Tailwind palette, so the brand swap is achieved mostly by editing two files (`design-tokens.css` + `accent-theme.ts`) and components inherit it. `SlideOverPanel` is the single engine behind every shared drawer (`StandardDrawer`, `Drawer`, `IndustrialSheet`), so re-pointing it at a new Radix-based `GlobalPopoutModal` converts all shared drawers to centered modals at once. Canonical components stay; `App*` names are thin re-exports.

**Tech Stack:** Next.js 14 App Router, Tailwind CSS, CSS variables, `next-themes`, `@radix-ui/react-dialog`, `geist` font, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-05-22-global-design-system-foundation-design.md`

**Commit note:** The worktree's husky `pre-commit` runs `npx lint-staged`, but the worktree `package.json` is missing the `lint-staged` config (the main branch has it), so the hook fails for every commit here. Per stakeholder decision, commits in this plan use `git commit --no-verify`. Code quality is still enforced by the explicit `npm run lint` + `npm run typecheck` steps in Task 10.

**Brand reference values (use exactly):**
- Blue primary `#2563EB` → RGB `37 99 235`; hover `#1D4ED8` → RGB `29 78 216`; dark-mode primary `#3B82F6` → RGB `59 130 246`.
- Primary HSL (for shadcn `--primary`/`--ring`): `217 91% 60%`.
- Orange hexes being removed: `#f5820d`, `#d9700b`, `#F97316`, `#EA580C` (and rgba `245, 130, 13` / `249, 115, 22`).

---

## Task 1: Rebrand tokens orange → blue

**Files:**
- Modify: `src/styles/design-tokens.css`

- [ ] **Step 1: Edit the semantic brand vars (`:root`)**

Replace lines 16-19:
```css
  --brand-primary: #2563EB;
  --brand-primary-hover: #1D4ED8;
  --brand-bg-soft: rgba(37, 99, 235, 0.12);
  --brand-bg-strong: rgba(37, 99, 235, 0.2);
```

- [ ] **Step 2: Edit the `ds-accent` / `ds-kpi` RGB mirrors (`:root`)**

Replace the `--ds-kpi-rgb` (line 71), `--ds-accent-rgb` (line 74), and `--ds-accent-hover-rgb` (line 76) values:
```css
  --ds-kpi-rgb: 37 99 235;
```
```css
  --ds-accent-rgb: 37 99 235;
```
```css
  --ds-accent-hover-rgb: 29 78 216;
```
(Leave the `--ds-kpi`, `--ds-accent`, `--ds-accent-hover` `var(--brand-primary…)` references as-is — they now resolve to blue.)

- [ ] **Step 3: Add a dark-mode primary-blue override**

Inside the `.dark { … }` block (after line 125, before the closing `}`), add:
```css
  --brand-primary: #3B82F6;
  --brand-primary-hover: #2563EB;
  --ds-accent-rgb: 59 130 246;
  --ds-accent-hover-rgb: 37 99 235;
  --ds-kpi-rgb: 59 130 246;
```

- [ ] **Step 4: Verify no orange brand hexes remain in this file**

Run: `grep -niE "f5820d|d9700b|F97316|EA580C|245, 130, 13|249, 115, 22" src/styles/design-tokens.css`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/styles/design-tokens.css
git commit --no-verify -m "feat(ds): rebrand design tokens orange to blue"
```

---

## Task 2: Remove the runtime orange override

**Files:**
- Modify: `src/lib/accent-theme.ts`

- [ ] **Step 1: Replace the BRAND constant (lines 3-12) with blue**

```ts
/** All presets map to the same brand blue — accent switcher is retained without fragmenting the palette. */
const BRAND = {
  accent: '#2563EB',
  accentHover: '#1D4ED8',
  accentRgb: '37 99 235',
  accentHoverRgb: '29 78 216',
  /** HSL for shadcn `primary` / `ring` */
  primaryHsl: '217 91% 60%',
  ringHsl: '217 91% 60%',
} as const
```

(Leave `applyAccentPreset`, `getStoredAccentPreset`, `applyHighContrast`, `getStoredHighContrast` unchanged — signatures and storage keys stay; they now apply blue.)

- [ ] **Step 2: Verify no orange hexes remain**

Run: `grep -niE "F97316|EA580C|249, 115, 22|24 95%" src/lib/accent-theme.ts`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/lib/accent-theme.ts
git commit --no-verify -m "fix(ds): point runtime accent override at brand blue"
```

---

## Task 3: Add card/modal radii and recolor focus shadow

**Files:**
- Modify: `tailwind.config.ts`

- [ ] **Step 1: Add `ds-card` and `ds-modal` radii**

In `borderRadius` (lines 18-25), after the `'ds-lg': '12px',` line, add:
```ts
        'ds-card': '16px',
        'ds-modal': '18px',
```

- [ ] **Step 2: Recolor the focus shadow from orange to blue**

Replace the `'ds-focus'` line (line 32):
```ts
        'ds-focus': '0 0 0 3px rgba(37, 99, 235, 0.2)',
```

- [ ] **Step 3: Add centered-modal animation keyframes + animation**

In `keyframes` (after the `'ds-drawer-slide'` block, before the closing `}` of `keyframes` at line 52), add:
```ts
        'modal-in': {
          from: { opacity: '0', transform: 'scale(0.98)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'modal-out': {
          from: { opacity: '1', transform: 'scale(1)' },
          to: { opacity: '0', transform: 'scale(0.98)' },
        },
        'overlay-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'overlay-out': { from: { opacity: '1' }, to: { opacity: '0' } },
```

In `animation` (after the `'ds-drawer-slide'` line, before the closing `}` at line 58), add:
```ts
        'modal-in': 'modal-in 180ms ease-out both',
        'modal-out': 'modal-out 180ms ease-out both',
        'overlay-in': 'overlay-in 180ms ease-out both',
        'overlay-out': 'overlay-out 180ms ease-out both',
```

- [ ] **Step 4: Verify the config still parses**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i tailwind.config || echo "config ok"`
Expected: `config ok` (no type errors referencing tailwind.config.ts).

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.ts
git commit --no-verify -m "feat(ds): add card/modal radii, blue focus ring, modal keyframes"
```

---

## Task 4: Apply spec radii to Button and CardSection

**Files:**
- Modify: `src/components/design-system/Button.tsx:43`
- Modify: `src/components/design-system/CardSection.tsx:18`

- [ ] **Step 1: Buttons → 12px radius (`ds-lg`)**

In `Button.tsx` line 43, change `rounded-ds-sm` to `rounded-ds-lg` in the base class string:
```ts
        'inline-flex items-center justify-center gap-2 rounded-ds-lg px-4 py-2 text-sm font-medium transition-[box-shadow,background-color,border-color,filter] duration-200 ease-out',
```
(Leave the `icon` variant's `rounded-ds-sm` at line 25 unchanged — square icon buttons stay tight.)

- [ ] **Step 2: Cards → 16px radius (`ds-card`)**

In `CardSection.tsx` line 18, change `rounded-ds-md` to `rounded-ds-card`:
```ts
        'space-y-4 rounded-ds-card border border-[var(--border)] bg-[var(--bg-card)] p-4 md:p-5 shadow-ds-depth-sm transition-[border-color,box-shadow] duration-200 ease-out',
```

- [ ] **Step 3: Verify guardrail still passes (these are DS radii, not raw)**

Run: `bash scripts/check-theme-tokens.sh`
Expected: `✓ Theme tokens clean — no raw color shades, no non-DS radii.`

- [ ] **Step 4: Commit**

```bash
git add src/components/design-system/Button.tsx src/components/design-system/CardSection.tsx
git commit --no-verify -m "feat(ds): apply spec button (12px) and card (16px) radii"
```

---

## Task 5: Load Geist typography

**Files:**
- Modify: `package.json` (add `geist` dep)
- Modify: `src/app/layout.tsx`
- Modify: `tailwind.config.ts:12-17`
- Modify: `src/styles/design-tokens.css:9-13`

- [ ] **Step 1: Install the Geist font package**

Run: `npm install geist`
Expected: `geist` added to dependencies, no errors.

- [ ] **Step 2: Replace font loading in `layout.tsx`**

Replace lines 1-19 (the imports + `jakarta`/`plexMono` font setup) with:
```ts
import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { Providers } from '@/components/providers'
import { AppToaster } from '@/components/theme/AppToaster'
import './globals.css'
```

Then update the `<body>` className (line 33-35) to use the Geist variables:
```tsx
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} bg-ds-main font-sans text-sm text-ds-ink antialiased`}
      >
```

- [ ] **Step 3: Point Tailwind `font-sans` (and mono families) at Geist**

In `tailwind.config.ts` `fontFamily` (lines 12-17), replace with:
```ts
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        'po-dashboard': ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        'director-cc': ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        'designing-queue': ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
```
(This repoints the 3 previously-orphaned mono families to a real loaded font instead of system fallback.)

- [ ] **Step 4: Update font CSS vars in `design-tokens.css`**

Replace lines 9-13:
```css
  --font-heading: var(--font-geist-sans), 'Inter', system-ui, sans-serif;
  --font-body: var(--font-geist-sans), 'Inter', system-ui, sans-serif;
  --font-label: var(--font-geist-sans), 'Inter', system-ui, sans-serif;
  --font-small: var(--font-geist-sans), 'Inter', system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, 'SF Mono', monospace;
```

- [ ] **Step 5: Verify no stale font references remain**

Run: `grep -rniE "font-jakarta|font-plex-mono|font-po-predictive|Plus_Jakarta_Sans|IBM_Plex_Mono" src/ tailwind.config.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/app/layout.tsx tailwind.config.ts src/styles/design-tokens.css
git commit --no-verify -m "feat(ds): load Geist as the global sans/mono typeface"
```

---

## Task 6: Collapse theme toggle to 2 modes (Light/Dark)

**Files:**
- Modify: `src/components/theme/ThemeToggle.tsx`
- Modify: `src/components/providers.tsx:22`

- [ ] **Step 1: Disable system theme in the provider**

In `providers.tsx` line 22, replace the `ThemeProvider` opening tag:
```tsx
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
```
(Removes `disableTransitionOnChange` so the 200ms color transition from Step 3 plays on toggle.)

- [ ] **Step 2: Rewrite `ThemeToggle.tsx` as a 2-mode toggle**

Replace the entire file with:
```tsx
'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

/** Light | Dark — two modes only, persisted by next-themes (localStorage). */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const active = mounted ? (theme === 'dark' || resolvedTheme === 'dark' ? 'dark' : 'light') : 'light'

  const btn =
    'inline-flex items-center gap-1 rounded-ds-sm px-2 py-1 text-xs font-medium transition-colors'
  const on = 'bg-[var(--brand-primary)] text-white'
  const off = 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-ds-md border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5"
      role="group"
      aria-label="Theme"
    >
      <button
        type="button"
        aria-pressed={active === 'light'}
        className={`${btn} ${active === 'light' ? on : off}`}
        onClick={() => setTheme('light')}
      >
        <Sun className="h-3.5 w-3.5" aria-hidden /> Light
      </button>
      <button
        type="button"
        aria-pressed={active === 'dark'}
        className={`${btn} ${active === 'dark' ? on : off}`}
        onClick={() => setTheme('dark')}
      >
        <Moon className="h-3.5 w-3.5" aria-hidden /> Dark
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Add a measured theme-color transition in globals**

In `src/app/globals.css`, inside the `@layer base { … }` block (add it if a `body` base rule exists; otherwise append a new `@layer base` block at the end of the file), add:
```css
@layer base {
  body,
  body * {
    transition: background-color 200ms ease, border-color 200ms ease, color 200ms ease;
  }
}
```

- [ ] **Step 4: Verify no `system` references remain in the toggle**

Run: `grep -ni "system" src/components/theme/ThemeToggle.tsx`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/components/theme/ThemeToggle.tsx src/components/providers.tsx src/app/globals.css
git commit --no-verify -m "feat(ds): 2-mode light/dark theme toggle with 200ms transition"
```

---

## Task 7: Build `GlobalPopoutModal`

**Files:**
- Create: `src/components/design-system/GlobalPopoutModal.tsx`
- Create: `src/components/design-system/GlobalPopoutModal.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/design-system/GlobalPopoutModal.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { GlobalPopoutModal } from './GlobalPopoutModal'

describe('GlobalPopoutModal', () => {
  it('renders title and children when open', () => {
    render(
      <GlobalPopoutModal isOpen onClose={() => {}} title="PO Detail" size="xl">
        <p>Body content</p>
      </GlobalPopoutModal>,
    )
    expect(screen.getByText('PO Detail')).toBeInTheDocument()
    expect(screen.getByText('Body content')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders nothing when closed', () => {
    render(
      <GlobalPopoutModal isOpen={false} onClose={() => {}} title="Hidden">
        <p>Body content</p>
      </GlobalPopoutModal>,
    )
    expect(screen.queryByText('Body content')).not.toBeInTheDocument()
  })

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn()
    render(
      <GlobalPopoutModal isOpen onClose={onClose} title="Closable">
        <p>x</p>
      </GlobalPopoutModal>,
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('applies the size width class', () => {
    render(
      <GlobalPopoutModal isOpen onClose={() => {}} title="Sized" size="sm">
        <p>x</p>
      </GlobalPopoutModal>,
    )
    expect(screen.getByRole('dialog').className).toContain('max-w-[420px]')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/design-system/GlobalPopoutModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./GlobalPopoutModal"`.

- [ ] **Step 3: Implement `GlobalPopoutModal`**

Create `src/components/design-system/GlobalPopoutModal.tsx`:
```tsx
'use client'

import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

export type GlobalPopoutModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'fullscreen'

const SIZE_CLASS: Record<GlobalPopoutModalSize, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[640px]',
  lg: 'max-w-[900px]',
  xl: 'max-w-[1180px]',
  fullscreen: 'max-w-[95vw]',
}

export type GlobalPopoutModalProps = {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  /** Secondary line under the title */
  metadata?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: GlobalPopoutModalSize
  /** Escape hatch for legacy adapters that pass an explicit width class */
  widthClass?: string
  bodyClassName?: string
  panelClassName?: string
}

/**
 * Application-standard centered pop-out. Single source of truth for all detail views,
 * edit forms, approvals and workflow interactions. Built on Radix Dialog (focus trap,
 * scroll lock, ESC, focus restore are native). Sticky header + footer; body-only scroll.
 */
export function GlobalPopoutModal({
  isOpen,
  onClose,
  title,
  metadata,
  children,
  footer,
  size = 'md',
  widthClass,
  bodyClassName,
  panelClassName,
}: GlobalPopoutModalProps) {
  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[1100] bg-[rgba(0,0,0,0.45)] backdrop-blur-[2px]',
            'data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out',
          )}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[1101] flex max-h-[90vh] w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col',
            'overflow-hidden rounded-ds-modal border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-ds-drawer',
            'data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out',
            size === 'fullscreen' ? 'h-[95vh]' : '',
            widthClass ?? SIZE_CLASS[size],
            panelClassName,
          )}
        >
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-ds-line/25 bg-ds-elevated/60 px-4 py-3 md:px-6 md:pt-5 md:pb-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="ds-typo-heading min-w-0 pr-2">{title}</Dialog.Title>
              {metadata ? (
                <div className="mt-1.5 text-sm leading-snug text-ds-ink-muted">{metadata}</div>
              ) : null}
            </div>
            <Dialog.Close
              className="shrink-0 rounded-ds-sm p-1.5 text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-ink"
              aria-label="Close"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </header>

          <div className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 text-sm text-ds-ink md:px-6', bodyClassName)}>
            {children}
          </div>

          {footer ? (
            <footer className="shrink-0 border-t border-ds-line/30 bg-ds-elevated/60 px-4 py-3 pt-4 shadow-ds-drawer-foot md:px-6">
              {footer}
            </footer>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/design-system/GlobalPopoutModal.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/design-system/GlobalPopoutModal.tsx src/components/design-system/GlobalPopoutModal.test.tsx
git commit --no-verify -m "feat(ds): add centered GlobalPopoutModal component"
```

---

## Task 8: Convert shared drawers to centered modals

**Files:**
- Modify: `src/components/ui/SlideOverPanel.tsx`
- Create: `src/components/ui/SlideOverPanel.test.tsx`

**Why:** `StandardDrawer`, `Drawer`, and `IndustrialSheet` all render through `SlideOverPanel`. Re-implementing `SlideOverPanel` as an adapter over `GlobalPopoutModal` converts all three to centered modals while keeping their existing prop signatures (`title`, `headerMeta`, `footer`, `isOpen`, `onClose`, `widthClass`, `panelClassName`, `zIndexClass`, `animateEnter`).

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/SlideOverPanel.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SlideOverPanel } from './SlideOverPanel'

describe('SlideOverPanel (centered-modal adapter)', () => {
  it('renders title and children as a centered dialog', () => {
    render(
      <SlideOverPanel isOpen title="Drawer Title" onClose={() => {}}>
        <p>Drawer body</p>
      </SlideOverPanel>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Drawer Title')).toBeInTheDocument()
    expect(screen.getByText('Drawer body')).toBeInTheDocument()
    // centered, not a right-rail slide-in
    expect(dialog.className).toContain('-translate-x-1/2')
    expect(dialog.className).not.toContain('translate-x-full')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/ui/SlideOverPanel.test.tsx`
Expected: FAIL — current panel uses `translate-x-full` / `justify-end`, so `-translate-x-1/2` assertion fails.

- [ ] **Step 3: Re-implement `SlideOverPanel` as a `GlobalPopoutModal` adapter**

Replace the entire contents of `src/components/ui/SlideOverPanel.tsx` with:
```tsx
'use client'

import type { ReactNode } from 'react'
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
 * Shared-drawer adapter. Previously a right-rail slide-over; now renders the application-standard
 * centered {@link GlobalPopoutModal}. Prop signature is preserved so StandardDrawer / Drawer /
 * IndustrialSheet consumers are unchanged. `widthClass` maps to the modal's explicit width;
 * `backdropClassName` / `animateEnter` / `zIndexClass` are accepted for back-compat and ignored
 * (the modal owns backdrop, animation, and z-index).
 */
export function SlideOverPanel({
  title,
  headerMeta,
  isOpen,
  onClose,
  children,
  footer,
  widthClass,
  panelClassName,
}: SlideOverPanelProps) {
  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      metadata={headerMeta}
      footer={footer}
      size="xl"
      widthClass={widthClass}
      panelClassName={panelClassName}
    >
      {children}
    </GlobalPopoutModal>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/ui/SlideOverPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Re-run the existing drawer test to confirm no regression**

Run: `npx vitest run src/components/po/PoNewLineItemDrawer.test.tsx`
Expected: PASS (consumers still render via the adapter).

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/SlideOverPanel.tsx src/components/ui/SlideOverPanel.test.tsx
git commit --no-verify -m "feat(ds): route shared drawers through centered GlobalPopoutModal"
```

---

## Task 9: Export `App*` aliases and the modal

**Files:**
- Create: `src/components/design-system/Tabs.tsx`
- Modify: `src/components/design-system/index.ts`

**Why:** The program's vocabulary uses `App*` names. These are thin re-exports of the canonical components — no duplicate implementations. `AppSearch` maps to `InputField` (the canonical text input; search styling is applied via the `ds-toolbar-search` class at call sites). A minimal `Tabs` is created since none exists.

- [ ] **Step 1: Create a minimal `Tabs` component**

Create `src/components/design-system/Tabs.tsx`:
```tsx
'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type TabItem = { id: string; label: ReactNode }

type TabsProps = {
  tabs: TabItem[]
  activeId: string
  onChange: (id: string) => void
  className?: string
}

/** App-standard underline tab strip — token-driven, no raw colors. */
export function Tabs({ tabs, activeId, onChange, className }: TabsProps) {
  return (
    <div role="tablist" className={cn('flex items-center gap-1 border-b border-[var(--border)]', className)}>
      {tabs.map((t) => {
        const active = t.id === activeId
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-[var(--brand-primary)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Add the `App*` aliases + modal export to `index.ts`**

Append to `src/components/design-system/index.ts` (after line 48):
```ts
export { GlobalPopoutModal } from './GlobalPopoutModal'
export type { GlobalPopoutModalProps, GlobalPopoutModalSize } from './GlobalPopoutModal'
export { Tabs } from './Tabs'
export type { TabItem } from './Tabs'

/* —— Program vocabulary aliases (App*) — thin re-exports, no duplicate implementations —— */
export { Button as AppButton } from './Button'
export { CardSection as AppCard } from './CardSection'
export { DataTableFrame as AppTable } from './DataTable'
export { InputField as AppInput } from './InputField'
export { InputField as AppSearch } from './InputField'
export { Badge as AppBadge } from './Badge'
export { ActionBar as AppToolbar } from './ActionBar'
export { Tabs as AppTabs } from './Tabs'
```

- [ ] **Step 3: Verify the aliases type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/design-system/Tabs.tsx src/components/design-system/index.ts
git commit --no-verify -m "feat(ds): export GlobalPopoutModal, Tabs, and App* vocabulary aliases"
```

---

## Task 10: Full verification + app-shell visual pass

**Files:** none (verification only; fixes go back to the relevant task's files)

- [ ] **Step 1: Type-check the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint (eslint, since the pre-commit hook is bypassed)**

Run: `npm run lint`
Expected: no new errors in the files touched by this plan.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the two new modal/drawer tests.

- [ ] **Step 4: Theme-token guardrail**

Run: `bash scripts/check-theme-tokens.sh`
Expected: `✓ Theme tokens clean`.

- [ ] **Step 5: Confirm no residual orange brand color anywhere in foundation files**

Run: `grep -rniE "f5820d|d9700b|F97316|EA580C|245, 130, 13|249, 115, 22|24 95%" src/styles/design-tokens.css src/lib/accent-theme.ts tailwind.config.ts`
Expected: no output.

- [ ] **Step 6: Dev-server visual pass**

Run: `npm run dev` (port 3000). Using the browser preview tools, verify in BOTH light and dark:
- App shell top nav: theme toggle shows exactly **Light / Dark**, toggling persists across reload, transitions ~200ms with no flash; primary accents (active density button, focus rings) are **blue**.
- Login page renders, brand accents blue, Geist font active.
- Customer PO screen (`/orders/purchase-orders`): table, KPI tiles, badges, primary buttons all blue; open a PO detail (a shared-drawer consumer) and confirm it appears as a **centered modal** with sticky header/footer, body-only scroll, ESC closes, focus restores.
- Check the browser console for errors.

Capture a screenshot of the Customer PO screen in both themes as proof.

- [ ] **Step 7: Final foundation commit (if any visual-pass fixes were made)**

```bash
git add -A
git commit --no-verify -m "chore(ds): foundation visual-pass fixes"
```

---

## Self-review notes (author)

- **Spec coverage:** tokens/blue (T1-T2), radii+focus+keyframes (T3-T4), typography/Geist (T5), 2-mode toggle (T6), GlobalPopoutModal contract (T7), shared-drawer migration (T8), App* aliases + modal export (T9), verification incl. both themes + Customer PO (T10). Out-of-scope items (107 page bodies, module-specific drawers, pharma theme removal) are deferred per spec §2 and §8.
- **No placeholders:** every code step shows full code; every verification step has an exact command + expected output.
- **Type consistency:** `GlobalPopoutModal` props (`isOpen`, `onClose`, `title`, `metadata`, `footer`, `size`, `widthClass`, `panelClassName`, `bodyClassName`) are used identically by the `SlideOverPanel` adapter in T8 and exported in T9. `GeistSans.variable` (`--font-geist-sans`) / `GeistMono.variable` (`--font-geist-mono`) are referenced consistently in layout + tailwind + tokens.
- **Acceptance mapping:** spec §6 criteria 1-8 are each exercised by T10 steps 1-6 plus the per-task greps.
```
