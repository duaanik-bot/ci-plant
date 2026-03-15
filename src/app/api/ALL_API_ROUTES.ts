// ================================================================
// API ROUTES — Copy each block into its correct file path
// ================================================================

// ────────────────────────────────────────────────────
// FILE: src/app/api/auth/[...nextauth]/route.ts
// ────────────────────────────────────────────────────
/*
import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { createAuditLog } from '@/lib/helpers'

export const authOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        pin: { label: 'PIN', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.pin) return null

        const user = await db.user.findUnique({
          where: { email: credentials.email },
          include: { role: true },
        })

        if (!user || !user.active) return null
        const valid = await bcrypt.compare(credentials.pin, user.pinHash)
        if (!valid) return null

        await db.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        })

        await createAuditLog({
          userId: user.id,
          action: 'LOGIN',
          tableName: 'users',
          recordId: user.id,
        })

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role.roleName,
          permissions: user.role.permissions,
          machineAccess: user.machineAccess,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = user.role
        token.permissions = user.permissions
        token.machineAccess = user.machineAccess
      }
      return token
    },
    async session({ session, token }) {
      session.user.id = token.id as string
      session.user.role = token.role as string
      session.user.permissions = token.permissions
      session.user.machineAccess = token.machineAccess as string[]
      return session
    },
  },
  pages: { signIn: '/login' },
  session: { strategy: 'jwt' },
}

const handler = NextAuth(authOptions)
export { handler as GET, handler as POST }
*/

// ────────────────────────────────────────────────────
// FILE: src/app/api/jobs/route.ts
// ────────────────────────────────────────────────────
/*
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/helpers'
import { generateJobNumber, explodeBOM } from '@/lib/helpers'
import { createAuditLog } from '@/lib/helpers'

export async function GET(req: NextRequest) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status')
  const customerId = searchParams.get('customerId')

  const jobs = await db.job.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      // Press operators only see their own jobs
      ...(user!.role === 'press_operator'
        ? { machineSequence: { hasSome: user!.machineAccess } }
        : {}),
    },
    include: {
      customer: { select: { name: true } },
      artwork: { select: { versionNumber: true, status: true, locksCompleted: true } },
    },
    orderBy: { dueDate: 'asc' },
  })

  return NextResponse.json(jobs)
}

export async function POST(req: NextRequest) {
  const { error, user } = await requireAuth('jobs:create')
  if (error) return error

  const body = await req.json()
  const { customerId, productName, qtyOrdered, imposition, machineSequence,
          dueDate, specialInstructions, boardMaterialId } = body

  const jobNumber = await generateJobNumber()

  const job = await db.job.create({
    data: {
      jobNumber,
      customerId,
      productName,
      qtyOrdered,
      imposition,
      machineSequence,
      dueDate: new Date(dueDate),
      specialInstructions,
      status: 'pending_artwork',
      createdBy: user!.id,
    },
  })

  // Explode BOM for the primary press machine
  const pressMachineId = machineSequence.find((id: string) =>
    ['CI-01', 'CI-02', 'CI-03'].some(async code => {
      const m = await db.machine.findUnique({ where: { id } })
      return m?.machineCode === code
    })
  )

  if (boardMaterialId && pressMachineId) {
    await explodeBOM({
      jobId: job.id,
      qtyOrdered,
      imposition,
      machineId: pressMachineId,
      boardMaterialId,
    })
  }

  await createAuditLog({
    userId: user!.id,
    action: 'INSERT',
    tableName: 'jobs',
    recordId: job.id,
    newValue: { jobNumber, customerId, qtyOrdered },
  })

  return NextResponse.json(job, { status: 201 })
}
*/

// ────────────────────────────────────────────────────
// FILE: src/app/api/sheet-issues/attempt/route.ts
// ────────────────────────────────────────────────────
/*
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { attemptSheetIssue } from '@/lib/sheet-issue-logic'

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole('stores', 'shift_supervisor', 'production_manager', 'operations_head', 'md')
  if (error) return error

  const { bomLineId, qtyRequested, lotNumber } = await req.json()

  if (!bomLineId || !qtyRequested || qtyRequested <= 0) {
    return NextResponse.json({ error: 'bomLineId and qtyRequested are required' }, { status: 400 })
  }

  const result = await attemptSheetIssue({
    bomLineId,
    qtyRequested: Number(qtyRequested),
    issuedByUserId: user!.id,
    lotNumber,
  })

  return NextResponse.json(result, { status: result.success ? 200 : 409 })
}
*/

