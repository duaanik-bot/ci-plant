# Master Data Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every user, operator, role, machine, terminal rule, department mapping, and production permission in the CI-Plant app with the new master data set, removing all legacy definitions from code, seed data, and the live database.

**Architecture:** A single source-of-truth constants module (`src/lib/master-data.ts`) defines the new machines, operators, departments, dedicated login users, fixed printing assignments, and terminal rules. A new RBAC module (`src/lib/rbac.ts`) defines the 5 roles and their module-access map, replacing the legacy slug-based `requireRole` gates across ~55 API routes, middleware, and navigation. `prisma/seed.ts` is rewritten to seed exactly this data; a guarded `scripts/replace-master-data.ts` performs the destructive wipe-and-reload against the live DB. Production "terminals" are enforced as rules on the existing stage pages (no new DB model).

**Tech Stack:** Next.js 14 (App Router), Prisma 5 + PostgreSQL (Supabase), NextAuth (email+PIN credentials), Vitest, bcryptjs.

---

## New Master Data (canonical reference)

### Roles (slug → label → modules)
| slug | label | modules |
|------|-------|---------|
| `admin` | Admin | `*` (full system) |
| `plant_head` | Plant Head | `*` (full system) |
| `accounts` | Accounts | `customer_po`, `paper_warehouse` |
| `design_planning` | Design & Planning | `customer_po`, `planning`, `artwork_queue`, `job_cards`, `cutting`, `printing` |
| `production` | Production | `cutting`, `printing` |

### Modules (access units)
`customer_po`, `paper_warehouse`, `planning`, `artwork_queue`, `job_cards`, `cutting`, `printing`. `admin` and `plant_head` get `*` (everything, including tooling hub, inventory, stores, quality, dispatch, reports, masters).

### Dedicated login users (email = `<firstname>@ci.local`, PIN = `123456`)
| name | email | role |
|------|-------|------|
| Ravi | ravi@ci.local | admin |
| Shamsheer Inder | shamsheer@ci.local | admin |
| Manish Admin | manish@ci.local | admin |
| Dharminder | dharminder@ci.local | plant_head |
| Amrinder Accounts | amrinder@ci.local | accounts |
| Avneet Designs | avneet@ci.local | design_planning |
| Ankit Loader | ankit@ci.local | production |

### Operators (OperatorMaster) + station (PRODUCTION_STAGES key)
| operator | department | stageKey |
|----------|-----------|----------|
| Parkash | Coating | `chemical_coating` |
| Raja | Coating | `chemical_coating` |
| Jiut | Pasting | `pasting` |
| Shankar | Pasting | `pasting` |
| Dileep Pasting | Pasting | `pasting` |
| Dileep Printing | Printing | `printing` |
| Modi | Printing | `printing` |
| Shiv | Printing | `printing` |
| Sonu | Die Punching | `dye_cutting` |
| Surjeet | Die Punching | `dye_cutting` |
| Rajesh | Die Punching | `dye_cutting` |
| Birju | Die Punching | `dye_cutting` |
| Nitish | Die Punching | `dye_cutting` |
| Lakhan | Die Punching | `dye_cutting` |

### Machines (machineCode → name → stage group)
| code | name | group |
|------|------|-------|
| CUT-01 | Polar Cutting Machine | cutting |
| PRN-01 | Komori 5 Colour Press 1 | printing |
| PRN-02 | Komori 5 Colour Press 2 | printing |
| PRN-03 | Komori 5 Colour Press 3 | printing |
| COT-01 | UV Coating Machine 1 | coating |
| COT-02 | UV Coating Machine 2 | coating |
| DIE-A01 | Automatic Die Cutter 1 | die |
| DIE-A02 | Automatic Die Cutter 2 | die |
| DIE-A03 | Automatic Die Cutter 3 | die |
| DIE-M01 | Manual Die Punching Machine 1 | die |
| DIE-M02 | Manual Die Punching Machine 2 | die |
| PST-01 | Folder Gluer 1 | pasting |
| PST-02 | Folder Gluer 2 | pasting |
| PST-03 | Folder Gluer 3 | pasting |

> Note: `Machine.machineCode` is `@db.VarChar(10)` — all new codes fit (≤7 chars).

### Fixed printing machine assignment (operator name → machine code)
`Dileep Printing → PRN-01`, `Modi → PRN-02`, `Shiv → PRN-03`.

### Terminals (code → label → stage)
`TERM-CUT`/Cutting/`cutting`, `TERM-PRN`/Printing/`printing`, `TERM-COT`/Coating/`chemical_coating`, `TERM-DIE`/Die/`dye_cutting`, `TERM-PST`/Pasting/`pasting`. No DB model — used as labels + rule keys only.

### Terminal rules
| terminal | operator | machine |
|----------|----------|---------|
| Cutting | optional | fixed `CUT-01` (no select) |
| Printing | required (Dileep Printing / Modi / Shiv) | auto-filled from operator (no select) |
| Coating | required | required (COT-01/COT-02) |
| Die | required | required (any DIE-*) |
| Pasting | required | required (PST-01..03) |

---

## File Structure

**New files:**
- `src/lib/master-data.ts` — machines, operators, departments, login users, fixed printing assignments, terminals.
- `src/lib/rbac.ts` — role slugs/labels, module-access map, `hasModuleAccess`, `roleHasFullSystem`.
- `src/lib/production-terminal-rules.ts` — pure resolver for per-terminal operator/machine rules + printing auto-assignment.
- `scripts/replace-master-data.ts` — guarded destructive wipe + reload.
- Test files alongside: `src/lib/rbac.test.ts`, `src/lib/production-terminal-rules.test.ts`.

**Modified files (high level):**
- `prisma/seed.ts` — roles, machines, users, operators + station assignments.
- `src/lib/helpers.ts` — add `requireModule`; keep `requireRole` working with new slugs.
- `src/middleware.ts`, `src/lib/hub-admin-gate.ts`, `src/app/(dashboard)/DashboardShell.tsx`, `src/app/(dashboard)/SidebarNav.tsx` — gating.
- ~55 API route files using `requireRole(...)` — slug remap.
- Dashboards/press filters: `src/app/api/oee/live/route.ts`, `src/app/api/dashboard/{stats,press-status,summary}/route.ts`, `src/app/api/director-command-center/business-vitals/route.ts`, `src/app/api/production/machine-flow/route.ts`, `src/app/api/jobs/route.ts`.
- UI machine refs: `src/app/(dashboard)/DashboardClient.tsx`, `_components/DashboardCharts.tsx`, `director/command-center/page.tsx`, `production/machine-flow/page.tsx`, `masters/page.tsx`, `masters/dies/[id]/page.tsx`, `masters/machines/page.tsx`, `masters/users/new/page.tsx`, `jobs/new/page.tsx`.
- Terminal rules wiring: `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`.
- Tests: `src/lib/reports/**/*.test.ts`, `src/components/planning/engine/SectionBatchDecision.test.tsx`.
- Legacy scripts: `scripts/legacy-role-map.ts`, `scripts/migrate-machinery-operators.ts`, `scripts/remap-legacy-roles.ts`, `scripts/reset-admin.ts`.

