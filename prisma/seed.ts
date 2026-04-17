// prisma/seed.ts
// Run with: npx prisma db seed
// Seeds: 8 roles, 12 machines, 13 QC instruments, admin user

import { PrismaClient, PastingStyle } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding Colour Impressions Plant System...')

  // ─────────────────────────────────────────
  // ROLES
  // ─────────────────────────────────────────
  const roles = await Promise.all([
    prisma.role.upsert({
      where: { roleName: 'md' },
      update: {},
      create: {
        roleName: 'md',
        wastageApproveLimitPct: 999, // unlimited
        canApproveArtwork: true,
        canReleaseDispatch: true,
        permissions: {
          jobs: 'full', artwork: 'full', production: 'full',
          inventory: 'full', qms: 'full', dispatch: 'full',
          reports: 'full', admin: 'full',
        },
      },
    }),
    prisma.role.upsert({
      where: { roleName: 'operations_head' },
      update: {},
      create: {
        roleName: 'operations_head',
        wastageApproveLimitPct: 200,
        canApproveArtwork: true,
        canReleaseDispatch: true,
        permissions: {
          jobs: 'full', artwork: 'approve', production: 'full',
          inventory: 'full', qms: 'full', dispatch: 'full',
          reports: 'full', admin: 'view',
        },
      },
    }),
    prisma.role.upsert({
      where: { roleName: 'production_manager' },
      update: {},
      create: {
        roleName: 'production_manager',
        wastageApproveLimitPct: 150,
        canApproveArtwork: false,
        canReleaseDispatch: false,
        permissions: {
          jobs: 'full', artwork: 'view', production: 'full',
          inventory: 'full', qms: 'view', dispatch: 'view',
          reports: 'partial', admin: 'none',
        },
      },
    }),
    prisma.role.upsert({
      where: { roleName: 'shift_supervisor' },
      update: {},
      create: {
        roleName: 'shift_supervisor',
        wastageApproveLimitPct: 100,
        canApproveArtwork: false,
        canReleaseDispatch: false,
        permissions: {
          jobs: 'partial', artwork: 'none', production: 'full',
          inventory: 'view', qms: 'view', dispatch: 'none',
          reports: 'none', admin: 'none',
        },
      },
    }),
    prisma.role.upsert({
      where: { roleName: 'press_operator' },
      update: {},
      create: {
        roleName: 'press_operator',
        wastageApproveLimitPct: 0,
        canApproveArtwork: false,
        canReleaseDispatch: false,
        permissions: {
          jobs: 'own', artwork: 'none', production: 'own',
          inventory: 'own', qms: 'none', dispatch: 'none',
          reports: 'none', admin: 'none',
        },
      },
    }),
    prisma.role.upsert({
      where: { roleName: 'qa_officer' },
      update: {},
      create: {
        roleName: 'qa_officer',
        wastageApproveLimitPct: 0,
        canApproveArtwork: true, // Lock 2 only
        canReleaseDispatch: false,
        permissions: {
          jobs: 'view', artwork: 'approve', production: 'view',
          inventory: 'quarantine', qms: 'full', dispatch: 'approve',
          reports: 'qc', admin: 'none',
        },
      },
    }),
    prisma.role.upsert({
      where: { roleName: 'qa_manager' },
      update: {},
      create: {
        roleName: 'qa_manager',
        wastageApproveLimitPct: 0,
        canApproveArtwork: true, // Lock 3 — final
        canReleaseDispatch: true,
        permissions: {
          jobs: 'view', artwork: 'final', production: 'view',
          inventory: 'view', qms: 'full', dispatch: 'final',
          reports: 'qc', admin: 'none',
        },
      },
    }),
    prisma.role.upsert({
      where: { roleName: 'stores' },
      update: {},
      create: {
        roleName: 'stores',
        wastageApproveLimitPct: 0,
        canApproveArtwork: false,
        canReleaseDispatch: false,
        permissions: {
          jobs: 'none', artwork: 'none', production: 'none',
          inventory: 'wms', qms: 'none', dispatch: 'pick',
          reports: 'none', admin: 'none',
        },
      },
    }),
  ])
  console.log(`✅ ${roles.length} roles created`)

  // ─────────────────────────────────────────
  // MACHINES — CI-01 through CI-12
  // ─────────────────────────────────────────
  const machines = await Promise.all([
    prisma.machine.upsert({
      where: { machineCode: 'CI-01' },
      update: {},
      create: {
        machineCode: 'CI-01',
        name: 'Offset Press 5 Colour + Coater',
        make: 'Komori Lithron',
        specification: '20"×28"',
        capacityPerShift: 80000, // 10,000/hr × 8hr shift
        stdWastePct: 3.0,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-02' },
      update: {},
      create: {
        machineCode: 'CI-02',
        name: 'Offset Press 5 Colour',
        make: 'Komori Lithron',
        specification: '20"×28"',
        capacityPerShift: 64000,
        stdWastePct: 3.5,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-03' },
      update: {},
      create: {
        machineCode: 'CI-03',
        name: 'Offset Press 5 Colour (Small Format)',
        make: 'Komori Lithron',
        specification: '19"×26"',
        capacityPerShift: 60000,
        stdWastePct: 4.0,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-04' },
      update: {},
      create: {
        machineCode: 'CI-04',
        name: 'UV / Varnish Machine',
        make: 'Komori 2 Colour',
        specification: '19"×26"',
        capacityPerShift: 48000, // 6,000/hr × 8hr
        stdWastePct: 2.0,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-05' },
      update: {},
      create: {
        machineCode: 'CI-05',
        name: 'Lamination Machine',
        make: 'Royal Thermal',
        specification: '24"',
        capacityPerShift: 8000,
        stdWastePct: 1.5,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-06' },
      update: {},
      create: {
        machineCode: 'CI-06',
        name: 'Die Punch Cutting Machine (Auto)',
        make: 'Heidelberg Automatic',
        specification: '28"×40"',
        capacityPerShift: 12000,
        stdWastePct: 2.0,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-07' },
      update: {},
      create: {
        machineCode: 'CI-07',
        name: 'Die Punch Cutting Machine (Manual)',
        make: 'Indian/Manual',
        specification: '20"×28"',
        capacityPerShift: 12000,
        stdWastePct: 2.5,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-08' },
      update: {},
      create: {
        machineCode: 'CI-08',
        name: 'Automatic Lock Bottom Pasting Machine',
        make: 'Precision',
        specification: '24"',
        capacityPerShift: 300000,
        stdWastePct: 1.0,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-09' },
      update: {},
      create: {
        machineCode: 'CI-09',
        name: 'Side Pasting Machine',
        make: 'Cortonal',
        specification: '24"',
        capacityPerShift: 400000,
        stdWastePct: 1.0,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-10' },
      update: {},
      create: {
        machineCode: 'CI-10',
        name: 'Board Cutting Machine',
        make: 'ACE',
        specification: '42"',
        capacityPerShift: 12000,
        stdWastePct: 0.5,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-11' },
      update: {},
      create: {
        machineCode: 'CI-11',
        name: 'Automatic Label Cutting Machine',
        make: 'Jindal',
        specification: 'Auto',
        capacityPerShift: 20000,
        stdWastePct: 1.0,
      },
    }),
    prisma.machine.upsert({
      where: { machineCode: 'CI-12' },
      update: {},
      create: {
        machineCode: 'CI-12',
        name: 'Platesetter (CTP Unit)',
        make: 'Kodak Achieve',
        specification: 'Thermal CTP',
        capacityPerShift: 200,
        stdWastePct: 0,
      },
    }),
  ])
  console.log(`✅ ${machines.length} machines seeded (CI-01 through CI-12)`)

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
  // ADMIN USER
  // ─────────────────────────────────────────
  const mdRole = roles.find(r => r.roleName === 'md')!
  const pinHash = await bcrypt.hash('123456', 12)

  await prisma.user.upsert({
    where: { email: 'dua.anik@gmail.com' },
    update: {},
    create: {
      name: 'Anik Dua',
      email: 'dua.anik@gmail.com',
      pinHash,
      roleId: mdRole.id,
      whatsappNumber: '+919780020225',
      active: true,
    },
  })
  console.log('✅ Admin user created — email: dua.anik@gmail.com PIN: 123456')
  console.log('⚠️  CHANGE THE PIN on first login!')

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

  const dyes = await prisma.dye.findMany()
  await prisma.dieStore.createMany({
    skipDuplicates: true,
    data: [
      {
        dieCode: 'DI-2026-0001',
        dieNumber: 233,
        dyeId: dyes.find((d) => d.dyeNumber === 233)?.id,
        dieType: 'BSO',
        ups: 8,
        sheetSize: '10.5×20.75',
        cartonSize: '100×12×48',
        dieMaterial: 'Steel Rule',
        storageLocation: 'Die Rack A-1',
        compartment: 'Compartment 3',
        impressionCount: 142000,
        maxImpressions: 500000,
        sharpenCount: 1,
        maxSharpenCount: 5,
        condition: 'Good',
        status: 'in_stock',
        totalJobsUsed: 8,
        createdBy: 'system',
      },
      {
        dieCode: 'DI-2026-0002',
        dieNumber: 177,
        dieType: '4/lockbottom',
        ups: 2,
        sheetSize: '18×23',
        cartonSize: '85×80×64',
        dieMaterial: 'Steel Rule',
        storageLocation: 'Die Rack A-1',
        compartment: 'Compartment 4',
        impressionCount: 310000,
        maxImpressions: 500000,
        sharpenCount: 2,
        condition: 'Fair',
        status: 'in_stock',
        totalJobsUsed: 15,
        createdBy: 'system',
      },
      {
        dieCode: 'DI-2026-0003',
        dieNumber: 253,
        dieType: '3/lockbottom',
        ups: 3,
        sheetSize: '18×23',
        cartonSize: '82×75×79',
        dieMaterial: 'Steel Rule',
        storageLocation: 'Die Rack A-2',
        compartment: 'Compartment 1',
        impressionCount: 478000,
        maxImpressions: 500000,
        sharpenCount: 3,
        condition: 'Needs Sharpening',
        status: 'in_stock',
        totalJobsUsed: 22,
        createdBy: 'system',
      },
      {
        dieCode: 'DI-2026-0004',
        dieNumber: 137,
        dieType: 'BSO',
        ups: 8,
        sheetSize: '10.5×20.75',
        cartonSize: '100×12×50',
        dieMaterial: 'Steel Rule',
        storageLocation: 'Die Rack A-2',
        compartment: 'Compartment 2',
        impressionCount: 45000,
        maxImpressions: 500000,
        sharpenCount: 0,
        condition: 'Excellent',
        status: 'in_stock',
        totalJobsUsed: 3,
        createdBy: 'system',
      },
      {
        dieCode: 'DI-2026-0005',
        dieNumber: 166,
        dieType: '4/lockbottom',
        ups: 4,
        sheetSize: '13.75×25',
        cartonSize: '85×80×64',
        dieMaterial: 'Steel Rule',
        storageLocation: 'Die Rack B-1',
        compartment: 'Compartment 1',
        impressionCount: 520000,
        maxImpressions: 500000,
        sharpenCount: 4,
        condition: 'Damaged',
        status: 'scrapped',
        scrapReason: 'Rules bent beyond repair after heavy run',
        totalJobsUsed: 28,
        createdBy: 'system',
      },
    ],
  })
  console.log('✅ 5 die-store records seeded')

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

  await prisma.embossBlock.createMany({
    skipDuplicates: true,
    data: [
      {
        blockCode: 'EB-2026-0001',
        blockNumber: 1,
        blockType: 'Registered Emboss',
        blockMaterial: 'Brass',
        embossDepth: 0.8,
        embossArea: 'Logo area top panel, 30×20mm',
        storageLocation: 'Block Rack C-1',
        compartment: 'Shelf 1',
        impressionCount: 12000,
        maxImpressions: 100000,
        polishCount: 0,
        maxPolishCount: 8,
        condition: 'Excellent',
        status: 'in_stock',
        totalJobsUsed: 2,
        vendorName: 'City Die Works',
        manufacturingCost: 3500,
        createdBy: 'system',
      },
      {
        blockCode: 'EB-2026-0002',
        blockNumber: 2,
        blockType: 'Blind Emboss',
        blockMaterial: 'Magnesium',
        embossDepth: 0.6,
        embossArea: 'Border pattern full panel',
        storageLocation: 'Block Rack C-1',
        compartment: 'Shelf 2',
        impressionCount: 78000,
        maxImpressions: 100000,
        polishCount: 3,
        maxPolishCount: 8,
        condition: 'Needs Polish',
        status: 'in_stock',
        totalJobsUsed: 12,
        vendorName: 'Precision Blocks Pvt Ltd',
        manufacturingCost: 2800,
        createdBy: 'system',
      },
      {
        blockCode: 'EB-2026-0003',
        blockNumber: 3,
        blockType: 'Deboss',
        blockMaterial: 'Steel',
        embossDepth: 1.0,
        embossArea: 'Product name text area',
        storageLocation: 'Block Rack C-2',
        compartment: 'Shelf 1',
        impressionCount: 45000,
        maxImpressions: 120000,
        polishCount: 1,
        maxPolishCount: 8,
        condition: 'Good',
        status: 'in_stock',
        totalJobsUsed: 6,
        vendorName: 'City Die Works',
        manufacturingCost: 4200,
        createdBy: 'system',
      },
    ],
  })
  console.log('✅ Emboss lifecycle blocks seeded')

  // ─────────────────────────────────────────
  // PLATE STORE (5 samples)
  // ─────────────────────────────────────────
  const plateStoreData = [
    {
      plateSetCode: 'PS-2026-0001',
      cartonName: 'BISOJOY 2.5 TAB 10X10SALE',
      artworkCode: 'BSJ.2.5CT-0325',
      artworkVersion: 'R0',
      numberOfColours: 4,
      colours: [
        { name: 'C', type: 'process', status: 'returned', rackLocation: 'Rack B-1', slotNumber: 'Slot 3', condition: 'Good' },
        { name: 'M', type: 'process', status: 'returned', rackLocation: 'Rack B-1', slotNumber: 'Slot 4', condition: 'Good' },
        { name: 'Y', type: 'process', status: 'returned', rackLocation: 'Rack B-1', slotNumber: 'Slot 5', condition: 'Fair' },
        { name: 'K', type: 'process', status: 'returned', rackLocation: 'Rack B-1', slotNumber: 'Slot 6', condition: 'Good' },
      ],
      totalPlates: 4,
      newPlatesCount: 0,
      oldPlatesCount: 4,
      rackLocation: 'Rack B-1',
      status: 'returned',
      ctpDate: new Date('2026-01-15'),
      totalJobsUsed: 3,
    },
    {
      plateSetCode: 'PS-2026-0002',
      cartonName: 'GLISIMET M1 TABLET 10X14SALE',
      artworkVersion: 'R1',
      numberOfColours: 5,
      colours: [
        { name: 'C', type: 'process', status: 'returned', rackLocation: 'Rack B-2', slotNumber: 'Slot 1', condition: 'Good' },
        { name: 'M', type: 'process', status: 'returned', rackLocation: 'Rack B-2', slotNumber: 'Slot 2', condition: 'Good' },
        { name: 'Y', type: 'process', status: 'destroyed', rackLocation: null, slotNumber: null, condition: 'Destroyed' },
        { name: 'K', type: 'process', status: 'returned', rackLocation: 'Rack B-2', slotNumber: 'Slot 3', condition: 'Good' },
        { name: 'P1_485C', type: 'pantone', status: 'returned', rackLocation: 'Rack B-2', slotNumber: 'Slot 4', condition: 'Fair' },
      ],
      totalPlates: 5,
      newPlatesCount: 0,
      oldPlatesCount: 4,
      rackLocation: 'Rack B-2',
      status: 'partially_destroyed',
      ctpDate: new Date('2026-02-10'),
      totalJobsUsed: 2,
    },
    {
      plateSetCode: 'PS-2026-0003',
      cartonName: 'TELMICURE 40 TABLET 10X10SALE',
      artworkVersion: 'R2',
      numberOfColours: 4,
      colours: [
        { name: 'C', type: 'process', status: 'issued', rackLocation: 'On Press CI-01', slotNumber: null, condition: 'Good' },
        { name: 'M', type: 'process', status: 'issued', rackLocation: 'On Press CI-01', slotNumber: null, condition: 'Good' },
        { name: 'Y', type: 'process', status: 'issued', rackLocation: 'On Press CI-01', slotNumber: null, condition: 'Good' },
        { name: 'K', type: 'process', status: 'issued', rackLocation: 'On Press CI-01', slotNumber: null, condition: 'Good' },
      ],
      totalPlates: 4,
      newPlatesCount: 0,
      oldPlatesCount: 4,
      rackLocation: 'Rack B-3',
      status: 'issued',
      ctpDate: new Date('2026-03-01'),
      totalJobsUsed: 6,
    },
    {
      plateSetCode: 'PS-2026-0004',
      cartonName: 'AMLONIC 5 TABLET 10X10SALE',
      artworkVersion: 'R0',
      numberOfColours: 4,
      colours: [
        { name: 'C', type: 'process', status: 'returned', rackLocation: 'Rack C-1', slotNumber: 'Slot 7', condition: 'Good' },
        { name: 'M', type: 'process', status: 'returned', rackLocation: 'Rack C-1', slotNumber: 'Slot 8', condition: 'Good' },
        { name: 'Y', type: 'process', status: 'returned', rackLocation: 'Rack C-1', slotNumber: 'Slot 9', condition: 'Good' },
        { name: 'K', type: 'process', status: 'returned', rackLocation: 'Rack C-1', slotNumber: 'Slot 10', condition: 'Good' },
      ],
      totalPlates: 4,
      newPlatesCount: 4,
      oldPlatesCount: 0,
      rackLocation: 'Rack C-1',
      status: 'ready',
      ctpDate: new Date('2026-03-10'),
      totalJobsUsed: 0,
    },
    {
      plateSetCode: 'PS-2026-0005',
      cartonName: 'CETRILIV SYRUP CARTON',
      artworkVersion: 'R3',
      numberOfColours: 6,
      colours: [
        { name: 'C', type: 'process', status: 'destroyed', rackLocation: null, slotNumber: null, condition: 'Destroyed' },
        { name: 'M', type: 'process', status: 'destroyed', rackLocation: null, slotNumber: null, condition: 'Destroyed' },
        { name: 'Y', type: 'process', status: 'destroyed', rackLocation: null, slotNumber: null, condition: 'Destroyed' },
        { name: 'K', type: 'process', status: 'destroyed', rackLocation: null, slotNumber: null, condition: 'Destroyed' },
        { name: 'P1_201C', type: 'pantone', status: 'destroyed', rackLocation: null, slotNumber: null, condition: 'Destroyed' },
        { name: 'P2_877C', type: 'pantone', status: 'destroyed', rackLocation: null, slotNumber: null, condition: 'Destroyed' },
      ],
      totalPlates: 6,
      newPlatesCount: 0,
      oldPlatesCount: 0,
      rackLocation: null,
      status: 'destroyed',
      ctpDate: new Date('2026-01-20'),
      totalJobsUsed: 8,
    },
  ]
  for (const row of plateStoreData) {
    await prisma.plateStore.upsert({
      where: { plateSetCode: row.plateSetCode },
      update: {},
      create: row,
    })
  }
  console.log('✅ 5 plate store records seeded')

  console.log('\n🎉 Seed complete! Run: npx prisma studio to view data')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
