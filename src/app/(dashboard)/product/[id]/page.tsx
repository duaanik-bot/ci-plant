import { redirect } from 'next/navigation'

/** Canonical Product Master deep link — resolves to carton master (names sync from this relation). */
export default async function ProductDeepLinkPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!id?.trim()) redirect('/masters/cartons')
  redirect(`/masters/cartons/${encodeURIComponent(id.trim())}`)
}
