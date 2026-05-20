/**
 * migrate-machinery-operators.ts — wipe & reload Roles, Users, OperatorMaster,
 * and the new OperatorStationAssignment join from the
 * "machinery_operators_migration.xlsx" workbook.
 *
 *   npx tsx scripts/migrate-machinery-operators.ts <path.xlsx>            # dry-run
 *   npx tsx scripts/migrate-machinery-operators.ts <path.xlsx> --confirm  # apply
 *
 * Notes:
 *  - `machines` table is left untouched (sheet's "Machines" are production
 *    departments and map to PRODUCTION_STAGES keys, not the CI-01..12 press
 *    Machine rows used by Job/OEE).
 *  - User.pinHash placeholder = bcrypt('0000'). Users must reset on first login.
 *  - Role.permissions placeholder by role; the app's required system roles
 *    (md, operations_head, …) are seeded alongside the sheet's role names so
 *    requireRole() gates still resolve.
 *  - audit_log.user_id and production_job_card.machine_id/shift_operator_user_id
 *    are nullable / onDelete:SetNull — wipe will null those refs, not cascade.
 */
import { PrismaClient } from '@prisma/client'
import * as XLSX from 'xlsx'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()

const norm = (s: unknown) => String(s ?? '').trim()
const lower = (s: unknown) => norm(s).toLowerCase()

/** Department name (as written in sheet) → PRODUCTION_STAGES key. */
const DEPT_TO_STAGE: Record<string, string> = {
  cutting: 'cutting',
  printing: 'printing',
  'chemical coating': 'chemical_coating',
  coating: 'chemical_coating',
  lamination: 'lamination',
  embossing: 'embossing',
  leafing: 'leafing',
  'spot uv': 'spot_uv',
  'dye cutting': 'dye_cutting',
  pasting: 'pasting',
}

/** App-code role names referenced by requireRole() — must exist or gates deny. */
const SYSTEM_GATE_ROLES = [
  'md',
  'operations_head',
  'production_manager',
  'shift_supervisor',
  'press_operator',
  'procurement_manager',
  'stores',
  'qa_manager',
  'qa_officer',
]

/** Coarse permission JSON by role display/system name. Refine in Settings later. */
function permsFor(roleName: string): Record<string, boolean> {
  const r = roleName.toLowerCase()
  if (r === 'root' || r === 'md' || r === 'super admin') {
    return { all: true }
  }
  if (r === 'admin' || r === 'plant head' || r === 'manager' || r === 'operations_head') {
    return { read: true, write: true, approve: true }
  }
  return { read: true, write: true }
}

/** Header rows in the workbook are at sheet row 0 (offset 1 = header, data starts at 2). */
function rows(ws: XLSX.WorkSheet): any[][] {
  return XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: null, blankrows: false })
}

