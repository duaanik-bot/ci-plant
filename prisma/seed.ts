// prisma/seed.ts
// Run with: npx prisma db seed
// Seeds: 5 roles, 14 machines, 13 QC instruments, 7 login users, 14 operators

import { Prisma, PrismaClient, PastingStyle } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { MACHINES, LOGIN_USERS, OPERATORS, DEFAULT_USER_PIN } from '../src/lib/master-data'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding Colour Impressions Plant System...')

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

  const OFFSET_PM_CHECKLIST = [
    'Lockout/tagout verified; energy isolation documented',
    'Wash blankets, impression cylinders, and ink train per SOP',
    'Inspect rollers, dampers, and auto plate — flag wear',
    'Lubricate per Komori chart; torque guards closed',
    'Replace air/oil filters if interval due',
    'Run test strip; record density — FAI sign-off before production',
  ]
  const GENERIC_PM_CHECKLIST = [
    'Isolate power; confirm safe maintenance state',
    'Inspect wear surfaces, belts, and safety interlocks',
    'Lubricate and torque per OEM chart',
    'Replace consumables per PM kit',
    'Trial run + sign-off before release to production',
  ]
  for (const m of machines) {
    const isOffset = m.machineCode.startsWith('PRN-')
    await prisma.machinePmSchedule.upsert({
      where: { machineId: m.id },
      update: {},
      create: {
        machineId: m.id,
        intervalRunHours: isOffset ? new Prisma.Decimal(500) : new Prisma.Decimal(800),
        intervalImpressions: isOffset ? BigInt(1_500_000) : BigInt(4_000_000),
        taskChecklistJson: (isOffset ? OFFSET_PM_CHECKLIST : GENERIC_PM_CHECKLIST) as Prisma.InputJsonValue,
        sparePartsPlaceholder:
          'Inventory link pending. Typical: filters, blankets, washup consumables per PM BOM.',
      },
    })
  }
  console.log(`✅ ${machines.length} machine PM schedules seeded`)

  // ─────────────────────────────────────────
  // SUPPLIERS (3)
  // ─────────────────────────────────────────
  const sup1 = await prisma.supplier.upsert({
    where: { id: 'seed-supplier-board' },
    update: {},
    create: {
      id: 'seed-supplier-board',
      name: 'Patiala Board Supplies Pvt Ltd',
      gstNumber: '03AABCU9603R1ZM',
      contactName: 'Rajesh Kumar',
      contactPhone: '+919876543210',
      materialTypes: ['Paperboard'],
      leadTimeDays: 7,
      paymentTerms: '30 days credit',
      active: true,
    },
  })
  const sup2 = await prisma.supplier.upsert({
    where: { id: 'seed-supplier-ink' },
    update: {},
    create: {
      id: 'seed-supplier-ink',
      name: 'DIC India Inks Ltd',
      gstNumber: '27AABCD1234A1Z5',
      contactName: 'Amit Sharma',
      materialTypes: ['Inks'],
      leadTimeDays: 14,
      paymentTerms: '45 days credit',
      active: true,
    },
  })
  const sup3 = await prisma.supplier.upsert({
    where: { id: 'seed-supplier-consumables' },
    update: {},
    create: {
      id: 'seed-supplier-consumables',
      name: 'Print Consumables Hub',
      materialTypes: ['Consumables', 'Plates', 'UV Varnish', 'Laminate Film', 'Foil'],
      leadTimeDays: 5,
      active: true,
    },
  })
  console.log('✅ 3 suppliers seeded')

  // ─────────────────────────────────────────
  // CUSTOMERS (5 pharma)
  // ─────────────────────────────────────────
  await prisma.customer.upsert({
    where: { id: 'sample-customer-001' },
    update: {},
    create: {
      id: 'sample-customer-001',
      name: 'Sample Pharma Pvt Ltd',
      gstNumber: '03XXXXX0000X0XX',
      requiresArtworkApproval: true,
      active: true,
    },
  })
  const pharmaCustomers = [
    { id: 'seed-customer-sun', name: 'Sun Pharma Ltd', gstNumber: '24AABCS1234A1Z1', requiresArtworkApproval: true, active: true },
    { id: 'seed-customer-cipla', name: 'Cipla Ltd', gstNumber: '27AABCC1234A1Z2', requiresArtworkApproval: true, active: true },
    { id: 'seed-customer-drreddy', name: 'Dr Reddy\'s Laboratories', gstNumber: '36AABCR1234A1Z3', requiresArtworkApproval: true, active: true },
    { id: 'seed-customer-lupin', name: 'Lupin Ltd', gstNumber: '27AABCL1234A1Z4', requiresArtworkApproval: true, active: true },
  ]
  for (const c of pharmaCustomers) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: { name: c.name, gstNumber: c.gstNumber, requiresArtworkApproval: c.requiresArtworkApproval, active: c.active },
      create: c,
    })
  }
  console.log('✅ 5 customers seeded')

  // ─────────────────────────────────────────
  // INVENTORY / MATERIALS (10)
  // ─────────────────────────────────────────
  const invData = [
    { materialCode: 'BRD-SBS-300', description: 'SBS Paperboard 300gsm', unit: 'sheets', reorderPoint: 5000, supplierId: sup1.id },
    { materialCode: 'BRD-SBS-350', description: 'SBS Paperboard 350gsm', unit: 'sheets', reorderPoint: 3000, supplierId: sup1.id },
    { materialCode: 'BRD-DUP-300', description: 'Duplex Board 300gsm', unit: 'sheets', reorderPoint: 2000, supplierId: sup1.id },
    { materialCode: 'INK-CMYK', description: 'Process CMYK Ink Set', unit: 'kg', reorderPoint: 20, supplierId: sup2.id },
    { materialCode: 'INK-PAN-485', description: 'Pantone 485 Red', unit: 'kg', reorderPoint: 5, supplierId: sup2.id },
    { materialCode: 'VRN-UV-GLOSS', description: 'UV Gloss Varnish', unit: 'litres', reorderPoint: 10, supplierId: sup3.id },
    { materialCode: 'LAM-GLOSS-24', description: 'Gloss Laminate Film 24"', unit: 'metres', reorderPoint: 500, supplierId: sup3.id },
    { materialCode: 'FOIL-GOLD-64', description: 'Hot Foil Gold 64cm', unit: 'metres', reorderPoint: 200, supplierId: sup3.id },
    { materialCode: 'PLATE-A4', description: 'Photopolymer Plate A4', unit: 'pieces', reorderPoint: 50, supplierId: sup3.id },
    { materialCode: 'CTN-MASTER', description: 'Master Carton Brown', unit: 'pieces', reorderPoint: 100, supplierId: sup3.id },
  ]
  for (const row of invData) {
    await prisma.inventory.upsert({
      where: { materialCode: row.materialCode },
      update: { description: row.description, unit: row.unit, reorderPoint: row.reorderPoint, supplierId: row.supplierId },
      create: { ...row, active: true },
    })
  }
  console.log('✅ 10 materials seeded')

  // ─────────────────────────────────────────
  // QC INSTRUMENTS (13)
  // ─────────────────────────────────────────
  const instruments = [
    { instrumentName: 'Digital Scale (0-10 kg)', specification: '0-10 kg' },
    { instrumentName: 'GSM Tester (0-600 GSM)', specification: '0-600 GSM' },
    { instrumentName: '100×100 Cutter (SS Template)', specification: 'SS Template' },
    { instrumentName: 'Digital Micrometer (0-25 mm)', specification: '0-25 mm' },
    { instrumentName: 'SpectroDensitometer (ΔE ≤ 3)', specification: 'ΔE ≤ 3' },
    { instrumentName: 'Bursting Strength Tester (0-30 kg/cm²)', specification: '0-30 kg/cm²' },
    { instrumentName: 'Crease & Bend Tester (Manual)', specification: 'Manual' },
    { instrumentName: 'Gloss Meter (0-100 GU)', specification: '0-100 GU' },
    { instrumentName: 'Pantone Shade Book (Standard)', specification: 'Standard' },
    { instrumentName: 'Magnifying Glass 10×', specification: '10×' },
    { instrumentName: 'Microscope 50×', specification: '50×' },
    { instrumentName: 'Blue Wash Solution', specification: 'Standard' },
    { instrumentName: 'Digital Vernier Caliper', specification: 'Standard' },
  ]
  for (const i of instruments) {
    await prisma.qcInstrument.upsert({
      where: { instrumentName: i.instrumentName },
      update: {},
      create: { ...i, active: true },
    })
  }
  console.log('✅ 13 QC instruments seeded')

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

  // ─────────────────────────────────────────
  // DYES (5 samples)
  // ─────────────────────────────────────────
  await prisma.dye.createMany({
    skipDuplicates: true,
    data: [
      {
        dyeNumber: 233,
        dyeType: 'BSO',
        ups: 8,
        sheetSize: '10.5×20.75',
        cartonSize: '100×12×48',
        creaseDepthMm: 0.8,
        nicksPerCarton: 4,
        conditionRating: 'Good',
      },
      {
        dyeNumber: 177,
        dyeType: '4/lockbottom',
        ups: 2,
        sheetSize: '18×23',
        cartonSize: '85×80×64',
        creaseDepthMm: 1.0,
        conditionRating: 'Good',
      },
      {
        dyeNumber: 253,
        dyeType: '3/lockbottom',
        ups: 3,
        sheetSize: '18×23',
        cartonSize: '82×75×79',
        creaseDepthMm: 1.0,
        conditionRating: 'Good',
      },
      {
        dyeNumber: 137,
        dyeType: 'BSO',
        ups: 8,
        sheetSize: '10.5×20.75',
        cartonSize: '100×12×50',
        creaseDepthMm: 0.8,
        conditionRating: 'Good',
      },
      {
        dyeNumber: 166,
        dyeType: '4/lockbottom',
        ups: 4,
        sheetSize: '13.75×25',
        cartonSize: '85×80×64',
        creaseDepthMm: 1.0,
        conditionRating: 'Good',
      },
    ],
  })
  console.log('✅ 5 dyes seeded')

  // ─────────────────────────────────────────
  // CARTONS (3 pharma cartons with specs)
  // ─────────────────────────────────────────
  const sampleCustomer = await prisma.customer.findFirst()

  if (sampleCustomer) {
    await prisma.carton.createMany({
      skipDuplicates: true,
      data: [
        {
          cartonName: 'BISOJOY 2.5 TAB 10X10SALE-BSJ.2.5CT',
          customerId: sampleCustomer.id,
          gsm: 290,
          boardGrade: 'SBS',
          paperType: 'COLOUR YELLOW',
          caliperMicrons: 320,
          burstStrengthMin: 10.0,
          whitenessMin: 78,
          finishedLength: 100,
          finishedWidth: 12,
          finishedHeight: 48,
          dimensionTol: 0.5,
          numberOfColours: 4,
          colourBreakdown: { C: 'process', M: 'process', Y: 'process', K: 'process' },
          deltaEMax: 3.0,
          registrationTol: 0.1,
          aqlLevel: '1.0',
          pastingStyle: PastingStyle.SPECIAL,
          glueType: 'Hot Melt',
          glueBondMinN: 2.0,
          coatingType: 'Aqueous Varnish',
          drugSchedule: 'Schedule H',
          batchSpaceL: 25,
          batchSpaceW: 10,
          mrpSpaceL: 20,
          mrpSpaceW: 8,
          scheduleMRequired: true,
          iso9001Required: true,
        },
        {
          cartonName: 'GLISIMET M1 TABLET 10X14SALE',
          customerId: sampleCustomer.id,
          gsm: 320,
          boardGrade: 'SBS',
          paperType: 'COLOUR YELLOW',
          caliperMicrons: 360,
          finishedLength: 130,
          finishedWidth: 34,
          finishedHeight: 57,
          numberOfColours: 4,
          deltaEMax: 3.0,
          aqlLevel: '1.0',
          pastingStyle: PastingStyle.LOCK_BOTTOM,
          glueType: 'Hot Melt',
          coatingType: 'Drip off + UV',
          drugSchedule: 'Schedule H',
          batchSpaceL: 25,
          batchSpaceW: 10,
          scheduleMRequired: true,
        },
        {
          cartonName: 'TELMICURE 40 TABLET 10X10SALE',
          customerId: sampleCustomer.id,
          gsm: 300,
          boardGrade: 'SBS',
          paperType: 'COLOUR WHITE',
          caliperMicrons: 340,
          finishedLength: 85,
          finishedWidth: 80,
          finishedHeight: 64,
          numberOfColours: 4,
          deltaEMax: 3.0,
          aqlLevel: '1.0',
          pastingStyle: PastingStyle.LOCK_BOTTOM,
          glueType: 'Hot Melt',
          coatingType: 'Aqueous Varnish',
          drugSchedule: 'Schedule H',
          batchSpaceL: 20,
          batchSpaceW: 8,
          scheduleMRequired: true,
        },
      ],
    })
    console.log('✅ 3 cartons seeded')
  }

  // ─────────────────────────────────────────
  // EMBOSS BLOCKS (3 samples)
  // ─────────────────────────────────────────
  const embossBlockData = [
    { blockCode: 'EB-0001', blockType: 'Registered Emboss', blockMaterial: 'Brass', condition: 'Good', storageLocation: 'Rack C-1', maxImpressions: 100000 },
    { blockCode: 'EB-0002', blockType: 'Blind Emboss', blockMaterial: 'Magnesium', condition: 'Good', storageLocation: 'Rack C-2', maxImpressions: 80000 },
    { blockCode: 'EB-0003', blockType: 'Deboss', blockMaterial: 'Steel', condition: 'Fair', storageLocation: 'Rack C-1', maxImpressions: 120000 },
  ]
  for (const row of embossBlockData) {
    await prisma.embossBlock.upsert({
      where: { blockCode: row.blockCode },
      update: {},
      create: { ...row, active: true },
    })
  }
  console.log('✅ 3 emboss blocks seeded')


  console.log('\n🎉 Seed complete! Run: npx prisma studio to view data')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
