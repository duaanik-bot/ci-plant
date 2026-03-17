import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const hash = await bcrypt.hash('123456', 10)
  const user = await prisma.user.update({
    where: { email: 'dua.anik@gmail.com' },
    data: { pinHash: hash },
  })
  console.log('PIN reset for:', user.email)
  console.log('New hash:', hash)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