---

## Phase 0 — Pre-flight & branch hygiene

### Task 0: Baseline verification

**Files:** none (read-only)

- [ ] **Step 1: Confirm clean tree & capture baseline**

Run: `git status && npx tsc --noEmit 2>&1 | tail -20 && npx vitest run 2>&1 | tail -30`
Expected: working tree clean; record any *pre-existing* type errors / failing tests so we don't blame them on this work. Save the failing-test list to scratch notes.

- [ ] **Step 2: Confirm DB connection target**

Run: `grep -c DATABASE_URL .env.local 2>/dev/null; echo "---"; grep DATABASE_URL .env.example`
Expected: confirm which DB the destructive script will hit. **Do NOT run the destructive script (Phase 8) until the user confirms the target is correct.**

---

## Phase 1 — Foundation constants (`master-data.ts`)

### Task 1: Create the master-data constants module

**Files:**
- Create: `src/lib/master-data.ts`

- [ ] **Step 1: Write the module**

```ts
// src/lib/master-data.ts
// Single source of truth for plant master data: machines, operators,
// departments, dedicated login users, fixed printing assignments, terminals.

/** Production stage groups → drives machine taxonomy + terminal rules. */
export type MachineGroup = 'cutting' | 'printing' | 'coating' | 'die' | 'pasting'

export type MachineSeed = {
  machineCode: string
  name: string
  group: MachineGroup
  capacityPerShift: number
  stdWastePct: number
}

export const MACHINES: MachineSeed[] = [
  { machineCode: 'CUT-01', name: 'Polar Cutting Machine', group: 'cutting', capacityPerShift: 12000, stdWastePct: 0.5 },
  { machineCode: 'PRN-01', name: 'Komori 5 Colour Press 1', group: 'printing', capacityPerShift: 80000, stdWastePct: 3.0 },
  { machineCode: 'PRN-02', name: 'Komori 5 Colour Press 2', group: 'printing', capacityPerShift: 80000, stdWastePct: 3.0 },
  { machineCode: 'PRN-03', name: 'Komori 5 Colour Press 3', group: 'printing', capacityPerShift: 80000, stdWastePct: 3.0 },
  { machineCode: 'COT-01', name: 'UV Coating Machine 1', group: 'coating', capacityPerShift: 48000, stdWastePct: 2.0 },
  { machineCode: 'COT-02', name: 'UV Coating Machine 2', group: 'coating', capacityPerShift: 48000, stdWastePct: 2.0 },
  { machineCode: 'DIE-A01', name: 'Automatic Die Cutter 1', group: 'die', capacityPerShift: 12000, stdWastePct: 2.0 },
  { machineCode: 'DIE-A02', name: 'Automatic Die Cutter 2', group: 'die', capacityPerShift: 12000, stdWastePct: 2.0 },
  { machineCode: 'DIE-A03', name: 'Automatic Die Cutter 3', group: 'die', capacityPerShift: 12000, stdWastePct: 2.0 },
  { machineCode: 'DIE-M01', name: 'Manual Die Punching Machine 1', group: 'die', capacityPerShift: 8000, stdWastePct: 2.5 },
  { machineCode: 'DIE-M02', name: 'Manual Die Punching Machine 2', group: 'die', capacityPerShift: 8000, stdWastePct: 2.5 },
  { machineCode: 'PST-01', name: 'Folder Gluer 1', group: 'pasting', capacityPerShift: 300000, stdWastePct: 1.0 },
  { machineCode: 'PST-02', name: 'Folder Gluer 2', group: 'pasting', capacityPerShift: 300000, stdWastePct: 1.0 },
  { machineCode: 'PST-03', name: 'Folder Gluer 3', group: 'pasting', capacityPerShift: 300000, stdWastePct: 1.0 },
]

/** machineCodes by group — convenience for filters/dropdowns. */
export const MACHINE_CODES_BY_GROUP: Record<MachineGroup, string[]> = {
  cutting: MACHINES.filter((m) => m.group === 'cutting').map((m) => m.machineCode),
  printing: MACHINES.filter((m) => m.group === 'printing').map((m) => m.machineCode),
  coating: MACHINES.filter((m) => m.group === 'coating').map((m) => m.machineCode),
  die: MACHINES.filter((m) => m.group === 'die').map((m) => m.machineCode),
  pasting: MACHINES.filter((m) => m.group === 'pasting').map((m) => m.machineCode),
}

/** Press machine codes used by dashboards/OEE (replaces legacy ['CI-01','CI-02','CI-03']). */
export const PRESS_MACHINE_CODES = MACHINE_CODES_BY_GROUP.printing

export type OperatorSeed = { name: string; department: string; stageKey: string }

export const OPERATORS: OperatorSeed[] = [
  { name: 'Parkash', department: 'Coating', stageKey: 'chemical_coating' },
  { name: 'Raja', department: 'Coating', stageKey: 'chemical_coating' },
  { name: 'Jiut', department: 'Pasting', stageKey: 'pasting' },
  { name: 'Shankar', department: 'Pasting', stageKey: 'pasting' },
  { name: 'Dileep Pasting', department: 'Pasting', stageKey: 'pasting' },
  { name: 'Dileep Printing', department: 'Printing', stageKey: 'printing' },
  { name: 'Modi', department: 'Printing', stageKey: 'printing' },
  { name: 'Shiv', department: 'Printing', stageKey: 'printing' },
  { name: 'Sonu', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Surjeet', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Rajesh', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Birju', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Nitish', department: 'Die Punching', stageKey: 'dye_cutting' },
  { name: 'Lakhan', department: 'Die Punching', stageKey: 'dye_cutting' },
]

export type LoginUserSeed = { name: string; email: string; roleSlug: string }

export const LOGIN_USERS: LoginUserSeed[] = [
  { name: 'Ravi', email: 'ravi@ci.local', roleSlug: 'admin' },
  { name: 'Shamsheer Inder', email: 'shamsheer@ci.local', roleSlug: 'admin' },
  { name: 'Manish Admin', email: 'manish@ci.local', roleSlug: 'admin' },
  { name: 'Dharminder', email: 'dharminder@ci.local', roleSlug: 'plant_head' },
  { name: 'Amrinder Accounts', email: 'amrinder@ci.local', roleSlug: 'accounts' },
  { name: 'Avneet Designs', email: 'avneet@ci.local', roleSlug: 'design_planning' },
  { name: 'Ankit Loader', email: 'ankit@ci.local', roleSlug: 'production' },
]

export const DEFAULT_USER_PIN = '123456'

/** Operator name → fixed printing machine code. */
export const PRINTING_FIXED_ASSIGNMENT: Record<string, string> = {
  'Dileep Printing': 'PRN-01',
  Modi: 'PRN-02',
  Shiv: 'PRN-03',
}

export type TerminalSeed = { code: string; label: string; stageKey: string }

export const TERMINALS: TerminalSeed[] = [
  { code: 'TERM-CUT', label: 'Cutting Terminal', stageKey: 'cutting' },
  { code: 'TERM-PRN', label: 'Printing Terminal', stageKey: 'printing' },
  { code: 'TERM-COT', label: 'Coating Terminal', stageKey: 'chemical_coating' },
  { code: 'TERM-DIE', label: 'Die Terminal', stageKey: 'dye_cutting' },
  { code: 'TERM-PST', label: 'Pasting Terminal', stageKey: 'pasting' },
]
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/lib/master-data.ts 2>&1 | head` (or full `npx tsc --noEmit`)
Expected: no new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/lib/master-data.ts
git commit -m "feat(masters): add master-data constants (machines, operators, users, terminals)"
```

---

## Phase 2 — RBAC module (TDD)

### Task 2: Create `rbac.ts` with module-access logic

**Files:**
- Create: `src/lib/rbac.ts`
- Test: `src/lib/rbac.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/rbac.test.ts
import { describe, it, expect } from 'vitest'
import { ROLE_SLUGS, ROLE_LABELS, hasModuleAccess, roleHasFullSystem } from './rbac'

