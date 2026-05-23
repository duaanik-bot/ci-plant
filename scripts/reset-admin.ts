import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const email = 'ravi@ci.local'
  const name = 'Ravi'
  const pin = '123456'
  const roleName = 'admin'

  const hash = await bcrypt.hash(pin, 12)

  // Look up the admin role record
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } })

  // Upsert the admin user, linking to the admin role and resetting PIN
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, roleId: role.id, pinHash: hash },
    update: { name, roleId: role.id, pinHash: hash },
  })

  console.log('Admin reset for:', user.email)
  console.log('Role:', roleName, '(id:', role.id + ')')
  console.log('New hash:', hash)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
