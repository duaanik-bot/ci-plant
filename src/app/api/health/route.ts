import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Health probe — also keeps the Neon DB connection warm so the first
 * real user request doesn't pay the 3–5s auto-resume cost.
 * Safe to expose publicly; returns no sensitive data.
 */
export async function GET(req: NextRequest) {
  // Optional bearer auth (if CRON_SECRET is configured, require it).
  const expected = process.env.CRON_SECRET
  if (expected) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    }
  }

  const t0 = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({
      ok: true,
      dbMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'db check failed',
        dbMs: Date.now() - t0,
      },
      { status: 503 },
    )
  }
}
