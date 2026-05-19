# PO Drawer Spec-Pack Autopopulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During PO creation, autopopulate the line-item drawer's editable fields from a per-field merge of the carton's canonical spec pack over carton-master fallback, with provenance badges and a read-only spec block.

**Architecture:** A new `GET /api/cartons/[id]/spec-pack` endpoint returns the canonical `SpecPackV1` from `buildCartonSpecPack`. A new pure module `src/lib/po-line-specpack.ts` holds all merge/seed/override logic (unit-tested in isolation). The new-PO page fetches+caches the pack per carton id and uses the pure module to seed fields and record provenance. The presentational drawer renders provenance badges and a read-only spec block reusing `SpecPackPanel`.

**Tech Stack:** Next.js App Router, React, TypeScript, Prisma, Vitest, @testing-library/react.

---

## File Structure

- Create: `src/app/api/cartons/[id]/spec-pack/route.ts` — endpoint returning canonical pack.
- Create: `src/lib/po-line-specpack.ts` — pure seeding/merge/override + provenance logic.
- Create: `src/lib/po-line-specpack.test.ts` — unit tests for the pure module.
- Create: `src/app/api/cartons/[id]/spec-pack/route.test.ts` — endpoint auth/shape/404 tests.
- Modify: `src/app/(dashboard)/orders/purchase-orders/new/page.tsx` — extend `Line` type + `defaultLine`, fetch/cache, seed-on-resolve, override write-back.
- Modify: `src/components/po/PoNewLineItemDrawer.tsx` — provenance badges + read-only spec block.
- Modify: `src/components/po/PoNewLineItemDrawer` (no new test file required; add) `src/components/po/PoNewLineItemDrawer.test.tsx` — badge + read-only block render.
- Reuse (no change): `src/lib/carton-spec-pack.ts`, `src/components/spec-pack/SpecPackPanel.tsx`.

---

## Task 1: Pure spec-pack line seeding module

**Files:**
- Create: `src/lib/po-line-specpack.ts`
- Test: `src/lib/po-line-specpack.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/po-line-specpack.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildCartonSpecPack, type CartonForPack } from './carton-spec-pack'
import {
  seedLineFromSpecPack,
  applySpecOverrideEdit,
  EDITABLE_SPEC_FIELDS,
  type SpecSeedLine,
} from './po-line-specpack'

const carton: CartonForPack = {
  id: 'c1',
  cartonName: 'ACEBROBID',
  boardGrade: 'SBS (Solid Bleached Sulphate)',
  gsm: 350,
  paperType: 'Ivory',
  coatingType: 'Full UV Coating',
  embossingLeafing: 'Embossing',
  foilType: null,
  pastingStyle: 'BSO',
  backPrint: 'No',
  artworkCode: 'AW-001',
}

const pack = buildCartonSpecPack(carton)

function baseLine(over: Partial<SpecSeedLine> = {}): SpecSeedLine {
  return {
    boardGrade: '', gsm: '', paperType: '', coatingType: '',
    embossingLeafing: '', foilType: '', pastingStyle: '',
    backPrint: 'No', artworkCode: '',
    specOverrides: null, specProvenance: {},
    ...over,
  }
}

describe('EDITABLE_SPEC_FIELDS', () => {
  it('covers exactly the 9 editable fields', () => {
    expect(Object.keys(EDITABLE_SPEC_FIELDS).sort()).toEqual(
      ['artworkCode','backPrint','boardGrade','coatingType','embossingLeafing','foilType','gsm','pastingStyle','paperType'].sort(),
    )
  })
})

describe('seedLineFromSpecPack', () => {
  it('fills empty fields from a non-null spec leaf and tags provenance "spec"', () => {
    const { patch, provenance } = seedLineFromSpecPack(baseLine(), pack, null)
    expect(patch.boardGrade).toBe('SBS (Solid Bleached Sulphate)')
    expect(patch.gsm).toBe('350')
    expect(patch.paperType).toBe('Ivory')
    expect(provenance.boardGrade).toBe('spec')
    expect(provenance.gsm).toBe('spec')
  })

  it('leaves a null spec leaf for master fallback and tags "master"', () => {
    const { patch, provenance } = seedLineFromSpecPack(
      baseLine({ foilType: 'Gold Foil' }), pack, null,
    )
    expect(patch.foilType).toBeUndefined()
    expect(provenance.foilType).toBe('master')
  })

  it('never overwrites a user-edited field', () => {
    const { patch } = seedLineFromSpecPack(
      baseLine({ boardGrade: 'FBB', specProvenance: { boardGrade: 'user' } }),
      pack, null,
    )
    expect(patch.boardGrade).toBeUndefined()
  })

  it('resolves an override leaf as "override"', () => {
    const ov = { specPack: { board: { boardGrade: 'FBB (Folding Box Board)' } } }
    const { patch, provenance } = seedLineFromSpecPack(baseLine(), pack, ov)
    expect(patch.boardGrade).toBe('FBB (Folding Box Board)')
    expect(provenance.boardGrade).toBe('override')
  })
})

describe('applySpecOverrideEdit', () => {
  it('writes the edit into specOverrides.specPack at the mapped path and tags "user"', () => {
    const r = applySpecOverrideEdit(baseLine(), 'paperType', 'Kraft')
    expect(r.specOverrides).toEqual({ specPack: { board: { paperType: 'Kraft' } } })
    expect(r.specProvenance.paperType).toBe('user')
  })

  it('merges into an existing override object without dropping other paths', () => {
    const start = baseLine({ specOverrides: { specPack: { board: { gsm: 300 } } } })
    const r = applySpecOverrideEdit(start, 'coatingType', 'Matt Lamination')
    expect(r.specOverrides).toEqual({
      specPack: { board: { gsm: 300 }, finishing: { coatingType: 'Matt Lamination' } },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/po-line-specpack.test.ts`
