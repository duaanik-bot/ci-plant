/**
 * Smoke test: reservation-release helpers
 * Run (locally, with a non-prod DB): npx tsx scripts/test-reservation-release.ts
 *
 * IMPORTANT: do NOT run this against production. It mutates reservations
 * and reverts them at the end of each sub-test, but a crash mid-test will
 * leave rows in `is_released=true` state.
 */
import { PrismaClient } from '@prisma/client'
import {
  releaseReservationsForJob,
  recalculateMaterialShortage,
  ACTIVE_RESERVATION_STATUSES,
} from '../src/lib/reservation-release'

const prisma = new PrismaClient()

async function testRelease() {
  const existing = await prisma.materialReservation.findFirst({
    where: { isReleased: false },
    include: { jobCard: true, material: true },
  })
  if (!existing) {
    console.log('SKIP testRelease: no unreleased reservations in DB')
    return
  }

  const jobCardId = existing.jobCardId
  const beforeCount = await prisma.materialReservation.count({
    where: { jobCardId, isReleased: false },
  })

  const result = await prisma.$transaction(async (tx) => {
    return releaseReservationsForJob(jobCardId, 'cancelled', tx)
  })

  console.assert(
    result.releasedCount === beforeCount,
    `releasedCount ${result.releasedCount} !== beforeCount ${beforeCount}`,
  )
  console.assert(result.materialIds.length > 0, 'materialIds should be non-empty')

  const after = await prisma.materialReservation.findMany({ where: { jobCardId } })
  for (const r of after) {
    console.assert(r.isReleased === true, `reservation ${r.id} should be released`)
    console.assert(r.releasedReason === 'job_cancelled', `releasedReason mismatch: ${r.releasedReason}`)
    console.assert(r.releasedAt !== null, `releasedAt should be set`)
  }

  await prisma.materialReservation.updateMany({
    where: { jobCardId },
    data: { isReleased: false, releasedAt: null, releasedReason: null },
  })

  console.log('PASS: releaseReservationsForJob')
}

async function testRecalc() {
  const existing = await prisma.materialReservation.findFirst({
    where: { isReleased: false },
    include: { jobCard: true },
  })
  if (!existing) {
    console.log('SKIP testRecalc: no unreleased reservations')
    return
  }

  const result = await prisma.$transaction(async (tx) => {
    return recalculateMaterialShortage(existing.materialId, tx)
  })

  console.assert(typeof result.shortage === 'number', `shortage should be a number, got ${typeof result.shortage}`)
  console.assert(result.shortage >= 0, `shortage should be non-negative, got ${result.shortage}`)

  const active = await prisma.materialReservation.findMany({
    where: {
      materialId: existing.materialId,
      isReleased: false,
      jobCard: { status: { in: ACTIVE_RESERVATION_STATUSES as unknown as string[] } },
    },
  })
  const expected = active.reduce(
    (sum, r) => sum + Math.max(0, Number(r.requiredSheets) - Number(r.reservedSheets)),
    0,
  )
  console.assert(
    Math.abs(result.shortage - expected) < 0.01,
    `shortage mismatch: got ${result.shortage}, expected ${expected}`,
  )

  console.log('PASS: recalculateMaterialShortage')
}

async function testEndToEnd() {
  // Find a job NOT in terminal state with at least one unreleased reservation
  const existing = await prisma.materialReservation.findFirst({
    where: {
      isReleased: false,
      jobCard: {
        status: { in: ACTIVE_RESERVATION_STATUSES as unknown as string[] },
      },
    },
    include: { jobCard: true },
  })
  if (!existing) {
    console.log('SKIP testEndToEnd: no active job with reservations')
    return
  }

  const originalStatus = existing.jobCard.status
  const jobCardId = existing.jobCardId

  // Mutate status to cancelled — explicit wiring at the site SHOULD fire the helper
  // (we test by calling one of the wired API routes; for an offline smoke we
  //  simulate the wiring by calling the helpers directly after a status update)
  await prisma.$transaction(async (tx) => {
    await tx.productionJobCard.update({
      where: { id: jobCardId },
      data: { status: 'cancelled' },
    })
    const { materialIds } = await releaseReservationsForJob(jobCardId, 'cancelled', tx)
    for (const mid of materialIds) {
      await recalculateMaterialShortage(mid, tx)
    }
  })

  const after = await prisma.materialReservation.findMany({ where: { jobCardId } })
  for (const r of after) {
    console.assert(r.isReleased === true, `reservation ${r.id} should be released`)
    console.assert(r.releasedReason === 'job_cancelled', `releasedReason ${r.releasedReason}`)
  }

  // Revert
  await prisma.materialReservation.updateMany({
    where: { jobCardId },
    data: { isReleased: false, releasedAt: null, releasedReason: null },
  })
  await prisma.productionJobCard.update({
    where: { id: jobCardId },
    data: { status: originalStatus },
  })

  console.log('PASS: testEndToEnd (explicit wiring)')
}

async function main() {
  await testRelease()
  await testRecalc()
  await testEndToEnd()
}

main()
  .catch((e) => {
    console.error('FAIL:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
