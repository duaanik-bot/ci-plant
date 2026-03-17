import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const hash = await bcrypt.hash('123456', 10)
  await prisma.user.upsert({
    where: { email: 'dua.anik@gmail.com' },
    update: { pinHash: hash, active: true },
    create: {
      name: 'Anik Dua',
      email: 'dua.anik@gmail.com',
      pinHash: hash,
      active: true,
      roleId: (await prisma.role.findFirst({ where: { roleName: 'md' } }))!.id,
    },
  })
  console.log('✅ PIN reset to 123456')
  console.log('Hash:', hash)
}

main().catch(console.error).finally(() => prisma.$disconnect())
