import { db } from '@/lib/db'

const DEFAULT_MAX_IMPRESSIONS: Record<string, number> = {
  Brass: 200_000,
  Copper: 150_000,
  Polymer: 50_000,
  Magnesium: 100_000,
}

export function getDefaultMaxImpressions(material: string): number {
  return DEFAULT_MAX_IMPRESSIONS[material] ?? 100_000
}

export async function calculateTotalImpressions(blockId: string): Promise<number> {
  const result = await db.blockTransaction.aggregate({
    where: { blockId, type: 'PRODUCTION' },
    _sum: { impressionsCount: true },
  })
  return result._sum.impressionsCount ?? 0
}

export async function getChainOfCustody(blockId: string) {
  return db.blockTransaction.findMany({
    where: { blockId, type: { in: ['ISSUE', 'RETURN'] } },
    orderBy: { createdAt: 'asc' },
  })
}

export async function getLifecycleTimeline(blockId: string) {
  return db.blockTransaction.findMany({
    where: { blockId },
    orderBy: { createdAt: 'asc' },
  })
}

export async function getCurrentHolder(blockId: string) {
  const lastIssue = await db.blockTransaction.findFirst({
    where: { blockId, type: 'ISSUE' },
    orderBy: { createdAt: 'desc' },
  })
  if (!lastIssue) return null

  const returnedAfter = await db.blockTransaction.findFirst({
    where: {
      blockId,
      type: 'RETURN',
      createdAt: { gt: lastIssue.createdAt },
    },
  })
  if (returnedAfter) return null

  return { operatorId: lastIssue.operatorId, issuedAt: lastIssue.createdAt }
}

export async function replaceBlock(
  oldBlockId: string,
  newBlockCode: string,
  opts: {
    blockType: string
    blockMaterial: string
    destroyReason: string
    supervisorId: string
    operatorId: string
  },
) {
  const oldBlock = await db.embossBlock.findUnique({ where: { id: oldBlockId } })
  if (!oldBlock) throw new Error('Block not found')
  if (!oldBlock.active) throw new Error('Block is already inactive/destroyed')

  const existing = await db.embossBlock.findUnique({ where: { blockCode: newBlockCode } })
  if (existing) throw new Error(`Block code "${newBlockCode}" already exists`)

  return db.$transaction(async (tx) => {
    await tx.embossBlock.update({
      where: { id: oldBlockId },
      data: {
        active: false,
        destroyedAt: new Date(),
        destroyReason: opts.destroyReason,
        condition: 'Destroyed',
      },
    })

    await tx.blockTransaction.create({
      data: {
        blockId: oldBlockId,
        type: 'DESTRUCTION',
        operatorId: opts.operatorId,
        supervisorId: opts.supervisorId,
        condition: 'Destroyed',
        notes: opts.destroyReason,
      },
    })

    const newBlock = await tx.embossBlock.create({
      data: {
        blockCode: newBlockCode,
        cartonId: oldBlock.cartonId,
        cartonName: oldBlock.cartonName,
        customerId: oldBlock.customerId,
        blockType: opts.blockType || oldBlock.blockType,
        blockMaterial: opts.blockMaterial || oldBlock.blockMaterial,
        blockSize: oldBlock.blockSize,
        embossDepth: oldBlock.embossDepth,
        storageLocation: oldBlock.storageLocation,
        maxImpressions: getDefaultMaxImpressions(opts.blockMaterial || oldBlock.blockMaterial),
        condition: 'Good',
        manufactureDate: new Date(),
        parentBlockId: oldBlockId,
        replacesBlockId: oldBlockId,
      },
    })

    return { oldBlock: { id: oldBlockId, blockCode: oldBlock.blockCode }, newBlock }
  })
}

export async function getPendingReturns() {
  const openIssues = await db.blockTransaction.findMany({
    where: { type: 'ISSUE' },
    orderBy: { createdAt: 'desc' },
    distinct: ['blockId'],
  })

  const pending: typeof openIssues = []
  for (const issue of openIssues) {
    const returned = await db.blockTransaction.findFirst({
      where: {
        blockId: issue.blockId,
        type: 'RETURN',
        createdAt: { gt: issue.createdAt },
      },
    })
    if (!returned) pending.push(issue)
  }

  return pending
}