describe('rbac', () => {
  it('defines exactly the five roles', () => {
    expect([...ROLE_SLUGS].sort()).toEqual(
      ['accounts', 'admin', 'design_planning', 'plant_head', 'production'].sort(),
    )
  })

  it('admin and plant_head have full system access', () => {
    expect(roleHasFullSystem('admin')).toBe(true)
    expect(roleHasFullSystem('plant_head')).toBe(true)
    expect(roleHasFullSystem('accounts')).toBe(false)
    expect(hasModuleAccess('admin', 'reports')).toBe(true)
    expect(hasModuleAccess('plant_head', 'masters')).toBe(true)
  })

  it('accounts sees only customer_po and paper_warehouse', () => {
    expect(hasModuleAccess('accounts', 'customer_po')).toBe(true)
    expect(hasModuleAccess('accounts', 'paper_warehouse')).toBe(true)
    expect(hasModuleAccess('accounts', 'planning')).toBe(false)
    expect(hasModuleAccess('accounts', 'reports')).toBe(false)
  })

  it('design_planning sees its six modules but not paper_warehouse', () => {
    for (const m of ['customer_po', 'planning', 'artwork_queue', 'job_cards', 'cutting', 'printing'] as const) {
      expect(hasModuleAccess('design_planning', m)).toBe(true)
    }
    expect(hasModuleAccess('design_planning', 'paper_warehouse')).toBe(false)
    expect(hasModuleAccess('design_planning', 'reports')).toBe(false)
  })

  it('production sees only cutting and printing', () => {
    expect(hasModuleAccess('production', 'cutting')).toBe(true)
    expect(hasModuleAccess('production', 'printing')).toBe(true)
    expect(hasModuleAccess('production', 'job_cards')).toBe(false)
  })

  it('is case-insensitive and safe on unknown roles', () => {
    expect(hasModuleAccess('ADMIN', 'reports')).toBe(true)
    expect(hasModuleAccess(undefined, 'reports')).toBe(false)
    expect(hasModuleAccess('legacy_md', 'reports')).toBe(false)
  })

  it('has a label for every role', () => {
    expect(ROLE_LABELS.admin).toBe('Admin')
    expect(ROLE_LABELS.plant_head).toBe('Plant Head')
    expect(ROLE_LABELS.design_planning).toBe('Design & Planning')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/rbac.test.ts`
Expected: FAIL — `Cannot find module './rbac'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/rbac.ts
// Role-based access control for the 5 canonical plant roles.

export const ROLE_SLUGS = [
  'admin',
  'plant_head',
  'accounts',
  'design_planning',
  'production',
] as const

export type RoleSlug = (typeof ROLE_SLUGS)[number]

export const ROLE_LABELS: Record<RoleSlug, string> = {
  admin: 'Admin',
  plant_head: 'Plant Head',
  accounts: 'Accounts',
  design_planning: 'Design & Planning',
  production: 'Production',
}

/** Granular module/access keys used to gate nav + API routes. */
export type ModuleKey =
  | 'customer_po'
  | 'paper_warehouse'
  | 'planning'
  | 'artwork_queue'
  | 'job_cards'
  | 'cutting'
  | 'printing'
  // full-system-only modules (admin / plant_head)
  | 'tooling_hub'
  | 'inventory'
  | 'stores'
  | 'quality'
  | 'dispatch'
  | 'reports'
  | 'masters'
  | 'settings'

const FULL = '*' as const

/** Role → modules. '*' means full system (every module). */
export const ROLE_MODULES: Record<RoleSlug, ModuleKey[] | typeof FULL> = {
  admin: FULL,
  plant_head: FULL,
  accounts: ['customer_po', 'paper_warehouse'],
  design_planning: ['customer_po', 'planning', 'artwork_queue', 'job_cards', 'cutting', 'printing'],
  production: ['cutting', 'printing'],
}

function normalize(role: string | undefined | null): RoleSlug | null {
  const r = (role ?? '').trim().toLowerCase()
  return (ROLE_SLUGS as readonly string[]).includes(r) ? (r as RoleSlug) : null
}

export function roleHasFullSystem(role: string | undefined | null): boolean {
  const slug = normalize(role)
  return slug != null && ROLE_MODULES[slug] === FULL
}

export function hasModuleAccess(role: string | undefined | null, moduleKey: ModuleKey): boolean {
  const slug = normalize(role)
  if (!slug) return false
  const mods = ROLE_MODULES[slug]
  if (mods === FULL) return true
  return mods.includes(moduleKey)
}

/** Roles that may reach a given module — for `requireRole`-style API gates. */
export function rolesWithModule(moduleKey: ModuleKey): RoleSlug[] {
  return ROLE_SLUGS.filter((s) => hasModuleAccess(s, moduleKey))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/rbac.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rbac.ts src/lib/rbac.test.ts
git commit -m "feat(rbac): add 5-role module-access model"
```

---

## Phase 3 — Terminal rules module (TDD)

### Task 3: Create `production-terminal-rules.ts`

**Files:**
- Create: `src/lib/production-terminal-rules.ts`
- Test: `src/lib/production-terminal-rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/production-terminal-rules.test.ts
import { describe, it, expect } from 'vitest'
import { getTerminalRule, resolvePrintingMachine } from './production-terminal-rules'

describe('production-terminal-rules', () => {
  it('cutting fixes machine to CUT-01 and does not require operator', () => {
    const r = getTerminalRule('cutting')
    expect(r.fixedMachineCode).toBe('CUT-01')
    expect(r.machineSelectable).toBe(false)
    expect(r.operatorRequired).toBe(false)
  })

  it('printing auto-fills machine from operator, no machine select, operator required', () => {
    const r = getTerminalRule('printing')
    expect(r.machineSelectable).toBe(false)
    expect(r.machineAutoFromOperator).toBe(true)
    expect(r.operatorRequired).toBe(true)
    expect(resolvePrintingMachine('Modi')).toBe('PRN-02')
    expect(resolvePrintingMachine('Dileep Printing')).toBe('PRN-01')
    expect(resolvePrintingMachine('Shiv')).toBe('PRN-03')
    expect(resolvePrintingMachine('Unknown')).toBeNull()
  })

  it('coating / dye_cutting / pasting require both operator and machine', () => {
    for (const k of ['chemical_coating', 'dye_cutting', 'pasting'] as const) {
      const r = getTerminalRule(k)
      expect(r.operatorRequired).toBe(true)
      expect(r.machineSelectable).toBe(true)
      expect(r.machineRequired).toBe(true)
    }
  })

  it('returns a permissive default for stages without a terminal', () => {
    const r = getTerminalRule('lamination')
    expect(r.machineSelectable).toBe(true)
    expect(r.operatorRequired).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/production-terminal-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/production-terminal-rules.ts
import { PRINTING_FIXED_ASSIGNMENT, MACHINE_CODES_BY_GROUP } from '@/lib/master-data'

export type TerminalRule = {
  /** stageKey from PRODUCTION_STAGES */
  stageKey: string
  operatorRequired: boolean
  machineSelectable: boolean
  machineRequired: boolean
  /** when set, machine is locked to this code */
  fixedMachineCode: string | null
  /** when true, machine is derived from the chosen operator (printing) */
  machineAutoFromOperator: boolean
  /** machine codes valid for this terminal's selector */
  machineCodes: string[]
}

const RULES: Record<string, TerminalRule> = {
  cutting: {
    stageKey: 'cutting',
    operatorRequired: false,
    machineSelectable: false,
    machineRequired: true,
    fixedMachineCode: 'CUT-01',
    machineAutoFromOperator: false,
    machineCodes: MACHINE_CODES_BY_GROUP.cutting,
  },
  printing: {
    stageKey: 'printing',
    operatorRequired: true,
    machineSelectable: false,
    machineRequired: true,
    fixedMachineCode: null,
    machineAutoFromOperator: true,
    machineCodes: MACHINE_CODES_BY_GROUP.printing,
  },
  chemical_coating: {
    stageKey: 'chemical_coating',
    operatorRequired: true,
    machineSelectable: true,
    machineRequired: true,
    fixedMachineCode: null,
    machineAutoFromOperator: false,
    machineCodes: MACHINE_CODES_BY_GROUP.coating,
  },
  dye_cutting: {
    stageKey: 'dye_cutting',
    operatorRequired: true,
    machineSelectable: true,
    machineRequired: true,
    fixedMachineCode: null,
    machineAutoFromOperator: false,
    machineCodes: MACHINE_CODES_BY_GROUP.die,
  },
  pasting: {
    stageKey: 'pasting',
    operatorRequired: true,
    machineSelectable: true,
    machineRequired: true,
    fixedMachineCode: null,
    machineAutoFromOperator: false,
    machineCodes: MACHINE_CODES_BY_GROUP.pasting,
  },
}

const DEFAULT_RULE = (stageKey: string): TerminalRule => ({
  stageKey,
  operatorRequired: false,
  machineSelectable: true,
  machineRequired: false,
  fixedMachineCode: null,
  machineAutoFromOperator: false,
  machineCodes: [],
})

export function getTerminalRule(stageKey: string): TerminalRule {
  return RULES[stageKey] ?? DEFAULT_RULE(stageKey)
}

export function resolvePrintingMachine(operatorName: string): string | null {
  return PRINTING_FIXED_ASSIGNMENT[operatorName.trim()] ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/production-terminal-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/production-terminal-rules.ts src/lib/production-terminal-rules.test.ts
git commit -m "feat(production): add terminal rules resolver"
```

---

## Phase 4 — Rewrite Prisma seed

### Task 4: Replace roles + machines + users + operators in `prisma/seed.ts`

**Files:**
- Modify: `prisma/seed.ts:16-152` (roles), `:158-336` (machines + PM schedules), `:463-482` (admin user). Add operator seeding.

- [ ] **Step 1: Replace the ROLES block (`seed.ts:16-153`)**

Replace the entire `const roles = await Promise.all([...])` array and its log line with:

```ts
  // ─────────────────────────────────────────
  // ROLES — 5 canonical roles
  // ─────────────────────────────────────────
  const ROLE_SEED: { slug: string; permissions: Record<string, string>; full: boolean }[] = [
    { slug: 'admin', full: true, permissions: { jobs: 'full', artwork: 'full', production: 'full', inventory: 'full', qms: 'full', dispatch: 'full', reports: 'full', admin: 'full' } },
    { slug: 'plant_head', full: true, permissions: { jobs: 'full', artwork: 'full', production: 'full', inventory: 'full', qms: 'full', dispatch: 'full', reports: 'full', admin: 'full' } },
    { slug: 'accounts', full: false, permissions: { jobs: 'view', artwork: 'none', production: 'none', inventory: 'view', qms: 'none', dispatch: 'view', reports: 'partial', admin: 'none' } },
    { slug: 'design_planning', full: false, permissions: { jobs: 'full', artwork: 'approve', production: 'partial', inventory: 'view', qms: 'view', dispatch: 'view', reports: 'partial', admin: 'none' } },
    { slug: 'production', full: false, permissions: { jobs: 'own', artwork: 'none', production: 'own', inventory: 'own', qms: 'none', dispatch: 'none', reports: 'none', admin: 'none' } },
  ]
  const roles = await Promise.all(
    ROLE_SEED.map((r) =>
      prisma.role.upsert({
        where: { roleName: r.slug },
        update: { permissions: r.permissions, canApproveArtwork: r.full || r.slug === 'design_planning', canReleaseDispatch: r.full, wastageApproveLimitPct: r.full ? 999 : 0 },
        create: {
          roleName: r.slug,
          permissions: r.permissions,
          canApproveArtwork: r.full || r.slug === 'design_planning',
          canReleaseDispatch: r.full,
          wastageApproveLimitPct: r.full ? 999 : 0,
        },
      }),
    ),
  )
  console.log(`✅ ${roles.length} roles created`)
```

- [ ] **Step 2: Replace the MACHINES block (`seed.ts:158-304`)**

Add the import at the top of `seed.ts` (after existing imports):

```ts
import { MACHINES } from '../src/lib/master-data'
```

Replace the `const machines = await Promise.all([...])` array + its log line with:

```ts
  const machines = await Promise.all(
    MACHINES.map((m) =>
      prisma.machine.upsert({
        where: { machineCode: m.machineCode },
        update: { name: m.name, capacityPerShift: m.capacityPerShift, stdWastePct: m.stdWastePct },
        create: {
          machineCode: m.machineCode,
          name: m.name,
          capacityPerShift: m.capacityPerShift,
          stdWastePct: m.stdWastePct,
        },
      }),
    ),
  )
  console.log(`✅ ${machines.length} machines seeded`)
```

The PM-schedule loop (`seed.ts:306-336`) stays but change the offset detection — replace `const isOffset = ['CI-01', 'CI-02', 'CI-03'].includes(m.machineCode)` with `const isOffset = m.machineCode.startsWith('PRN-')`.

- [ ] **Step 3: Replace the ADMIN USER block (`seed.ts:463-482`)**

Add import at top:

```ts
import { LOGIN_USERS, OPERATORS, DEFAULT_USER_PIN } from '../src/lib/master-data'
```

Replace the single-admin-user block with:

```ts
  // ─────────────────────────────────────────
  // DEDICATED LOGIN USERS
  // ─────────────────────────────────────────
  const pinHash = await bcrypt.hash(DEFAULT_USER_PIN, 12)
  const roleBySlug = new Map(roles.map((r) => [r.roleName, r.id]))
  for (const u of LOGIN_USERS) {
    const roleId = roleBySlug.get(u.roleSlug)
    if (!roleId) throw new Error(`Missing role ${u.roleSlug} for user ${u.name}`)
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, roleId, active: true },
      create: { name: u.name, email: u.email, pinHash, roleId, active: true },
    })
  }
  console.log(`✅ ${LOGIN_USERS.length} login users seeded (default PIN ${DEFAULT_USER_PIN})`)

  // ─────────────────────────────────────────
  // OPERATORS + STATION ASSIGNMENTS
  // ─────────────────────────────────────────
  for (const op of OPERATORS) {
    const row = await prisma.operatorMaster.upsert({
      where: { name: op.name },
      update: { isActive: true },
      create: { name: op.name, isActive: true },
    })
    await prisma.operatorStationAssignment.upsert({
      where: { operatorId_stageKey: { operatorId: row.id, stageKey: op.stageKey } },
      update: {},
      create: { operatorId: row.id, stageKey: op.stageKey },
    })
  }
  console.log(`✅ ${OPERATORS.length} operators + station assignments seeded`)
```

- [ ] **Step 4: Update the seed header comment (`seed.ts:3`)**

Change `// Seeds: 10 roles, 12 machines, 13 QC instruments, admin user` to `// Seeds: 5 roles, 14 machines, 13 QC instruments, 7 login users, 14 operators`.

- [ ] **Step 5: Verify the seed compiles (no DB needed)**

Run: `npx tsc --noEmit 2>&1 | grep -i "seed\|master-data" | head`
Expected: no errors referencing `prisma/seed.ts`.

- [ ] **Step 6: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat(seed): seed 5 roles, new machines, login users, operators"
```

---

## Phase 5 — RBAC enforcement: helpers, middleware, gates

### Task 5: Add `requireModule` + keep `requireRole`

**Files:**
- Modify: `src/lib/helpers.ts:44-58` (requireRole), add `requireModule`.

- [ ] **Step 1: Read current helper**

Run: `sed -n '36,60p' src/lib/helpers.ts` (read-only context)

- [ ] **Step 2: Add `requireModule` after `requireRole`**

Insert after the `requireRole` function:

```ts
import { hasModuleAccess, type ModuleKey } from '@/lib/rbac'

export async function requireModule(moduleKey: ModuleKey) {
  const { error, user } = await requireAuth()
  if (error) return { error, user: null }
  if (!hasModuleAccess(user!.role, moduleKey)) {
    return {
      error: NextResponse.json({ error: 'Forbidden — no module access' }, { status: 403 }),
      user: null,
    }
  }
  return { error: null, user }
}
```

(Place the `import` with the other imports at the top of the file, not inline.)

- [ ] **Step 3: Verify compile + commit**

Run: `npx tsc --noEmit 2>&1 | grep helpers | head`
Expected: none.

```bash
git add src/lib/helpers.ts
git commit -m "feat(rbac): add requireModule server gate"
```

### Task 6: Remap `requireRole` slugs across API routes (dominant patterns)

**Files:** all under `src/app/api/**` matching the two dominant strings.

- [ ] **Step 1: Global replace the management gate**

Run:
```bash
grep -rl "requireRole('operations_head', 'md')" src/app/api | xargs sed -i '' "s/requireRole('operations_head', 'md')/requireRole('admin', 'plant_head')/g"
```
Expected: ~40 files updated.

- [ ] **Step 2: Global replace the inventory/stores gate**

Run:
```bash
grep -rl "requireRole('stores', 'production_manager', 'operations_head', 'md')" src/app/api | xargs sed -i '' "s/requireRole('stores', 'production_manager', 'operations_head', 'md')/requireRole('admin', 'plant_head', 'accounts')/g"
```

- [ ] **Step 3: Replace SHORT_CLOSE_EXECUTOR_ROLES**

In `src/lib/vendor-po-short-close.ts:22`, change:
```ts
export const SHORT_CLOSE_EXECUTOR_ROLES = ['md', 'director', 'procurement_manager'] as const
```
to:
```ts
export const SHORT_CLOSE_EXECUTOR_ROLES = ['admin', 'plant_head'] as const
```

- [ ] **Step 4: Find & fix remaining legacy slugs (multi-line gates)**

Run:
```bash
grep -rzoE "requireRole\(([^)]|\n)*\)" src/app/api | tr '\0' '\n' | grep -oE "'(md|operations_head|production_manager|shift_supervisor|press_operator|qa_officer|qa_manager|stores|procurement_manager)'" | sort -u
```
Expected after Steps 1-3: a residual set from multi-line calls (sheet-issues attempt/job-card-issue/approve/reject, purchase-requisitions convert/approve, press/validate-plate, inventory/grn, inventory/[id]/release, fifo-check, waste/record, job-cards sheet-context, jobs sheet-context).

For each file still containing a legacy slug, open it and remap the role list using this table (production-floor gates get `production` + `design_planning`; management/approval gates get `admin`,`plant_head`; inventory/stores get `+ accounts`):

| legacy slug present | replace whole list with |
|---|---|
| approval/management (`qa_manager`,`qa_officer`,`operations_head`,`md` only) | `'admin', 'plant_head'` |
| inventory/stores (`stores`,`production_manager`,…) | `'admin', 'plant_head', 'accounts'` |
| shop-floor execution (`shift_supervisor`,`press_operator`,`production_manager`) | `'admin', 'plant_head', 'production', 'design_planning'` |

- [ ] **Step 5: Verify no legacy slugs remain in API gates**

Run:
```bash
grep -rzoE "requireRole\(([^)]|\n)*\)" src/app/api | tr '\0' '\n' | grep -E "'(md|operations_head|production_manager|shift_supervisor|press_operator|qa_officer|qa_manager|stores|procurement_manager|director)'" || echo "CLEAN"
```
Expected: `CLEAN`.

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: no new errors.

```bash
git add src/app/api src/lib/vendor-po-short-close.ts
git commit -m "refactor(rbac): remap API role gates to 5-role model"
```

### Task 7: Update middleware, hub-admin-gate, DashboardShell

**Files:**
- Modify: `src/middleware.ts:27`, `src/lib/hub-admin-gate.ts:3-6`, `src/app/(dashboard)/DashboardShell.tsx:163`.

- [ ] **Step 1: middleware HR gate (`src/middleware.ts:27`)**

Change:
```ts
  if (needsHrRole && token.role !== 'operations_head' && token.role !== 'md') {
```
to:
```ts
  if (needsHrRole && token.role !== 'admin' && token.role !== 'plant_head') {
```

- [ ] **Step 2: hub-admin-gate (`src/lib/hub-admin-gate.ts`)**

Replace the body with:
```ts
import { roleHasFullSystem } from '@/lib/rbac'

/** Tooling Hub staff / settings — full-system roles only (admin, plant_head). */
export function isHubStaffAdmin(role: string | undefined): boolean {
  return roleHasFullSystem(role)
}
```

- [ ] **Step 3: DashboardShell canSeeMasters (`DashboardShell.tsx:163`)**

Change:
```ts
  const canSeeMasters = userRole === 'operations_head' || userRole === 'md'
```
to:
```ts
  const canSeeMasters = userRole === 'admin' || userRole === 'plant_head'
```

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit 2>&1 | tail -10`
```bash
git add src/middleware.ts src/lib/hub-admin-gate.ts "src/app/(dashboard)/DashboardShell.tsx"
git commit -m "refactor(rbac): gate middleware/hub/masters on admin+plant_head"
```

### Task 8: Module-gate the sidebar navigation

**Files:**
- Modify: `src/app/(dashboard)/SidebarNav.tsx` (add per-link/section `module` + filter by `userRole`).

- [ ] **Step 1: Import + tag sections with modules**

At top of `SidebarNav.tsx` add:
```ts
import { hasModuleAccess, roleHasFullSystem, type ModuleKey } from '@/lib/rbac'
```

Add an optional `module?: ModuleKey` to the `NavLink` type and a `module?: ModuleKey` to `NavSection`. Tag links:
- ORDERS: `Customer POs` → `customer_po`, `RFQ Pipeline` → `customer_po`, `Planning` → `planning`, `Artwork Queue` → `artwork_queue`, `Job Cards` → `job_cards`.
- TOOLING HUB section `module: 'tooling_hub'`.
- PRODUCTION EXECUTION (`Print Planning`) → `planning`.
- PRODUCTION section: `Live Production` → `cutting` (visible if cutting OR printing — see filter), `Cutting queue` → `cutting`.
- INVENTORY: `Raw Materials` → `paper_warehouse`; section also full-system. STORES `module:'stores'`, QUALITY `module:'quality'`, DISPATCH `module:'dispatch'`, REPORTS `module:'reports'`, MASTERS `module:'masters'`.
- DASHBOARD section: leave ungated (visible to all logged-in users).

- [ ] **Step 2: Filter links/sections by access**

Replace the `sections.map(...)` render so each section first filters its links:
```ts
const visibleLink = (l: NavLink) => !l.module || hasModuleAccess(userRole, l.module) || roleHasFullSystem(userRole)
```
A section renders only if it has at least one visible link AND (`!section.module || hasModuleAccess(userRole, section.module) || roleHasFullSystem`). Drop the `canSeeMasters` prop usage in favor of `module: 'masters'` gating (keep the prop for back-compat or remove it and its call site in `DashboardShell`/`layout`).

- [ ] **Step 3: Verify in browser (preview)**

Start dev server, log in as `amrinder@ci.local` / `123456` (accounts) → sidebar shows only Dashboard + Customer POs + Paper Warehouse (Raw Materials). Log in as `ankit@ci.local` (production) → only Dashboard + Live Production + Cutting queue. Log in as `ravi@ci.local` (admin) → everything including Masters.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/SidebarNav.tsx" "src/app/(dashboard)/DashboardShell.tsx"
git commit -m "feat(nav): gate sidebar by role module access"
```

---

## Phase 6 — Machine code references (CI-* → new codes)

### Task 9: Replace press-machine filters in API routes

**Files:**
- Modify: `src/app/api/oee/live/route.ts:10`, `dashboard/stats/route.ts:38`, `dashboard/press-status/route.ts:13`, `dashboard/summary/route.ts:49`, `director-command-center/business-vitals/route.ts:94`, `production/machine-flow/route.ts:38`, `jobs/route.ts:36,128`.

- [ ] **Step 1: Replace each `['CI-01', 'CI-02', 'CI-03']` with the shared constant**

In each file add import `import { PRESS_MACHINE_CODES } from '@/lib/master-data'` and replace the inline array. Example (`oee/live/route.ts`):
```ts
where: { machineCode: { in: PRESS_MACHINE_CODES }, status: 'active' },
```
Apply to all 7 files (8 occurrences). For `production/machine-flow/route.ts:38` (`const pressCodes = ['CI-01','CI-02','CI-03']`) → `const pressCodes = PRESS_MACHINE_CODES`.

- [ ] **Step 2: Verify no CI- press arrays remain in api**

Run: `grep -rn "CI-0[123]" src/app/api || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api
git commit -m "refactor(machines): point press filters at PRN-01..03"
```

### Task 10: Replace machine codes in dashboard/production UI

**Files:**
- Modify: `DashboardClient.tsx:110-115`, `_components/DashboardCharts.tsx:31-33`, `director/command-center/page.tsx:460`, `production/machine-flow/page.tsx:31-34,120`, `masters/page.tsx:45`, `masters/dies/[id]/page.tsx:119,172`, `masters/machines/page.tsx:124`, `masters/users/new/page.tsx:134`, `jobs/new/page.tsx:51`.

- [ ] **Step 1: DashboardClient mock waste rows (`:110-115`)**

Replace the six `{ machine: 'CI-0x', pct }` rows with the new codes:
```ts
  { machine: 'PRN-01', pct: 3.2 },
  { machine: 'PRN-02', pct: 4.8 },
  { machine: 'PRN-03', pct: 2.1 },
  { machine: 'COT-01', pct: 5.5 },
  { machine: 'DIE-A01', pct: 1.8 },
  { machine: 'PST-01', pct: 3.9 },
```

- [ ] **Step 2: DashboardCharts legend names (`:31-33`)**

Change `name="CI-01"`→`"PRN-01"`, `CI-02`→`PRN-02`, `CI-03`→`PRN-03` (keep `dataKey` ci01/ci02/ci03 unless the data feed is also renamed — check the data source feeding `ci01..03`; if it is mock, rename consistently).

- [ ] **Step 3: director command-center caption (`:460`)**

Change `CI-01 · CI-02 · CI-03 average (today)` → `PRN-01 · PRN-02 · PRN-03 average (today)`.

- [ ] **Step 4: machine-flow taxonomy (`page.tsx:31-34,120`)**

Replace the four arrays with the new department grouping:
```ts
const PREPRESS: string[] = []
const PRESS = ['PRN-01', 'PRN-02', 'PRN-03']
const POSTPRESS = ['COT-01', 'COT-02']
const FINISHING = ['DIE-A01', 'DIE-A02', 'DIE-A03', 'DIE-M01', 'DIE-M02', 'PST-01', 'PST-02', 'PST-03', 'CUT-01']
```
Update line 120 `machines.filter((m) => m.machineCode === 'CI-10' || m.machineCode === 'CI-12')` — there is no prepress machine now; change to `const prepressItems: typeof machines = []` (and verify the page still renders an empty prepress column gracefully — read surrounding code).

- [ ] **Step 5: masters/page.tsx description (`:45`)**

Change `'CI-01 to CI-12, capacity, waste %, PM dates'` → `'CUT/PRN/COT/DIE/PST machines, capacity, waste %, PM dates'`.

- [ ] **Step 6: masters/dies default machine (`dies/[id]/page.tsx:119,172`)**

Change `useState('CI-06')` → `useState('DIE-A01')`. Replace the `<option>CI-06</option><option>CI-07</option>` with the five die machines:
```tsx
<option>DIE-A01</option><option>DIE-A02</option><option>DIE-A03</option><option>DIE-M01</option><option>DIE-M02</option>
```

- [ ] **Step 7: masters/machines heading (`:124`)**

Change `Machine Master (CI-01 to CI-12)` → `Machine Master`.

- [ ] **Step 8: masters/users label (`new/page.tsx:134`)**

Change `Machine access (CI-01 to CI-12)` → `Machine access`.

- [ ] **Step 9: jobs/new press regex (`:51`)**

Change `m.machineCode.match(/^CI-0[123]$/)` → `m.machineCode.startsWith('PRN-')`.

- [ ] **Step 10: Sweep for any remaining CI- machine refs in src (excluding tests)**

Run: `grep -rn "CI-0\|CI-1[012]" src --include="*.ts" --include="*.tsx" | grep -v "\.test\." || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 11: Typecheck + commit**

```bash
npx tsc --noEmit 2>&1 | tail -10
git add "src/app/(dashboard)"
git commit -m "refactor(machines): replace CI-* codes in UI with new machine master"
```

---

## Phase 7 — Terminal rules wiring on the stage page

### Task 11: Wire terminal rules into the live-production stage page

**Files:**
- Modify: `src/app/(dashboard)/production/stages/[stageKey]/page.tsx` (operator/machine selection UI), and the stage controls API `src/app/api/production/stages/[stageKey]/controls/route.ts` for server-side enforcement.

- [ ] **Step 1: Read the operator + machine selection region**

Run: `sed -n '700,820p' "src/app/(dashboard)/production/stages/[stageKey]/page.tsx"` and locate the operator dropdown (fed via `/api/operator-master?stageKey=...`) and any machine selector. Identify where a stage record is started/pushed.

- [ ] **Step 2: Import the rule + apply to UI**

At top of the page add:
```ts
import { getTerminalRule, resolvePrintingMachine } from '@/lib/production-terminal-rules'
```
Compute `const terminalRule = getTerminalRule(stageKey)` near `stageMeta`. Then:
- **Printing:** hide the machine selector (`terminalRule.machineSelectable === false`); when an operator is chosen, set the machine via `resolvePrintingMachine(operatorName)`; block start if operator empty.
- **Cutting:** hide machine selector; force machine to `terminalRule.fixedMachineCode` (`CUT-01`).
- **Coating/Die/Pasting:** show machine selector populated from `terminalRule.machineCodes`; require both operator and machine before start.
- Use `terminalRule.operatorRequired` / `machineRequired` to gate the Start/Push button (disable + helper text).

- [ ] **Step 3: Server-side enforcement in controls route**

In `controls/route.ts`, on the start/assign action, import `getTerminalRule`/`resolvePrintingMachine` and reject (`400`) when a required operator/machine is missing, and for printing overwrite the machine with the operator's fixed assignment (ignore client-supplied machine).

- [ ] **Step 4: Verify in browser (preview)**

Log in as admin; open `/production/stages/printing` → no machine dropdown, selecting "Modi" shows PRN-02 locked; `/production/stages/cutting` → machine shown as CUT-01, no select; `/production/stages/chemical_coating` → operator (Parkash/Raja) + machine (COT-01/02) both required; `/production/stages/dye_cutting` → 6 operators + 5 DIE machines; `/production/stages/pasting` → 3 operators + 3 PST machines.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/production/stages/[stageKey]/page.tsx" "src/app/api/production/stages/[stageKey]/controls/route.ts"
git commit -m "feat(production): enforce per-terminal operator/machine rules"
```

---

## Phase 8 — Tests & legacy scripts

### Task 12: Fix tests referencing legacy machine codes / roles

**Files:**
- Modify: `src/lib/reports/format.test.ts`, `src/lib/reports/modules/{pm-compliance,yield,oee}.test.ts`, `src/components/planning/engine/SectionBatchDecision.test.tsx`.

- [ ] **Step 1: Find legacy refs in tests**

Run: `grep -rn "CI-0\|CI-1[012]\|'md'\|operations_head\|press_operator\|shift_supervisor" src --include="*.test.ts" --include="*.test.tsx"`

- [ ] **Step 2: Update each occurrence** to a new machine code (`PRN-01` for press, `DIE-A01` for die, etc.) or new role slug (`admin`, `production`, …) consistent with the assertion's intent. Show the new literal in each edit.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run 2>&1 | tail -30`
Expected: PASS (minus any pre-existing failures recorded in Task 0).

- [ ] **Step 4: Commit**

```bash
git add src
git commit -m "test: update fixtures to new machine codes and roles"
```

### Task 13: Retire / update legacy migration scripts

**Files:**
- Modify/Delete: `scripts/legacy-role-map.ts`, `scripts/remap-legacy-roles.ts`, `scripts/migrate-machinery-operators.ts`, `scripts/reset-admin.ts`.

- [ ] **Step 1: Decide per script**

- `scripts/reset-admin.ts` — update to reset one of the new admin emails (e.g. `ravi@ci.local`) with PIN `123456`; verify the role slug it assigns is `admin`.
- `scripts/legacy-role-map.ts` + `scripts/remap-legacy-roles.ts` + `scripts/migrate-machinery-operators.ts` — these encode the old slug system and are now misleading. Delete them (they are dev/import tooling, not imported by the app — confirm with `grep -rn "legacy-role-map\|remap-legacy-roles\|migrate-machinery-operators" src scripts`).

- [ ] **Step 2: Confirm nothing imports the deleted scripts**

Run: `grep -rn "legacy-role-map\|remap-legacy-roles\|migrate-machinery-operators" src scripts package.json || echo CLEAN`
Expected: `CLEAN` after deletion.

- [ ] **Step 3: Commit**

```bash
git add -A scripts
git commit -m "chore(scripts): retire legacy role/operator migration tooling"
```

---

## Phase 9 — Destructive wipe + reload script

### Task 14: Write `scripts/replace-master-data.ts`

**Files:**
- Create: `scripts/replace-master-data.ts`

- [ ] **Step 1: Write the guarded script**

```ts
/**
 * replace-master-data.ts — DESTRUCTIVE. Wipes legacy users, operators, roles,
 * machines, and reloads the new master set (delegates to prisma/seed.ts logic).
 *
 *   npx tsx scripts/replace-master-data.ts            # dry-run (counts only)
 *   npx tsx scripts/replace-master-data.ts --confirm  # APPLY
 *
 * FK notes (from schema):
 *  - production_job_card.machine_id / shift_operator_user_id: nullable / SetNull.
 *  - audit_log.user_id: SetNull. preventive_maintenance_logs.verified_by_user_id: SetNull.
 *  - Job.createdBy/closedBy etc. reference User — verify onDelete before deleting users
 *    that are referenced; if Restrict, null those columns first.
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { MACHINES, LOGIN_USERS, OPERATORS, DEFAULT_USER_PIN } from '../src/lib/master-data'

const db = new PrismaClient()
const APPLY = process.argv.includes('--confirm')

async function main() {
  const [users, ops, machines, roles] = await Promise.all([
    db.user.count(), db.operatorMaster.count(), db.machine.count(), db.role.count(),
  ])
  console.log('Before:', { users, ops, machines, roles })
  if (!APPLY) {
    console.log('DRY-RUN. Re-run with --confirm to wipe and reload.')
    return
  }

  await db.$transaction(async (tx) => {
    // Order matters: clear join + dependent rows first.
    await tx.operatorStationAssignment.deleteMany({})
    await tx.operatorMaster.deleteMany({})
    // Null user-referencing columns that are Restrict before deleting users (verify per schema).
    await tx.user.deleteMany({})
    await tx.role.deleteMany({})
    // Machines: only delete those NOT referenced by jobs/ledgers, else null refs first.
    await tx.machine.deleteMany({})
  })
  console.log('Wiped. Now reloading via seed...')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
```

- [ ] **Step 2: Reload after wipe**

After the wipe, run the seed to repopulate: the script's reload can either `import { execSync }` to run `npx tsx prisma/seed.ts`, or duplicate the upsert loops. Prefer: wipe in this script, then run `npx tsx prisma/seed.ts` as a separate documented step (seed is idempotent upserts).

- [ ] **Step 3: Dry-run only (no apply yet)**

Run: `npx tsx scripts/replace-master-data.ts`
Expected: prints before-counts + "DRY-RUN".

- [ ] **Step 4: Commit**

```bash
git add scripts/replace-master-data.ts
git commit -m "feat(scripts): guarded destructive master-data wipe+reload"
```

---

## Phase 10 — Verification & cutover

### Task 15: Full local verification

- [ ] **Step 1: Typecheck + lint + tests**

Run: `npx tsc --noEmit && npx vitest run && npx next lint 2>&1 | tail -20`
Expected: clean (minus Task 0 pre-existing).

- [ ] **Step 2: Local DB smoke (against a dev/branch DB, NOT prod)**

Run: `npx tsx prisma/seed.ts` then `npx prisma studio` — verify 5 roles, 14 machines, 7 users, 14 operators.

- [ ] **Step 3: Login + nav smoke (preview)**

Log in as each of: `ravi@ci.local` (admin → full nav + masters), `amrinder@ci.local` (accounts → Customer PO + Paper Warehouse only), `avneet@ci.local` (design → planning/artwork/job cards/cutting/printing), `ankit@ci.local` (production → cutting/printing only). PIN `123456`.

- [ ] **Step 4: Terminal smoke** — re-run Task 11 Step 4 checklist.

- [ ] **Step 5: Final residual sweep**

Run:
```bash
grep -rn "CI-0\|CI-1[012]" src prisma --include="*.ts" --include="*.tsx" | grep -v "\.test\." || echo "MACHINES CLEAN"
grep -rzoE "requireRole\(([^)]|\n)*\)" src/app/api | tr '\0' '\n' | grep -E "'(md|operations_head|production_manager|shift_supervisor|press_operator|qa_officer|qa_manager|stores|procurement_manager|director)'" || echo "ROLES CLEAN"
```
Expected: both CLEAN.

### Task 16: Production cutover (REQUIRES EXPLICIT USER GO-AHEAD)

- [ ] **Step 1: Confirm DB target + take a Supabase backup/branch.**
- [ ] **Step 2:** `npx tsx scripts/replace-master-data.ts` (dry-run) → review counts with user.
- [ ] **Step 3:** `npx tsx scripts/replace-master-data.ts --confirm` then `npx tsx prisma/seed.ts`.
- [ ] **Step 4:** Verify prod login as `ravi@ci.local` / `123456`; instruct all users to change PIN.
- [ ] **Step 5:** Deploy code (`vercel --prod` from the deploy branch per repo convention).

---

## Self-Review notes
- **Spec coverage:** users (Task 4), operators (Task 4), roles/permissions (Tasks 2,5,6,7,8), machines (Tasks 1,4,9,10), terminals/rules (Tasks 3,11), seed/mock data (Tasks 4,10,12), DB wipe (Task 14,16), legacy removal (Tasks 6,9,10,12,13). ✔
- **Open risk to confirm during execution:** `Machine`/`User` `onDelete` behavior for FK columns referenced by `Job`, `BomLine`, `JobStage`, `WasteRecord`, etc. Task 14 Step 1 calls this out — verify in `schema.prisma` before `--confirm`; null Restrict columns first or the delete will throw.
- **Cutting operators:** master data lists no cutting-terminal operators; terminal rule makes operator optional for cutting (machine fixed CUT-01). Confirm acceptable.
