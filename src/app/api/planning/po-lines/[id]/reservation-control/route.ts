import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import {
  adjustPlanningReservation,
  generatePrForPlanningShortage,
  getPlanningReservationSnapshot,
  getPlanningReservedByMaterial,
  releasePlanningReservation,
} from '@/lib/material-readiness-service'

export const dynamic = 'force-dynamic'

type ReservationControlAction = 'adjust' | 'release' | 'generate_pr'

function fail(message: string, status = 400, details?: Record<string, unknown>) {
  return NextResponse.json(
    {
      success: false,
      message,
      ...(details ? { details } : {}),
    },
    { status },
  )
}

function asNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAuth()
  if (error) return error

  const { id: planningId } = await context.params
  if (!planningId) return fail('Planning context missing')

  const { searchParams } = new URL(req.url)
  const materialId = searchParams.get('materialId')?.trim() || ''

  // No materialId → return the full per-material reserved map for this line.
  if (!materialId) {
    try {
      const reservedByMaterial = await getPlanningReservedByMaterial(planningId)
      return NextResponse.json({ success: true, reservedByMaterial })
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Failed to load reservations', 400)
    }
  }

  const requiredSheets = Math.max(0, Math.floor(asNum(searchParams.get('requiredSheets'))))
  if (!requiredSheets) return fail('Invalid required sheets')

  try {
    const snapshot = await getPlanningReservationSnapshot(planningId, materialId, requiredSheets)
    return NextResponse.json({ success: true, ...snapshot })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load reservation snapshot', 400)
  }
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { id: planningId } = await context.params
  const body = (await req.json().catch(() => ({}))) as {
    action?: ReservationControlAction
    materialId?: string
    requiredSheets?: number
    targetReserveQty?: number
    releaseQty?: number
    prQty?: number
    prImpactAction?: 'keep' | 'reduce' | 'cancel_if_no_shortage'
    reason?: string
    reservedSheets?: number
  }
  if (!planningId) return fail('Planning context missing')
  if (!body.materialId || !body.materialId.trim()) return fail('No material selected')
  if (!body.action) return fail('Reservation action missing')

  try {
    if (body.action === 'adjust') {
      const out = await adjustPlanningReservation({
        planningId,
        materialId: body.materialId.trim(),
        requiredSheets: Math.max(0, Math.floor(asNum(body.requiredSheets))),
        targetReservedSheets: Math.max(0, asNum(body.targetReserveQty)),
        prQty: Math.max(0, asNum(body.prQty)),
        prImpactAction: body.prImpactAction ?? 'reduce',
        reason: body.reason ?? null,
        actorUserId: user?.id ?? null,
      })
      return NextResponse.json({ success: true, ...out })
    }

    if (body.action === 'release') {
      const out = await releasePlanningReservation({
        planningId,
        materialId: body.materialId.trim(),
        requiredSheets: Math.max(0, Math.floor(asNum(body.requiredSheets))),
        releaseQty: Math.max(0, asNum(body.releaseQty)),
        prImpactAction: body.prImpactAction ?? 'reduce',
        actorUserId: user?.id ?? null,
      })
      return NextResponse.json({ success: true, ...out })
    }

    if (body.action === 'generate_pr') {
      const out = await generatePrForPlanningShortage({
        planningId,
        materialId: body.materialId.trim(),
        requiredSheets: Math.max(0, Math.floor(asNum(body.requiredSheets))),
        reservedSheets: Math.max(0, asNum(body.reservedSheets)),
        prQty: Math.max(0, asNum(body.prQty)),
      })
      return NextResponse.json({ success: true, ...out })
    }

    return fail('Unsupported action')
  } catch (e) {
    console.error('[planning-reservation-control]', {
      action: body.action,
      planningId,
      materialId: body.materialId,
      requiredSheets: body.requiredSheets,
      targetReserveQty: body.targetReserveQty,
      releaseQty: body.releaseQty,
      prQty: body.prQty,
      error: e instanceof Error ? e.message : e,
      stack: e instanceof Error ? e.stack : null,
    })
    return fail(e instanceof Error ? e.message : 'Reservation control action failed', 400)
  }
}