Expected: FAIL — `Cannot find module './po-line-specpack'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/po-line-specpack.ts`:

```typescript
import { readCartonSpecPack, type SpecPackV1 } from '@/lib/carton-spec-pack'

export type SpecProvenance = 'spec' | 'master' | 'override' | 'user'

export type EditableSpecField =
  | 'boardGrade' | 'gsm' | 'paperType'
  | 'coatingType' | 'embossingLeafing' | 'foilType'
  | 'pastingStyle' | 'backPrint' | 'artworkCode'

/** Editable line field -> [spec-pack group, leaf key]. */
export const EDITABLE_SPEC_FIELDS: Record<
  EditableSpecField,
  readonly [keyof SpecPackV1, string]
> = {
  boardGrade: ['board', 'boardGrade'],
  gsm: ['board', 'gsm'],
  paperType: ['board', 'paperType'],
  coatingType: ['finishing', 'coatingType'],
  embossingLeafing: ['finishing', 'embossingLeafing'],
  foilType: ['finishing', 'foilType'],
  pastingStyle: ['tooling', 'pastingStyle'],
  backPrint: ['print', 'backPrint'],
  artworkCode: ['print', 'artworkCode'],
}

export type SpecOverrides = { specPack?: Record<string, Record<string, unknown>> } | null

export interface SpecSeedLine {
  boardGrade: string
  gsm: string
  paperType: string
  coatingType: string
  embossingLeafing: string
  foilType: string
  pastingStyle: string
  backPrint: string
  artworkCode: string
  specOverrides: SpecOverrides
  specProvenance: Partial<Record<EditableSpecField, SpecProvenance>>
}

function leaf(pack: SpecPackV1, field: EditableSpecField): unknown {
  const [group, key] = EDITABLE_SPEC_FIELDS[field]
  const g = (pack as unknown as Record<string, Record<string, unknown>>)[group]
  return g ? g[key] : null
}

function overrideHasPath(ov: SpecOverrides, field: EditableSpecField): boolean {
  if (!ov?.specPack) return false
  const [group, key] = EDITABLE_SPEC_FIELDS[field]
  const g = ov.specPack[group]
  return !!g && Object.prototype.hasOwnProperty.call(g, key)
}

/**
 * Per-field seed of a line from the effective pack (base overlaid by
 * specOverrides). Returns only the fields to patch + their provenance.
 * Never overwrites a field whose current provenance is 'user'.
 */
export function seedLineFromSpecPack(
  line: SpecSeedLine,
  basePack: SpecPackV1,
  specOverrides: SpecOverrides,
): {
  patch: Partial<Record<EditableSpecField, string>>
  provenance: Partial<Record<EditableSpecField, SpecProvenance>>
} {
  const { pack } = readCartonSpecPack({ specPack: basePack, specOverrides })
  const patch: Partial<Record<EditableSpecField, string>> = {}
  const provenance: Partial<Record<EditableSpecField, SpecProvenance>> = {}

  for (const field of Object.keys(EDITABLE_SPEC_FIELDS) as EditableSpecField[]) {
    if (line.specProvenance[field] === 'user') continue
    const v = leaf(pack, field)
    if (v === null || v === undefined || v === '') {
      // null spec leaf: keep whatever applyCartonToLine set (master fallback)
      const hadMaster = String(line[field] ?? '').trim() !== '' &&
        !(field === 'backPrint' && line.backPrint === 'No')
      if (hadMaster) provenance[field] = 'master'
      continue
    }
    patch[field] = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)
    provenance[field] = overrideHasPath(specOverrides, field) ? 'override' : 'spec'
  }
  return { patch, provenance }
}

/**
 * Record a user edit: write the new value into specOverrides.specPack at the
 * mapped group/leaf and flip provenance to 'user' (non-mutating).
 */
export function applySpecOverrideEdit(
  line: SpecSeedLine,
  field: EditableSpecField,
  value: string,
): { specOverrides: SpecOverrides; specProvenance: SpecSeedLine['specProvenance'] } {
  const [group, key] = EDITABLE_SPEC_FIELDS[field]
  const prev = line.specOverrides?.specPack ?? {}
  const specPack = {
    ...prev,
    [group]: { ...(prev[group] ?? {}), [key]: value },
  }
  return {
    specOverrides: { specPack },
    specProvenance: { ...line.specProvenance, [field]: 'user' },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/po-line-specpack.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/po-line-specpack.ts src/lib/po-line-specpack.test.ts
git commit -m "feat(po): pure spec-pack line seeding + override module"
```

