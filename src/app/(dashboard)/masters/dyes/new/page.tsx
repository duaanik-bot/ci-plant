'use client'

import { useSearchParams } from 'next/navigation'
import DyeForm from '@/components/masters/DyeForm'

export default function NewDyePage() {
  const sp = useSearchParams()
  const cartonL = sp.get('cartonL') ?? ''
  const cartonW = sp.get('cartonW') ?? ''
  const cartonH = sp.get('cartonH') ?? ''

  const prefill = cartonL || cartonW || cartonH
    ? { cartonL, cartonW, cartonH }
    : undefined

  return <DyeForm mode="ADD" initialData={prefill} />
}
