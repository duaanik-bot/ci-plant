import { db } from '@/lib/db'
import { notFound } from 'next/navigation'
import { WarehouseSizeVerifier } from '@/components/carton/WarehouseSizeVerifier'

export const dynamic = 'force-dynamic'

export default async function WarehousePage({
  params,
}: {
  params: { id: string }
}) {
  const c = await db.carton.findUnique({
    where: { id: params.id },
    include: { customer: { select: { name: true } } },
  })
  if (!c) notFound()

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold mb-1">Physical Size Verification</h1>
      <p className="text-sm text-muted-foreground mb-4">
        {c.cartonName} — {c.customer.name}
      </p>
      <WarehouseSizeVerifier
        cartonId={c.id}
        spec={{
          l: c.finishedLength != null ? Number(c.finishedLength) : null,
          w: c.finishedWidth != null ? Number(c.finishedWidth) : null,
          h: c.finishedHeight != null ? Number(c.finishedHeight) : null,
        }}
      />
    </div>
  )
}