---

## Task 2: Carton spec-pack endpoint

**Files:**
- Create: `src/app/api/cartons/[id]/spec-pack/route.ts`
- Test: `src/app/api/cartons/[id]/spec-pack/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/cartons/[id]/spec-pack/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/helpers', () => ({
  requireAuth: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: { carton: { findUnique: vi.fn() } },
}))

import { GET } from './route'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'

const mockReq = {} as never

beforeEach(() => {
  vi.mocked(requireAuth).mockReset()
  vi.mocked(db.carton.findUnique).mockReset()
})

describe('GET /api/cartons/[id]/spec-pack', () => {
  it('returns the error response when auth fails', async () => {
    const errResp = new Response('no', { status: 401 })
    vi.mocked(requireAuth).mockResolvedValue({ error: errResp } as never)
    const res = await GET(mockReq, { params: { id: 'c1' } })
    expect(res.status).toBe(401)
  })

  it('404s when carton not found', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.carton.findUnique).mockResolvedValue(null as never)
    const res = await GET(mockReq, { params: { id: 'missing' } })
    expect(res.status).toBe(404)
  })

  it('returns a v1 pack built from the carton row', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: null } as never)
    vi.mocked(db.carton.findUnique).mockResolvedValue({
      id: 'c1', cartonName: 'ACEBROBID',
      boardGrade: 'SBS (Solid Bleached Sulphate)', gsm: 350, paperType: 'Ivory',
      coatingType: 'Full UV Coating', pastingStyle: 'BSO',
    } as never)
    const res = await GET(mockReq, { params: { id: 'c1' } })
    const json = await res.json()
    expect(json.pack.v).toBe(1)
    expect(json.pack.board.boardGrade).toBe('SBS (Solid Bleached Sulphate)')
    expect(json.pack.board.gsm).toBe(350)
    expect(json.pack.tooling.pastingStyle).toBe('BSO')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/cartons/[id]/spec-pack/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/api/cartons/[id]/spec-pack/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { db } from '@/lib/db'
import { buildCartonSpecPack, type CartonForPack } from '@/lib/carton-spec-pack'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { error } = await requireAuth()
  if (error) return error

  const c = await db.carton.findUnique({ where: { id: params.id } })
  if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ pack: buildCartonSpecPack(c as unknown as CartonForPack) })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/cartons/[id]/spec-pack/route.test.ts"`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/cartons/[id]/spec-pack/route.ts" "src/app/api/cartons/[id]/spec-pack/route.test.ts"
