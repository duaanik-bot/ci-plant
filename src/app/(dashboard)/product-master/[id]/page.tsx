import { redirect } from 'next/navigation'

/** Alias URL for Product Master (carton) deep links from shade card inventory. */
export default async function ProductMasterAliasPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!id?.trim()) redirect('/masters/cartons')
  redirect(`/masters/cartons/${encodeURIComponent(id.trim())}`)
}
