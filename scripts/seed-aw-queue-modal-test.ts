import fs from 'node:fs'
import { Prisma, PrismaClient } from '@prisma/client'

type EnvMap = Record<string, string>

function readEnvFile(path: string): EnvMap {
  if (!fs.existsSync(path)) return {}
  const out: EnvMap = {}
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    out[key] = value
  }
  return out
}

const envFromFiles = {
  ...readEnvFile('.env'),
  ...readEnvFile('.env.local'),
}

for (const [key, value] of Object.entries(envFromFiles)) {
  if (!process.env[key]) process.env[key] = value
}

function hostnameOf(value: string | undefined): string {
  if (!value) return ''
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function assertSafeTarget() {
  if (process.env.ALLOW_AW_QUEUE_MODAL_SEED !== '1') {
    throw new Error('Refusing to seed. Set ALLOW_AW_QUEUE_MODAL_SEED=1 to confirm this is a local/dev database.')
  }

  const databaseUrl = process.env.DATABASE_URL
  const host = hostnameOf(databaseUrl)
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.')
  if (host.includes('neon.tech')) {
    throw new Error(`Refusing to seed Neon database host (${host}). Use a local/dev database instead.`)
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'db', 'postgres', 'host.docker.internal'])
  if (!localHosts.has(host)) {
    throw new Error(`Refusing to seed non-local database host (${host}). Point DATABASE_URL to local/dev first.`)
  }
}

const prisma = new PrismaClient()

const CUSTOMER_ID = 'aw-modal-qa-customer'
const PO_ID = 'aw-modal-qa-po'
const PO_NUMBER = 'AW-MODAL-QA-PO-001'

const rows = [
  {
    id: 'aw-modal-qa-line-ready',
    cartonName: 'QA READY CARTON 60ML',
    quantity: 8500,
    artworkCode: 'AW-QA-READY',
    setNumber: '8719',
    jobCardNumber: 990201,
    planningStatus: 'job_card_created',
    paperType: 'Duplex GB',
    coatingType: 'Spot UV',
    embossingLeafing: 'Emboss + Foil',
    gsm: 350,
    specOverrides: {
      sheetSize: '24.6x31.2',
      actualSheetSize: '24.6x31.2',
      ups: 2,
      dieNumber: 'DIE-QA-READY',
      embossBlockNumber: 'EMB-QA-READY',
      colorSpec: 'CMYK + Pantone Blue',
      customerApprovalPharma: true,
      shadeCardQaTextApproval: true,
      planningDesignerDisplayName: 'QA Designer',
      awNotes: 'QA seed row: fully ready modal test item.',
    },
    jobCard: {
      artworkApproved: true,
      firstArticlePass: true,
      fileUrl: '/qa-fixtures/aw-modal-ready-artwork.pdf',
    },
  },
  {
    id: 'aw-modal-qa-line-missing',
    cartonName: 'QA MISSING TOOLING CARTON',
    quantity: 4200,
    artworkCode: 'AW-QA-MISSING',
    setNumber: '8720',
    jobCardNumber: 990202,
    planningStatus: 'job_card_created',
    paperType: 'SBS',
    coatingType: 'Aqueous',
    embossingLeafing: 'Emboss',
    gsm: 300,
    specOverrides: {
      sheetSize: '23x36',
      actualSheetSize: '23x36',
      ups: 4,
      dieNumber: null,
      embossBlockNumber: null,
      colorSpec: 'CMYK',
      customerApprovalPharma: true,
      shadeCardQaTextApproval: true,
      planningDesignerDisplayName: 'QA Designer',
      awNotes: 'QA seed row: die and emboss block intentionally missing.',
    },
    jobCard: {
      artworkApproved: true,
      firstArticlePass: false,
      fileUrl: '/qa-fixtures/aw-modal-missing-artwork.pdf',
    },
  },
  {
    id: 'aw-modal-qa-line-pending',
    cartonName: 'QA PENDING ARTWORK CARTON',
    quantity: 3100,
    artworkCode: null,
    setNumber: '8721',
    jobCardNumber: null,
    planningStatus: 'design_ready',
    paperType: 'Duplex GB',
    coatingType: 'Matte Lamination',
    embossingLeafing: 'None',
    gsm: 280,
    specOverrides: {
      sheetSize: '20x30',
      actualSheetSize: '20x30',
      ups: 1,
      dieNumber: 'DIE-QA-PENDING',
      embossBlockNumber: null,
      colorSpec: '',
      customerApprovalPharma: false,
      shadeCardQaTextApproval: false,
      revisionRequired: true,
      planningDesignerDisplayName: 'QA Designer',
      awNotes: 'QA seed row: artwork code and job card intentionally pending.',
    },
    jobCard: null,
  },
] as const