git commit -m "feat(api): GET /api/cartons/[id]/spec-pack returns canonical pack"
```

---

## Task 3: Extend Line type + defaultLine on the new-PO page

**Files:**
- Modify: `src/app/(dashboard)/orders/purchase-orders/new/page.tsx:72-104` (Line type), `:118-146` (defaultLine), `:148-161` (hasLineInput)

- [ ] **Step 1: Add fields to the `Line` type**

In `src/app/(dashboard)/orders/purchase-orders/new/page.tsx`, add an import near the other `@/lib` imports:

```typescript
import type { SpecOverrides, EditableSpecField, SpecProvenance } from '@/lib/po-line-specpack'
import type { SpecPackV1 } from '@/lib/carton-spec-pack'
```

Add these members to the `Line` type (after `useReservedFirst?: boolean` on line 103, before the closing `}`):

```typescript
  /** Canonical spec pack fetched for cartonId (cached); null = legacy/none. */
  specPackBase?: SpecPackV1 | null
  /** True once a fetch resolved with no v1 pack (legacy carton). */
  specPackLegacy?: boolean
  /** Per-line deliberate overrides, persisted at submit. */
  specOverrides?: SpecOverrides
  /** Provenance per editable field for badge rendering. */
  specProvenance?: Partial<Record<EditableSpecField, SpecProvenance>>
```

- [ ] **Step 2: Add defaults in `defaultLine()`**

In `defaultLine()` (line ~145, before the closing `})`), add:

```typescript
  specPackBase: undefined,
  specPackLegacy: false,
  specOverrides: null,
  specProvenance: {},
```

- [ ] **Step 3: Keep `hasLineInput` correct**

In `hasLineInput` (line ~149), add these early-returns alongside the other ignored keys so spec metadata never counts as user input:

```typescript
    if (key === 'specPackBase') return false
    if (key === 'specPackLegacy') return false
    if (key === 'specOverrides') return false
    if (key === 'specProvenance') return false
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "purchase-orders/new" | head`
Expected: no errors referencing the new members.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/orders/purchase-orders/new/page.tsx"
git commit -m "feat(po): extend Line with spec-pack base/overrides/provenance"
```

---

## Task 4: Fetch + cache spec pack and seed on the new-PO page

**Files:**
- Modify: `src/app/(dashboard)/orders/purchase-orders/new/page.tsx` — `applyCartonToLine` (~709), add fetch effect, add `updateLine` override-aware editing.

- [ ] **Step 1: Add a spec-pack cache ref and fetch effect**

Near the other `useRef`/`useState` declarations in the component (after `lineToolingByIdx` state ~479), add:

```typescript
  const specPackCache = useRef<Map<string, { pack: SpecPackV1 | null }>>(new Map())
```

After the existing customer-cartons effect (~593), add a new effect that, for every line with a `cartonId` and no resolved `specPackBase`, fetches the pack (using cache), then seeds:

