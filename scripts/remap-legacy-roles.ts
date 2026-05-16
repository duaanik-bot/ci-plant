/**
 * One-shot maintenance: reassign existing users from legacy CSV role names
 * onto canonical RBAC slugs. Idempotent — safe to re-run. Use after a legacy
 * import that pre-dates the canonical role-mapping patch in the importers.
 *
 *   npx tsx scripts/remap-legacy-roles.ts
 */
import { PrismaClient } from '@prisma/client'
import { LEGACY_ROLE_MAP, USER_ROLE_OVERRIDES } from './legacy-role-map'

const prisma = new PrismaClient()

async function main() {
  const targetSlugs = Array.from(
    new Set([...Object.values(LEGACY_ROLE_MAP), ...Object.values(USER_ROLE_OVERRIDES)]),
  )
  const canonical = await prisma.role.findMany({ where: { roleName: { in: targetSlugs } } })
  const canonId = new Map(canonical.map((r) => [r.roleName, r.id]))
  for (const slug of targetSlugs) {
    if (!canonId.has(slug)) throw new Error(`Canonical role missing in DB: ${slug} — run prisma/seed.ts first`)
  }

  const users = await prisma.user.findMany({ include: { role: true } })
  let moved = 0
  const unmapped = new Set<string>()
  for (const u of users) {
    const current = u.role?.roleName ?? ''
    if (canonId.has(current) && !USER_ROLE_OVERRIDES[u.email]) continue // already canonical
    const targetSlug = USER_ROLE_OVERRIDES[u.email] ?? LEGACY_ROLE_MAP[current]
    if (!targetSlug) {
      unmapped.add(current)
      continue
    }
    const targetId = canonId.get(targetSlug)!
    if (u.roleId === targetId) continue
    await prisma.user.update({ where: { id: u.id }, data: { roleId: targetId } })
    console.log(`  ${u.email.padEnd(34)} ${current.padEnd(16)} -> ${targetSlug}`)
    moved++
  }
  console.log(`\n${moved} users remapped.`)
  if (unmapped.size) console.log('UNMAPPED legacy roles still on users:', Array.from(unmapped))

  const after = await prisma.role.findMany({
    where: { users: { some: {} } },
    select: { roleName: true, _count: { select: { users: true } } },
    orderBy: { roleName: 'asc' },
  })
  console.log('\nRoles in use after remap:')
  after.forEach((r) => console.log(`  ${r.roleName}  (${r._count.users})`))
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