async function main() {
  const file = process.argv[2]
  const confirm = process.argv.includes('--confirm')
  if (!file) {
    console.error('Provide path to xlsx')
    process.exit(1)
  }

  const wb = XLSX.readFile(file)
  const sRoles = rows(wb.Sheets['Roles'])
  const sUsers = rows(wb.Sheets['System Users'])
  const sMachines = rows(wb.Sheets['Machines'])
  const sOperators = rows(wb.Sheets['Operators'])

  // (Machines sheet not needed — operator rows carry the department name directly,
  // and stage keys come from PRODUCTION_STAGES via DEPT_TO_STAGE.)
  void sMachines

  // ── Roles ────────────────────────────────────────────────────────────────
  type RoleSeed = { roleName: string; permissions: Record<string, boolean> }
  const roleSeeds: RoleSeed[] = []
  const seenRole = new Set<string>()
  // sheet Role ID → system role name (for resolving users)
  const roleNameByEitherName = new Map<string, string>()
  const roleNameById = new Map<number, string>()
  for (let i = 2; i < sRoles.length; i++) {
    const r = sRoles[i]
    const id = Number(r?.[0])
    const sys = norm(r?.[1])
    const disp = norm(r?.[2])
    if (!sys) continue
    if (!seenRole.has(sys)) {
      seenRole.add(sys)
      roleSeeds.push({ roleName: sys, permissions: permsFor(sys) })
    }
    if (Number.isFinite(id)) roleNameById.set(id, sys)
    roleNameByEitherName.set(lower(sys), sys)
    if (disp) roleNameByEitherName.set(lower(disp), sys)
  }
  for (const sys of SYSTEM_GATE_ROLES) {
    if (seenRole.has(sys)) continue
    seenRole.add(sys)
    roleSeeds.push({ roleName: sys, permissions: permsFor(sys) })
  }

  // ── Users ────────────────────────────────────────────────────────────────
  type UserSeed = {
    name: string
    email: string
    pinHash: string
    roleName: string
    active: boolean
  }
  const pinHash = await bcrypt.hash('0000', 10)
  const userSeeds: UserSeed[] = []
  const seenEmail = new Set<string>()
  const unresolvedUserRoles: string[] = []
  for (let i = 2; i < sUsers.length; i++) {
    const r = sUsers[i]
    const name = norm(r?.[1])
    const email = lower(r?.[2])
    const roleId = Number(r?.[3])
    const roleLabel = norm(r?.[4]) // may be display OR system name
    const status = lower(r?.[5])
    if (!name || !email) continue
    if (seenEmail.has(email)) continue
    const roleSys =
      (Number.isFinite(roleId) && roleNameById.get(roleId)) ||
      roleNameByEitherName.get(lower(roleLabel)) ||
      ''
    if (!roleSys || !seenRole.has(roleSys)) {
      unresolvedUserRoles.push(`${email} → roleId=${r?.[3]} label="${roleLabel}"`)
      continue
    }
    seenEmail.add(email)
    userSeeds.push({
      name,
      email,
      pinHash,
      roleName: roleSys,
      active: status === 'active',
    })
  }

  // ── Operators + assignments ──────────────────────────────────────────────
  type AssignSeed = { name: string; stageKey: string; active: boolean }
  const opAssign: AssignSeed[] = []
  const operatorNames = new Map<string, boolean>() // name → isActive
  const unresolvedOpStations: string[] = []
  for (let i = 2; i < sOperators.length; i++) {
    const r = sOperators[i]
    const opName = norm(r?.[1])
    const dept = lower(r?.[2])
    const status = lower(r?.[4])
    if (!opName) continue
    const isActive = status === 'active'
    const prev = operatorNames.get(opName)
    operatorNames.set(opName, prev === undefined ? isActive : prev || isActive)
    const stageKey = DEPT_TO_STAGE[dept]
    if (!stageKey) {
      unresolvedOpStations.push(`${opName} (dept "${r?.[2]}")`)
      continue
    }
    opAssign.push({ name: opName, stageKey, active: isActive })
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log('\n=== MIGRATION PLAN ===')
  console.log(`Roles to seed:        ${roleSeeds.length} (sheet + ${SYSTEM_GATE_ROLES.length} system gate roles)`)
  console.log(`Users to seed:        ${userSeeds.length}`)
  console.log(`Operators to seed:    ${operatorNames.size}`)
  console.log(`Operator assignments: ${opAssign.length}`)
  if (unresolvedUserRoles.length) {
    console.log('\n[skip] users whose role does not exist:')
    unresolvedUserRoles.forEach((s) => console.log('  -', s))
  }
  if (unresolvedOpStations.length) {
    console.log('\n[skip] operator rows with unmapped department:')
    unresolvedOpStations.forEach((s) => console.log('  -', s))
  }
  console.log('\nWipe order: operator_station_assignment → users → roles → operator_master')
  console.log('Leave untouched: machines (departments != CI-presses)')

  if (!confirm) {
    console.log('\nDry-run only. Re-run with --confirm to apply.')
    await db.$disconnect()
    return
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  console.log('\n=== APPLYING ===')
  await db.$transaction(
    async (tx) => {
      // Wipe (order matters for FKs)
      await tx.operatorStationAssignment.deleteMany({})
      await tx.user.deleteMany({})
      await tx.role.deleteMany({})
      await tx.operatorMaster.deleteMany({})

      // Roles
      await tx.role.createMany({
        data: roleSeeds.map((r) => ({
          roleName: r.roleName,
          permissions: r.permissions,
        })),
      })
      const allRoles = await tx.role.findMany({ select: { id: true, roleName: true } })
      const roleIdByName = new Map(allRoles.map((r) => [r.roleName, r.id]))

      // Users
      await tx.user.createMany({
        data: userSeeds.map((u) => ({
          name: u.name,
          email: u.email,
          pinHash: u.pinHash,
          roleId: roleIdByName.get(u.roleName)!,
          active: u.active,
        })),
      })

      // Operators
      const opData = Array.from(operatorNames.entries()).map(([name, isActive]) => ({
        name,
        isActive,
      }))
      await tx.operatorMaster.createMany({ data: opData })
      const allOps = await tx.operatorMaster.findMany({ select: { id: true, name: true } })
      const opIdByName = new Map(allOps.map((o) => [o.name, o.id]))

      // Assignments
      await tx.operatorStationAssignment.createMany({
        data: opAssign
          .map((a) => ({ operatorId: opIdByName.get(a.name)!, stageKey: a.stageKey }))
          .filter((a) => a.operatorId),
        skipDuplicates: true,
      })
    },
    { timeout: 60_000 },
  )

  const [roles, users, ops, assigns] = await Promise.all([
    db.role.count(),
    db.user.count(),
    db.operatorMaster.count(),
    db.operatorStationAssignment.count(),
  ])
  console.log(`\n✓ Applied. roles=${roles} users=${users} operators=${ops} assignments=${assigns}`)
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