```typescript
  useEffect(() => {
    let cancelled = false
    lines.forEach((ln, idx) => {
      if (!ln.cartonId) return
      if (ln.specPackBase !== undefined) return
      const cached = specPackCache.current.get(ln.cartonId)
      const apply = (pack: SpecPackV1 | null) => {
        if (cancelled) return
        setLines((prev) =>
          prev.map((cur, i) => {
            if (i !== idx || cur.cartonId !== ln.cartonId) return cur
            if (pack == null) {
              return { ...cur, specPackBase: null, specPackLegacy: true }
            }
            const { patch, provenance } = seedLineFromSpecPack(
              cur as unknown as SpecSeedLine,
              pack,
              cur.specOverrides ?? null,
            )
            return {
              ...cur,
              ...patch,
              specPackBase: pack,
              specPackLegacy: false,
              specProvenance: { ...cur.specProvenance, ...provenance },
            }
          }),
        )
      }
      if (cached) {
        apply(cached.pack)
        return
      }
      void (async () => {
        try {
          const res = await fetch(`/api/cartons/${encodeURIComponent(ln.cartonId)}/spec-pack`)
          if (!res.ok) {
            specPackCache.current.set(ln.cartonId, { pack: null })
            apply(null)
            return
          }
          const data = (await res.json()) as { pack?: SpecPackV1 }
          const pack = data.pack && (data.pack as { v?: number }).v === 1 ? data.pack : null
          specPackCache.current.set(ln.cartonId, { pack })
          apply(pack)
        } catch {
          specPackCache.current.set(ln.cartonId, { pack: null })
          apply(null)
        }
      })()
    })
    return () => {
      cancelled = true
    }
  }, [lines])
```

Add the imports at the top alongside Task 3's imports:

```typescript
import { seedLineFromSpecPack, applySpecOverrideEdit, type SpecSeedLine } from '@/lib/po-line-specpack'
```

- [ ] **Step 2: Reset spec state when a carton is (re)applied**

In `applyCartonToLine` (~715, inside the `updateLine(idx, { ... })` object), add so a new carton triggers a fresh fetch and clears stale provenance/overrides:

```typescript
      specPackBase: undefined,
      specPackLegacy: false,
      specOverrides: null,
      specProvenance: {},
```

- [ ] **Step 3: Make editable-field edits write overrides + provenance**

Add a helper above `updateLine` (~753):

```typescript
  const EDITABLE_FIELD_SET = new Set<EditableSpecField>([
    'boardGrade','gsm','paperType','coatingType','embossingLeafing',
    'foilType','pastingStyle','backPrint','artworkCode',
  ])

  const updateLineField = (idx: number, field: EditableSpecField, value: string) => {
    setLines((prev) =>
      prev.map((ln, i) => {
        if (i !== idx) return ln
        if (!ln.specPackBase) {
          return { ...ln, [field]: value }
        }
        const ov = applySpecOverrideEdit(ln as unknown as SpecSeedLine, field, value)
        return {
          ...ln,
          [field]: value,
          specOverrides: ov.specOverrides,
          specProvenance: ov.specProvenance,
        }
      }),
    )
  }
```

- [ ] **Step 4: Persist `specOverrides` at submit**

Find the submit payload builder (the existing `specOverrides:` at ~1109). Merge the line's spec overrides into the existing object so deliberate per-field edits persist. Replace the existing `specOverrides: { ... }` construction so it spreads `l.specOverrides?.specPack` into the persisted `specPack` key (keep any pre-existing keys like the prepress audit lead). Concretely, where the payload sets `specOverrides`, ensure:

```typescript
              specOverrides: {
                ...(existingOverridesForLine ?? {}),
                ...(l.specOverrides?.specPack
                  ? { specPack: l.specOverrides.specPack }
                  : {}),
              },
```

(`existingOverridesForLine` = whatever object the code already built there; do not drop its keys.)

- [ ] **Step 5: Wire `updateLineField` into the drawer call site**

Where `<PoNewLineItemDrawer ... updateLine={...} />` is rendered, pass an extra prop `updateLineField={updateLineField}` (added to the drawer in Task 5).

- [ ] **Step 6: Typecheck + run existing PO suite**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "purchase-orders/new|po-line-specpack" | head`
Run: `npx vitest run src/lib/po-line-specpack.test.ts`
Expected: no new type errors; module tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/orders/purchase-orders/new/page.tsx"
git commit -m "feat(po): fetch+cache carton spec pack, seed line, override write-back"
```

