import { DetailPage } from '../../_components/ProcurementScreens'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <DetailPage kind="grn" id={id} />
}