// ────────────────────────────────────────────────────
// FILE: src/app/api/sheet-issues/[id]/approve/route.ts
// ────────────────────────────────────────────────────
/*
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { approveExcessRequest } from '@/lib/sheet-issue-logic'
import { db } from '@/lib/db'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const { error, user } = await requireRole(
    'shift_supervisor', 'production_manager', 'operations_head', 'md'
  )
  if (error) return error

  const tierMap: Record<string, 1 | 2 | 3 | 4> = {
    shift_supervisor: 1,
    production_manager: 2,
    operations_head: 3,
    md: 4,
  }

  const result = await approveExcessRequest({
    sheetIssueId: params.id,
    approvedByUserId: user!.id,
    approvalTier: tierMap[user!.role],
  })

  return NextResponse.json(result)
}
*/

// ────────────────────────────────────────────────────
// FILE: src/app/api/artworks/[id]/approve-lock/route.ts
// ────────────────────────────────────────────────────
/*
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/helpers'
import { submitArtworkLock } from '@/lib/artwork-logic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error, user } = await requireAuth()
  if (error) return error

  const { lockNumber, checklistData, comments } = await req.json()

  // Validate role can approve this lock
  const lockRoles: Record<number, string[]> = {
    1: ['sales', 'md', 'operations_head'],
    2: ['qa_officer', 'qa_manager', 'md'],
    3: ['qa_manager', 'md'],
  }

  if (!lockRoles[lockNumber]?.includes(user!.role)) {
    return NextResponse.json(
      { error: `Your role cannot approve Lock ${lockNumber}` },
      { status: 403 }
    )
  }

  const result = await submitArtworkLock({
    artworkId: params.id,
    lockNumber,
    approvedByUserId: user!.id,
    checklistData,
    comments,
  })

  return NextResponse.json(result)
}
*/

// ────────────────────────────────────────────────────
// FILE: src/app/api/press/validate-plate/route.ts
// ────────────────────────────────────────────────────
/*
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/helpers'
import { validatePlateAtPress } from '@/lib/artwork-logic'

export async function POST(req: NextRequest) {
  const { error, user } = await requireRole(
    'press_operator', 'shift_supervisor', 'production_manager', 'md'
  )
  if (error) return error

  const { plateBarcode, jobId, machineCode } = await req.json()

  const result = await validatePlateAtPress({
    plateBarcode,
    jobId,
    machineCode,
    operatorUserId: user!.id,
  })

  return NextResponse.json(result, { status: result.valid ? 200 : 400 })
}
*/

// ────────────────────────────────────────────────────
// FILE: src/app/api/oee/live/route.ts — Public, no auth needed
// ────────────────────────────────────────────────────
/*
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { calculateOEE } from '@/lib/helpers'

export async function GET() {
  const presses = await db.machine.findMany({
    where: { machineCode: { in: ['CI-01', 'CI-02', 'CI-03'] }, status: 'active' },
  })

  const today = new Date()
  const oeeData = await Promise.all(
    presses.map(async (press) => {
      const oee = await calculateOEE(press.id, today)
      const activeStage = await db.jobStage.findFirst({
        where: { machineId: press.id, completedAt: null },
        include: { job: { select: { jobNumber: true, productName: true, qtyOrdered: true } } },
      })
      return {
        machineCode: press.machineCode,
        machineName: press.name,
        ...oee,
        activeJob: activeStage?.job ?? null,
      }
    })
  )

  return NextResponse.json(oeeData, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
*/

// ────────────────────────────────────────────────────
// FILE: src/app/api/reports/dashboard/route.ts
// ────────────────────────────────────────────────────
/*
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/helpers'

export async function GET() {
  const { error } = await requireRole('md', 'operations_head', 'production_manager')
  if (error) return error

  const [activeJobs, openNcrs, dispatchDue, pendingArtworks, reorderAlerts] = await Promise.all([
    db.job.count({ where: { status: { notIn: ['closed', 'dispatched'] } } }),
    db.ncr.groupBy({ by: ['severity'], where: { status: 'open' }, _count: true }),
    db.dispatch.count({
      where: { status: 'qa_released', job: { dueDate: { lte: new Date() } } },
    }),
    db.artwork.count({ where: { status: { in: ['pending', 'partially_approved'] } } }),
    db.inventory.count({
      where: { qtyAvailable: { lte: db.inventory.fields.reorderPoint } },
    }),
  ])

  return NextResponse.json({
    activeJobs,
    openNcrs: Object.fromEntries(openNcrs.map(r => [r.severity, r._count])),
    dispatchDue,
    pendingArtworks,
    reorderAlerts,
    timestamp: new Date().toISOString(),
  })
}
*/

export {} // Makes this a module