---

## Task 5: Drawer provenance badges + read-only spec block

**Files:**
- Modify: `src/components/po/PoNewLineItemDrawer.tsx`
- Test: `src/components/po/PoNewLineItemDrawer.test.tsx` (create)

- [ ] **Step 1: Write the failing component test**

Create `src/components/po/PoNewLineItemDrawer.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PoNewLineItemDrawer } from './PoNewLineItemDrawer'

vi.mock('@/components/masters/MastersProvider', () => ({
  useMaster: () => ({ options: [] }),
}))

const baseLine = {
  cartonId: 'c1', cartonName: 'ACEBROBID', cartonSize: '', quantity: '2000',
  artworkCode: 'AW-001', backPrint: 'No', wastagePct: '10', rate: '1.81',
  gstPct: '12', gsm: '350', coatingType: 'Full UV Coating',
  embossingLeafing: '', paperType: 'Ivory', boardGrade: 'SBS (Solid Bleached Sulphate)',
  foilType: '', remarks: '', dieMasterId: '', toolingDieType: '', toolingDims: '',
  toolingUnlinked: false, pastingStyle: 'BSO', masterPastingStyleMissing: false,
  ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
  specProvenance: { boardGrade: 'spec', paperType: 'master', gsm: 'override' },
  specPackBase: { v: 1, board: { caliperMicrons: 450, plyCount: 1 },
    dimensions: { finishedL: 59 }, sheet: { ups: 6 }, print: {}, finishing: {},
    tooling: {}, linkage: {}, pharma: {}, source: {} },
  specPackLegacy: false,
}

const noop = () => {}

function renderDrawer(line: unknown) {
  return render(
    <PoNewLineItemDrawer
      isOpen lineIndex={0} line={line as never} onClose={noop}
      updateLine={noop as never} updateLineField={noop as never}
      fieldErrors={{}} inputCls="" inputClsGhost="" inputErr="" poMono=""
      masterPasteSavingLine={null} masterPastePopoverLine={null}
      setMasterPastePopoverLine={noop} onSavePastingToMaster={noop as never}
    />,
  )
}

describe('PoNewLineItemDrawer spec-pack UI', () => {
  it('renders provenance badges per field', () => {
    renderDrawer(baseLine)
    expect(screen.getByText(/spec pack/i)).toBeInTheDocument()
    expect(screen.getByText(/^master$/i)).toBeInTheDocument()
    expect(screen.getByText(/overridden/i)).toBeInTheDocument()
  })

  it('renders the read-only spec block with non-editable groups', () => {
    renderDrawer(baseLine)
    expect(screen.getByText(/caliper/i)).toBeInTheDocument()
    expect(screen.getByText(/ups/i)).toBeInTheDocument()
  })

  it('shows the legacy notice when no pack', () => {
    renderDrawer({ ...baseLine, specPackBase: null, specPackLegacy: true, specProvenance: {} })
    expect(screen.getByText(/no locked spec pack/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/po/PoNewLineItemDrawer.test.tsx`
Expected: FAIL — `updateLineField` prop unknown / badges + caliper text absent.

- [ ] **Step 3: Add prop, badge component, and read-only block**

In `src/components/po/PoNewLineItemDrawer.tsx`:

(a) Add to the `Line` type the same four members from Task 3 (`specPackBase`, `specPackLegacy`, `specOverrides`, `specProvenance`) and import the types:

```typescript
import type { EditableSpecField, SpecProvenance } from '@/lib/po-line-specpack'
import { SpecPackPanel } from '@/components/spec-pack/SpecPackPanel'
```

(b) Add `updateLineField` to `PoNewLineItemDrawerProps`:

```typescript
  updateLineField: (idx: number, field: EditableSpecField, value: string) => void
```

(c) Add a badge helper near the bottom of the module-scope helpers:

