// src/lib/helpers.ts — notifications, audit, auth, job-number, oee
import { db } from './db'

// ─────────────────────────────────────────────────────────────────
// notifications — WhatsApp via Wati API
export async function sendWhatsApp(to: string, message: string): Promise<boolean> {
  if (!process.env.WATI_API_KEY || !process.env.WATI_BASE_URL) {
    console.warn('[WhatsApp] WATI not configured — message not sent:', message)
    return false
  }
  try {
    const clean = to.replace(/\D/g, '')
    const res = await fetch(`${process.env.WATI_BASE_URL}/api/v1/sendSessionMessage/${clean}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WATI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messageText: message }),
    })
    return res.ok
  } catch (e) {
    console.error('[WhatsApp] Send failed:', e)
    return false
  }
}

export { createAuditLog } from './audit'

// ─────────────────────────────────────────────────────────────────
// auth — Auth helpers
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { NextResponse } from 'next/server'

export async function requireAuth(requiredPermission?: string) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return { error: NextResponse.json({ error: 'Unauthorised' }, { status: 401 }), user: null }
  }
  return { error: null, user: session.user }
}

export async function requireRole(...allowedRoles: string[]) {
  const { error, user } = await requireAuth()
  if (error) return { error, user: null }
  const userRole = (user!.role ?? '').trim().toLowerCase()
  const ok = allowedRoles.some((r) => r.trim().toLowerCase() === userRole)
  if (!ok) {
    return {
      error: NextResponse.json({ error: 'Forbidden — insufficient role' }, { status: 403 }),
      user: null,
    }
  }
  return { error: null, user }
}

// ─────────────────────────────────────────────────────────────────
// job-number — Auto-generate CI-JOB-YYYY-NNNN
export async function generateJobNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `CI-JOB-${year}-`

  const lastJob = await db.job.findFirst({
    where: { jobNumber: { startsWith: prefix } },
    orderBy: { jobNumber: 'desc' },
  })

  const lastSeq = lastJob
    ? parseInt(lastJob.jobNumber.replace(prefix, ''), 10)
    : 0

  const nextSeq = String(lastSeq + 1).padStart(4, '0')
  return `${prefix}${nextSeq}`
}

// ─────────────────────────────────────────────────────────────────
// oee — OEE calculation for live dashboard
export async function calculateOEE(machineId: string, shiftDate: Date) {
  const shiftStart = new Date(shiftDate)
  shiftStart.setHours(6, 0, 0, 0)
  const shiftEnd = new Date(shiftDate)
  shiftEnd.setHours(22, 0, 0, 0)

  const stages = await db.jobStage.findMany({
    where: {
      machineId,
      startedAt: { gte: shiftStart, lte: shiftEnd },
    },
    include: { job: true },
  })

  if (!stages.length) return { oee: 0, availability: 0, performance: 0, quality: 0 }

  const machine = await db.machine.findUniqueOrThrow({ where: { id: machineId } })

  const plannedTime = 16 * 60 // 16 hours in minutes
  const totalQtyIn = stages.reduce((s, st) => s + (st.qtyIn ?? 0), 0)
  const totalQtyOut = stages.reduce((s, st) => s + (st.qtyOut ?? 0), 0)
  const totalWaste = stages.reduce((s, st) => s + st.qtyWaste, 0)

  const availability = Math.min(100, (stages.length > 0 ? 85 : 0)) // Simplified
  const performance = totalQtyIn > 0
    ? Math.min(100, (totalQtyOut / (machine.capacityPerShift * (plannedTime / 480))) * 100)
    : 0
  const quality = totalQtyIn > 0
    ? Math.min(100, ((totalQtyIn - totalWaste) / totalQtyIn) * 100)
    : 0

  const oee = (availability * performance * quality) / 10000

  return {
    oee: Math.round(oee * 10) / 10,
    availability: Math.round(availability * 10) / 10,
    performance: Math.round(performance * 10) / 10,
    quality: Math.round(quality * 10) / 10,
    totalSheets: totalQtyIn,
    goodSheets: totalQtyOut,
  }
}