async function main() {
  assertSafeTarget()

  const user = await prisma.user.findFirst({ select: { id: true } })
  if (!user) throw new Error('No user found. Run the normal seed first.')

  await prisma.customer.upsert({
    where: { id: CUSTOMER_ID },
    update: {
      name: 'AW Modal QA Customer',
      requiresArtworkApproval: true,
      active: true,
    },
    create: {
      id: CUSTOMER_ID,
      name: 'AW Modal QA Customer',
      requiresArtworkApproval: true,
      active: true,
    },
  })

  await prisma.purchaseOrder.upsert({
    where: { id: PO_ID },
    update: {
      poNumber: PO_NUMBER,
      customerId: CUSTOMER_ID,
      poDate: new Date(),
      status: 'confirmed',
      createdBy: user.id,
      remarks: 'Manual local/dev QA seed for AW Queue modal.',
    },
    create: {
      id: PO_ID,
      poNumber: PO_NUMBER,
      customerId: CUSTOMER_ID,
      poDate: new Date(),
      status: 'confirmed',
      createdBy: user.id,
      remarks: 'Manual local/dev QA seed for AW Queue modal.',
    },
  })

  for (const row of rows) {
    if (row.jobCard && row.jobCardNumber) {
      await prisma.productionJobCard.upsert({
        where: { jobCardNumber: row.jobCardNumber },
        update: {
          customerId: CUSTOMER_ID,
          requiredSheets: row.quantity,
          totalSheets: row.quantity,
          wastageSheets: 0,
          artworkApproved: row.jobCard.artworkApproved,
          firstArticlePass: row.jobCard.firstArticlePass,
          status: 'design_ready',
          fileUrl: row.jobCard.fileUrl,
          setNumber: row.setNumber,
        },
        create: {
          jobCardNumber: row.jobCardNumber,
          customerId: CUSTOMER_ID,
          requiredSheets: row.quantity,
          totalSheets: row.quantity,
          wastageSheets: 0,
          artworkApproved: row.jobCard.artworkApproved,
          firstArticlePass: row.jobCard.firstArticlePass,
          status: 'design_ready',
          fileUrl: row.jobCard.fileUrl,
          setNumber: row.setNumber,
        },
      })
    }

    await prisma.poLineItem.upsert({
      where: { id: row.id },
      update: {
        poId: PO_ID,
        cartonName: row.cartonName,
        quantity: row.quantity,
        artworkCode: row.artworkCode,
        setNumber: row.setNumber,
        jobCardNumber: row.jobCardNumber,
        planningStatus: row.planningStatus,
        paperType: row.paperType,
        coatingType: row.coatingType,
        embossingLeafing: row.embossingLeafing,
        gsm: row.gsm,
        remarks: `AW modal QA seed: ${row.cartonName}`,
        specOverrides: row.specOverrides as Prisma.InputJsonValue,
      },
      create: {
        id: row.id,
        poId: PO_ID,
        cartonName: row.cartonName,
        quantity: row.quantity,
        artworkCode: row.artworkCode,
        setNumber: row.setNumber,
        jobCardNumber: row.jobCardNumber,
        planningStatus: row.planningStatus,
        paperType: row.paperType,
        coatingType: row.coatingType,
        embossingLeafing: row.embossingLeafing,
        gsm: row.gsm,
        remarks: `AW modal QA seed: ${row.cartonName}`,
        specOverrides: row.specOverrides as Prisma.InputJsonValue,
      },
    })

    await prisma.materialQueue.upsert({
      where: { poLineItemId: row.id },
      update: {
        purchaseOrderId: PO_ID,
        boardType: row.paperType,
        gsm: row.gsm,
        grainDirection: 'Long grain',
        sheetLengthMm: new Prisma.Decimal(620),
        sheetWidthMm: new Prisma.Decimal(790),
        ups: Number(row.specOverrides.ups) || 1,
        wastagePct: new Prisma.Decimal(2),
        orderQty: row.quantity,
        totalSheets: row.quantity,
        totalWeightKg: new Prisma.Decimal(0),
      },
      create: {
        purchaseOrderId: PO_ID,
        poLineItemId: row.id,
        boardType: row.paperType,
        gsm: row.gsm,
        grainDirection: 'Long grain',
        sheetLengthMm: new Prisma.Decimal(620),
        sheetWidthMm: new Prisma.Decimal(790),
        ups: Number(row.specOverrides.ups) || 1,
        wastagePct: new Prisma.Decimal(2),
        orderQty: row.quantity,
        totalSheets: row.quantity,
        totalWeightKg: new Prisma.Decimal(0),
      },
    })
  }

  console.log(JSON.stringify({
    ok: true,
    poNumber: PO_NUMBER,
    rows: rows.map((row) => ({
      id: row.id,
      cartonName: row.cartonName,
      jobCardNumber: row.jobCardNumber,
      planningStatus: row.planningStatus,
    })),
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