```typescript
function ProvBadge({ p }: { p?: SpecProvenance }) {
  if (!p) return null
  const map: Record<SpecProvenance, string> = {
    spec: 'Spec pack', master: 'Master', override: 'Overridden', user: 'Overridden',
  }
  const tone =
    p === 'spec'
      ? 'border-ds-success/40 bg-ds-success/10 text-ds-success'
      : p === 'master'
        ? 'border-ds-line/50 bg-ds-elevated/40 text-ds-ink-faint'
        : 'border-ds-warning/40 bg-ds-warning/10 text-ds-warning'
  return (
    <span className={`ml-2 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>
      {map[p]}
    </span>
  )
}
```

(d) For each of the 9 editable fields, append `<ProvBadge p={line.specProvenance?.<field>} />` inside its `<label>` and change its `onChange` to call `updateLineField(lineIndex, '<field>', value)` instead of `updateLine`. Example for Board:

```tsx
<label className={labelSec}>Board<ProvBadge p={line.specProvenance?.boardGrade} /></label>
...
  onChange={(v) => updateLineField(lineIndex, 'boardGrade', v ?? '')}
```

Apply the analogous change to: `gsm`, `paperType`, `coatingType`, `embossingLeafing`, `foilType`, `pastingStyle` (its `onPastingSelectChange`), `backPrint`, `artworkCode`.

(e) At the end of the Costing `CardSection`, after the Additional block, add the read-only spec block:

```tsx
<div className="border-t border-ds-line/50 pt-4">
  <p className={labelSec}>Locked spec (read-only)</p>
  {line.specPackBase
    ? <SpecPackPanel specPack={line.specPackBase} specOverrides={line.specOverrides ?? null} />
    : line.specPackLegacy
      ? <SpecPackPanel specPack={null} specOverrides={null} />
      : <p className="text-xs text-ds-ink-faint">Loading spec…</p>}
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/po/PoNewLineItemDrawer.test.tsx`
Expected: PASS (3 cases).

- [ ] **Step 5: Typecheck the call site**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "PoNewLineItemDrawer|purchase-orders/new" | head`
Expected: no errors (the `updateLineField` prop is now passed from Task 4 Step 5).

- [ ] **Step 6: Commit**

```bash
git add src/components/po/PoNewLineItemDrawer.tsx src/components/po/PoNewLineItemDrawer.test.tsx
git commit -m "feat(po): drawer provenance badges + read-only locked spec block"
```

---

## Task 6: Full regression + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, no regressions in PO / spec-pack / carton suites.

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean (no new errors).

- [ ] **Step 3: Manual smoke (dev server)**

Start dev server, open PO → New, pick a customer, add a line and select a carton that has a spec pack:
- Editable Material/Printing fields fill from spec pack; badges show "Spec pack"/"Master".
- Edit Paper → badge flips to "Overridden".
- Read-only block shows dimensions/sheet/UPS/caliper/colours/pharma.
- Pick a legacy carton (no spec pack) → fields fall back to master, badges read "Master", read-only block shows the "No locked spec pack" notice.
- Save the PO; reopen the created PO and confirm the overridden field persisted.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "test(po): regression pass for spec-pack autopopulation"
```

---

## Self-Review Notes

- **Spec coverage:** endpoint (Task 2), client fetch/cache/seed (Task 4), per-field merge + provenance + override write-back (Tasks 1, 4), drawer badges + read-only block (Task 5), legacy path (Tasks 1/5), tests (every task), submit unchanged except additive override merge (Task 4 Step 4). Scope guards (no `/api/cartons` change, no submit snapshot change, read-only non-editable groups) honored.
- **Type consistency:** `SpecSeedLine`, `EditableSpecField`, `SpecProvenance`, `SpecOverrides` defined in Task 1 and reused verbatim in Tasks 3–5. `updateLineField` signature identical in Task 4 (definition) and Task 5 (prop).
- **No placeholders:** all steps contain concrete code/commands. `existingOverridesForLine` in Task 4 Step 4 intentionally refers to the code already present at that site (it must be inspected during execution); flagged explicitly rather than guessed.
