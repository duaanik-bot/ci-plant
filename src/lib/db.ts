// src/lib/db.ts — Prisma client singleton
import { PrismaClient } from '@prisma/client'

// --- Global BigInt JSON serialization fix ---
// Postgres BIGINT columns (e.g. Machine.usageImpressionsSincePm) come back from
// Prisma as native BigInt, which JSON.stringify / NextResponse.json cannot
// serialize ("TypeError: Do not know how to serialize a BigInt"). Teach BigInt
// how to serialize: as a Number when within safe-integer range, otherwise as a
// string to avoid silent precision loss. Installed here because db.ts is imported
// by every route that returns database data.
if (typeof (BigInt.prototype as unknown as { toJSON?: unknown }).toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function (this: bigint) {
      return this >= BigInt(Number.MIN_SAFE_INTEGER) && this <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(this)
        : this.toString()
    },
    writable: true,
    configurable: true,
  })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

function missingDelegate(modelName: string) {
  return {
    count: async () => 0,
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    aggregate: async () => ({}),
    groupBy: async () => [],
    create: async () => {
      throw new Error(`Model "${modelName}" is not available in this database schema`)
    },
    createMany: async () => {
      throw new Error(`Model "${modelName}" is not available in this database schema`)
    },
    update: async () => {
      throw new Error(`Model "${modelName}" is not available in this database schema`)
    },
    updateMany: async () => {
      throw new Error(`Model "${modelName}" is not available in this database schema`)
    },
    upsert: async () => {
      throw new Error(`Model "${modelName}" is not available in this database schema`)
    },
    delete: async () => {
      throw new Error(`Model "${modelName}" is not available in this database schema`)
    },
    deleteMany: async () => {
      throw new Error(`Model "${modelName}" is not available in this database schema`)
    },
  }
}

export const db = new Proxy(prisma as unknown as Record<string, unknown>, {
  get(target, prop, receiver) {
    if (Reflect.has(target, prop)) {
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(prisma) : value
    }
    if (typeof prop === 'string') return missingDelegate(prop)
    return undefined
  },
}) as unknown as PrismaClient
