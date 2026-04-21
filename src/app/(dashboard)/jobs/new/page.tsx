'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type Customer = { id: string; name: string }
type Machine = { id: string; machineCode: string; name: string; stdWastePct: number }
type Inventory = { id: string; materialCode: string; description: string; unit: string }

export default function NewJobPage() {
  const router = useRouter()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [materials, setMaterials] = useState<Inventory[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [customerId, setCustomerId] = useState('')
  const [productName, setProductName] = useState('')
  const [qtyOrdered, setQtyOrdered] = useState('')
  const [imposition, setImposition] = useState('')
  const [machineOrder, setMachineOrder] = useState<string[]>([])
  const [boardMaterialId, setBoardMaterialId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/customers').then((r) => r.json()).catch(() => []),
      fetch('/api/machines').then((r) => r.json()).catch(() => []),
      fetch('/api/inventory').then((r) => r.json()).catch(() => []),
    ]).then(([c, m, inv]) => {
      const custList = Array.isArray(c) ? c : []
      const machList = Array.isArray(m) ? m : []
      const invList = Array.isArray(inv) ? inv : []
      setCustomers(custList)
      setMachines(machList)
      setMaterials(invList)
      if (machList.length) setMachineOrder(machList.map((x: Machine) => x.id))
    }).finally(() => setLoading(false))
  }, [])

  const netSheets = imposition && qtyOrdered
    ? Math.ceil(Number(qtyOrdered) / Number(imposition))
    : 0
  const pressMachine = machineOrder.length
    ? machines.find((m) => m.machineCode.match(/^CI-0[123]$/) && machineOrder.includes(m.id))
    : null
  const wastePct = pressMachine ? Number(pressMachine.stdWastePct) : 0
  const approvedSheets = netSheets > 0 ? Math.ceil(netSheets * (1 + wastePct / 100)) : 0

  const requiredErrors: Record<string, string> = {}
  if (!customerId.trim()) requiredErrors.customerId = 'Customer is required'
  if (!productName.trim()) requiredErrors.productName = 'Product name is required'
  if (!qtyOrdered || Number(qtyOrdered) < 1) requiredErrors.qtyOrdered = 'Qty ordered must be at least 1'
  if (!imposition || Number(imposition) < 1) requiredErrors.imposition = 'Imposition must be at least 1'
  if (!dueDate.trim()) requiredErrors.dueDate = 'Due date is required'
  if (!machineOrder.length) requiredErrors.machineSequence = 'Select at least one machine'
  const isFormValid = Object.keys(requiredErrors).length === 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setFormError('')

    const clientErrors: Record<string, string> = {}
    if (!customerId.trim()) clientErrors.customerId = 'Customer is required'
    if (!productName.trim()) clientErrors.productName = 'Product name is required'
    if (!qtyOrdered || Number(qtyOrdered) < 1) clientErrors.qtyOrdered = 'Qty ordered must be at least 1'
    if (!imposition || Number(imposition) < 1) clientErrors.imposition = 'Imposition must be at least 1'
    if (!dueDate.trim()) clientErrors.dueDate = 'Due date is required'
    if (!machineOrder.length) clientErrors.machineSequence = 'Select at least one machine'
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      setFormError('Please fill all required fields.')
      return
    }

    setSubmitting(true)
    try {
      const payload = {
        customerId: customerId.trim(),
        productName: productName.trim(),
        qtyOrdered: Number(qtyOrdered),
        imposition: Number(imposition),
        machineSequence: machineOrder,
        dueDate: dueDate.trim(),
        specialInstructions: specialInstructions.trim() || undefined,
        boardMaterialId: boardMaterialId.trim() || undefined,
      }
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        const errors: Record<string, string> = {}
        if (data.fields && typeof data.fields === 'object') {
          Object.assign(errors, data.fields)
        }
        if (data.fieldErrors && typeof data.fieldErrors === 'object' && Object.keys(errors).length === 0) {
          for (const [key, val] of Object.entries(data.fieldErrors)) {
            const arr = val as string[]
            if (Array.isArray(arr) && arr[0]) errors[key] = arr[0]
          }
        }
        console.error('[jobs/new] API validation failed:', data)
        setFieldErrors(errors)
        setFormError(
          data.formErrors?.[0] ||
            (Object.keys(errors).length ? 'Please fix the errors below.' : data.error || 'Failed to create job')
        )
        if (!Object.keys(errors).length && !data.formErrors?.[0]) {
          toast.error(data.error || 'Failed to create job')
        }
        return
      }
      toast.success('Job created successfully')
      router.push('/jobs')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create job')
      setFormError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  function moveMachine(index: number, dir: 1 | -1) {
    const next = index + dir
    if (next < 0 || next >= machineOrder.length) return
    const copy = [...machineOrder]
    ;[copy[index], copy[next]] = [copy[next], copy[index]]
    setMachineOrder(copy)
  }

  function fillTestData() {
    const firstCustomer = customers[0]
    const firstMaterial = materials.find((m) => m.unit === 'sheets' || m.unit === 'sheet')
    if (firstCustomer) setCustomerId(firstCustomer.id)
    setProductName('Test Product 5000ct')
    setQtyOrdered('5000')
    setImposition('24')
    const d = new Date()
    d.setDate(d.getDate() + 14)
    setDueDate(d.toISOString().slice(0, 10))
    if (machines.length) setMachineOrder(machines.map((m) => m.id))
    if (firstMaterial) setBoardMaterialId(firstMaterial.id)
    setSpecialInstructions('Test order – can be deleted')
    setFieldErrors({})
    setFormError('')
  }

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/jobs" className="text-slate-400 hover:text-foreground text-sm">
          ← Jobs
        </Link>
        <h1 className="text-xl font-bold text-amber-400">New job</h1>
      </div>

      <p className="text-slate-400 text-sm mb-4">
        Required: Customer, Product name, Qty ordered, Imposition, Due date, and at least one machine in sequence.
      </p>

      {formError && (
        <div className="p-3 rounded-lg bg-red-900/30 border border-red-700 text-red-200 text-sm">
          {formError}
        </div>
      )}

      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={fillTestData}
          className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
        >
          Fill test data
        </button>
        <span className="text-slate-500 text-xs">Pre-fills form with sample values</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Customer *</label>
          <select
            value={customerId}
            onChange={(ev) => { setCustomerId(ev.target.value); setFieldErrors((prev) => ({ ...prev, customerId: '' })) }}
            required
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
              (fieldErrors.customerId || requiredErrors.customerId) ? 'border-red-500' : 'border-slate-600'
            }`}
          >
            <option value="">Select customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {(fieldErrors.customerId || requiredErrors.customerId) && (
            <p className="mt-1 text-sm text-red-400">{fieldErrors.customerId || requiredErrors.customerId}</p>
          )}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Product name *</label>
          <input
            type="text"
            value={productName}
            onChange={(ev) => { setProductName(ev.target.value); setFieldErrors((prev) => ({ ...prev, productName: '' })) }}
            required
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
              (fieldErrors.productName || requiredErrors.productName) ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {(fieldErrors.productName || requiredErrors.productName) && (
            <p className="mt-1 text-sm text-red-400">{fieldErrors.productName || requiredErrors.productName}</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Qty ordered *</label>
            <input
              type="number"
              min={1}
              value={qtyOrdered}
              onChange={(ev) => { setQtyOrdered(ev.target.value); setFieldErrors((prev) => ({ ...prev, qtyOrdered: '' })) }}
              required
              className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
                (fieldErrors.qtyOrdered || requiredErrors.qtyOrdered) ? 'border-red-500' : 'border-slate-600'
              }`}
            />
            {(fieldErrors.qtyOrdered || requiredErrors.qtyOrdered) && (
              <p className="mt-1 text-sm text-red-400">{fieldErrors.qtyOrdered || requiredErrors.qtyOrdered}</p>
            )}
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Imposition *</label>
            <input
              type="number"
              min={1}
              value={imposition}
              onChange={(ev) => { setImposition(ev.target.value); setFieldErrors((prev) => ({ ...prev, imposition: '' })) }}
              required
              className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
                (fieldErrors.imposition || requiredErrors.imposition) ? 'border-red-500' : 'border-slate-600'
              }`}
            />
            {(fieldErrors.imposition || requiredErrors.imposition) && (
              <p className="mt-1 text-sm text-red-400">{fieldErrors.imposition || requiredErrors.imposition}</p>
            )}
          </div>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Due date *</label>
          <input
            type="date"
            value={dueDate}
            onChange={(ev) => { setDueDate(ev.target.value); setFieldErrors((prev) => ({ ...prev, dueDate: '' })) }}
            required
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
              (fieldErrors.dueDate || requiredErrors.dueDate) ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {(fieldErrors.dueDate || requiredErrors.dueDate) && (
            <p className="mt-1 text-sm text-red-400">{fieldErrors.dueDate || requiredErrors.dueDate}</p>
          )}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Machine sequence * (drag to reorder)</label>
          <div className={`space-y-1 ${(fieldErrors.machineSequence || requiredErrors.machineSequence) ? 'rounded-lg border border-red-500' : ''}`}>
            {machineOrder.map((id, i) => {
              const m = machines.find((x) => x.id === id)
              return (
                <div
                  key={id}
                  className="flex items-center gap-2 px-3 py-2 rounded bg-slate-800 border border-slate-600"
                >
                  <button type="button" onClick={() => moveMachine(i, -1)} className="text-slate-400 hover:text-foreground">↑</button>
                  <button type="button" onClick={() => moveMachine(i, 1)} className="text-slate-400 hover:text-foreground">↓</button>
                  <span className="flex-1">{m?.machineCode ?? id} — {m?.name ?? ''}</span>
                </div>
              )
            })}
          </div>
          {(fieldErrors.machineSequence || requiredErrors.machineSequence) && (
            <p className="mt-1 text-sm text-red-400">{fieldErrors.machineSequence || requiredErrors.machineSequence}</p>
          )}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Board material (optional)</label>
          <select
            value={boardMaterialId}
            onChange={(ev) => { setBoardMaterialId(ev.target.value); setFieldErrors((prev) => ({ ...prev, boardMaterialId: '' })) }}
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
              fieldErrors.boardMaterialId ? 'border-red-500' : 'border-slate-600'
            }`}
          >
            <option value="">None</option>
            {materials.filter((m) => m.unit === 'sheets' || m.unit === 'sheet').map((mat) => (
              <option key={mat.id} value={mat.id}>{mat.materialCode} — {mat.description}</option>
            ))}
          </select>
          {fieldErrors.boardMaterialId && (
            <p className="mt-1 text-sm text-red-400">{fieldErrors.boardMaterialId}</p>
          )}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Special instructions</label>
          <textarea
            value={specialInstructions}
            onChange={(e) => setSpecialInstructions(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>

        <div className="p-4 rounded-lg bg-slate-800 border border-slate-600">
          <p className="text-sm font-medium text-slate-300 mb-2">BOM preview</p>
          <p>Net sheets: {netSheets}</p>
          <p>Approved sheets (with waste): {approvedSheets}</p>
          <p>Waste allowance: {wastePct}%</p>
          <p className="text-slate-400 text-xs mt-1">Material will be reserved on create if board material selected.</p>
        </div>

        <button
          type="submit"
          disabled={submitting || !isFormValid}
          className="w-full py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-primary-foreground font-medium"
        >
          {submitting ? 'Creating…' : isFormValid ? 'Create job' : 'Fill required fields to continue'}
        </button>
      </form>
    </div>
  )
}
