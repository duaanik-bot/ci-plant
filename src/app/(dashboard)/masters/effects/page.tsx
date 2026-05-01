'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

type EffectCategory = {
  id: string
  name: string
  sortOrder: number
  active: boolean
  createdAt: string
  updatedAt: string
  valueCount: number
}

type EffectValue = {
  id: string
  categoryId: string
  value: string
  abbreviation: string | null
  impactOn: string | null
  description: string | null
  sortOrder: number
  active: boolean
  createdAt: string
  updatedAt: string
}

type DrawerMode = 'create-category' | 'edit-category' | 'create-value' | 'edit-value' | null
type ApiErrorPayload = { error?: string; fields?: Record<string, string> }

async function readApiPayload<T>(res: Response): Promise<T | ApiErrorPayload> {
  const text = await res.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text) as T | ApiErrorPayload
  } catch {
    return { error: text.slice(0, 240) || `HTTP ${res.status}` }
  }
}

export default function EffectsMasterPage() {
  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState<EffectCategory[]>([])
  const [values, setValues] = useState<EffectValue[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('')
  const [search, setSearch] = useState('')

  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null)
  const [saving, setSaving] = useState(false)
  const [categoryForm, setCategoryForm] = useState({ name: '', sortOrder: '100', active: true })
  const [valueForm, setValueForm] = useState({ value: '', abbreviation: '', impactOn: '', description: '', sortOrder: '100', active: true })
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null)
  const [editingValueId, setEditingValueId] = useState<string | null>(null)
  const [categoryErrors, setCategoryErrors] = useState<{ name?: string; submit?: string }>({})
  const [valueError, setValueError] = useState<string | null>(null)

  const selectedCategory = useMemo(
    () => categories.find((c) => c.id === selectedCategoryId) ?? null,
    [categories, selectedCategoryId],
  )

  const filteredValues = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return values
    return values.filter((v) =>
      [v.value, v.description ?? '', String(v.sortOrder), v.active ? 'active' : 'inactive']
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [search, values])

  async function loadCategories() {
    const res = await fetch('/api/masters/minimasters/categories', { cache: 'no-store' })
    const data = (await readApiPayload<EffectCategory[]>(res)) as EffectCategory[] | ApiErrorPayload
    if (!res.ok) throw new Error((data as ApiErrorPayload).error || 'Failed to load categories')
    const next = Array.isArray(data) ? data : []
    setCategories(next)
    if (!selectedCategoryId && next.length > 0) setSelectedCategoryId(next[0]!.id)
    if (selectedCategoryId && !next.some((c) => c.id === selectedCategoryId)) {
      setSelectedCategoryId(next[0]?.id ?? '')
    }
  }

  async function loadValues(categoryId: string) {
    if (!categoryId) {
      setValues([])
      return
    }
    const res = await fetch(`/api/masters/minimasters/values?categoryId=${encodeURIComponent(categoryId)}`, { cache: 'no-store' })
    const data = (await readApiPayload<EffectValue[]>(res)) as EffectValue[] | ApiErrorPayload
    if (!res.ok) throw new Error((data as ApiErrorPayload).error || 'Failed to load values')
    setValues(Array.isArray(data) ? data : [])
  }

  async function refreshAll(categoryIdOverride?: string) {
    await loadCategories()
    const target = categoryIdOverride ?? selectedCategoryId
    if (target) await loadValues(target)
  }

  useEffect(() => {
    void (async () => {
      try {
        await loadCategories()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!selectedCategoryId) return
    void loadValues(selectedCategoryId).catch(() => toast.error('Failed to load values'))
  }, [selectedCategoryId])

  function openCreateCategory() {
    setDrawerMode('create-category')
    setEditingCategoryId(null)
    setCategoryForm({ name: '', sortOrder: '100', active: true })
    setCategoryErrors({})
  }

  function openEditCategory(c: EffectCategory) {
    setDrawerMode('edit-category')
    setEditingCategoryId(c.id)
    setCategoryForm({ name: c.name, sortOrder: String(c.sortOrder), active: c.active })
    setCategoryErrors({})
  }

  function openCreateValue() {
    if (!selectedCategoryId) return
    setDrawerMode('create-value')
    setEditingValueId(null)
    setValueForm({ value: '', abbreviation: '', impactOn: '', description: '', sortOrder: '100', active: true })
  }

  function openEditValue(v: EffectValue) {
    setDrawerMode('edit-value')
    setEditingValueId(v.id)
    setValueForm({
      value: v.value,
      abbreviation: v.abbreviation ?? '',
      impactOn: v.impactOn ?? '',
      description: v.description ?? '',
      sortOrder: String(v.sortOrder),
      active: v.active,
    })
  }

  async function createCategory() {
    const name = categoryForm.name.trim()
    if (!name) {
      setCategoryErrors({ name: 'Category name is required' })
      toast.error('Category name is required')
      return
    }

    setSaving(true)
    setCategoryErrors({})
    try {
      const payload = {
        name,
        sortOrder: Number(categoryForm.sortOrder || 100),
        status: categoryForm.active ? 'active' : 'inactive',
        active: categoryForm.active,
      }
      console.log('[EffectsMaster] createCategory payload', payload)

      const res = await fetch(
        '/api/masters/minimasters/categories',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const json = (await readApiPayload<EffectCategory>(res)) as EffectCategory | ApiErrorPayload
      console.log('[EffectsMaster] createCategory response', { ok: res.ok, status: res.status, data: json })
      if (!res.ok) {
        const api = json as ApiErrorPayload
        if (api.fields?.name) setCategoryErrors({ name: api.fields.name })
        throw new Error(api.error || 'Save failed')
      }

      const created = json as Partial<EffectCategory> & { id: string; name: string; sortOrder: number; active: boolean }
      const nextCategory: EffectCategory = {
        id: created.id,
        name: created.name,
        sortOrder: created.sortOrder ?? Number(categoryForm.sortOrder || 100),
        active: created.active ?? categoryForm.active,
        createdAt: created.createdAt ?? new Date().toISOString(),
        updatedAt: created.updatedAt ?? new Date().toISOString(),
        valueCount: 0,
      }
      setCategories((prev) =>
        [...prev, nextCategory].sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name)),
      )
      setSelectedCategoryId(nextCategory.id)

      setCategoryForm({ name: '', sortOrder: '100', active: true })
      setDrawerMode(null)
      toast.success('Category created')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed'
      setCategoryErrors({ submit: msg })
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  async function updateCategory() {
    const name = categoryForm.name.trim()
    if (!name) {
      setCategoryErrors({ name: 'Category name is required' })
      toast.error('Category name is required')
      return
    }
    if (!editingCategoryId) return

    setSaving(true)
    setCategoryErrors({})
    try {
      const payload = {
        name,
        sortOrder: Number(categoryForm.sortOrder || 100),
        status: categoryForm.active,
        active: categoryForm.active,
      }
      console.log('[EffectsMaster] updateCategory payload', payload)

      const res = await fetch(`/api/masters/minimasters/categories/${editingCategoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = (await readApiPayload<EffectCategory>(res)) as EffectCategory | ApiErrorPayload
      console.log('[EffectsMaster] updateCategory response', { ok: res.ok, status: res.status, data: json })
      if (!res.ok) throw new Error((json as ApiErrorPayload).error || 'Save failed')

      await refreshAll(selectedCategoryId)
      setCategoryForm({ name: '', sortOrder: '100', active: true })
      setDrawerMode(null)
      toast.success('Category updated')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed'
      setCategoryErrors({ submit: msg })
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  async function saveValue() {
    if (!selectedCategoryId) return
    setSaving(true)
    setValueError(null)
    try {
      const trimmedValue = valueForm.value.trim()
      if (!trimmedValue) {
        setValueError('Value name is required')
        toast.error('Value name is required')
        return
      }
      const payload = {
        categoryId: selectedCategoryId,
        value: trimmedValue,
        abbreviation: valueForm.abbreviation.trim() || null,
        impactOn: valueForm.impactOn.trim() || null,
        description: valueForm.description || null,
        sortOrder: Number(valueForm.sortOrder || 100),
        active: valueForm.active,
      }
      const res = await fetch(
        drawerMode === 'edit-value' && editingValueId
          ? `/api/masters/minimasters/values/${editingValueId}`
          : '/api/masters/minimasters/values',
        {
          method: drawerMode === 'edit-value' ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const json = (await readApiPayload<EffectValue>(res)) as EffectValue | ApiErrorPayload
      if (!res.ok) throw new Error((json as ApiErrorPayload).error || 'Save failed')
      toast.success(drawerMode === 'edit-value' ? 'Value updated' : 'Value created')
      setDrawerMode(null)
      await refreshAll(selectedCategoryId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed'
      setValueError(msg)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  async function toggleValueStatus(v: EffectValue, active: boolean) {
    try {
      const res = await fetch(`/api/masters/minimasters/values/${v.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      const json = (await readApiPayload<EffectValue>(res)) as EffectValue | ApiErrorPayload
      if (!res.ok) throw new Error((json as ApiErrorPayload).error || 'Update failed')
      toast.success(active ? 'Value reactivated' : 'Value inactivated')
      await loadValues(selectedCategoryId)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    }
  }

  async function deleteValue(v: EffectValue) {
    if (!confirm(`Delete value "${v.value}"?`)) return
    try {
      const res = await fetch(`/api/masters/minimasters/values/${v.id}`, { method: 'DELETE' })
      const json = (await readApiPayload<{ ok: boolean }>(res)) as { ok?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error || 'Delete failed')
      toast.success('Value deleted')
      await loadValues(selectedCategoryId)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  async function deleteCategory() {
    if (!selectedCategory) return
    if (!confirm(`Delete category "${selectedCategory.name}" and its values?`)) return
    try {
      const res = await fetch(`/api/masters/minimasters/categories/${selectedCategory.id}`, { method: 'DELETE' })
      const json = (await readApiPayload<{ ok: boolean }>(res)) as { ok?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error || 'Delete failed')
      toast.success('Category deleted')
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  if (loading) {
    return <div className="text-sm text-ds-ink-faint">Loading...</div>
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">MiniMasters</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Centralized source of truth for dynamic dropdown values and logic triggers.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search value, description, status..."
              className="ds-input min-h-[40px] w-[18rem]"
            />
            <button
              type="button"
              onClick={openCreateCategory}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
            >
              Add Category
            </button>
            <button
              type="button"
              onClick={openCreateValue}
              disabled={!selectedCategoryId}
              className="rounded-lg border border-[var(--border)] bg-[var(--brand)] px-3 py-2 text-sm text-[var(--brand-foreground)] disabled:opacity-50"
            >
              Add Value
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <aside className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Categories</h3>
          <div className="space-y-1">
            {categories.map((c) => {
              const selected = c.id === selectedCategoryId
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCategoryId(c.id)}
                  onDoubleClick={() => openEditCategory(c)}
                  className={`flex w-full items-center justify-between rounded-md border px-2 py-2 text-left text-sm transition-colors ${
                    selected
                      ? 'border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text-primary)]'
                      : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span>{c.name}</span>
                  <span className="text-xs text-[var(--text-muted)]">{c.valueCount}</span>
                </button>
              )
            })}
            {categories.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-xs text-[var(--text-muted)]">
                No categories yet. Click <span className="font-medium">Add Category</span> to create your first one.
              </div>
            ) : null}
          </div>
          {selectedCategory ? (
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => openEditCategory(selectedCategory)}
                className="text-xs text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
              >
                Edit selected category
              </button>
              <button
                type="button"
                onClick={() => void deleteCategory()}
                className="text-xs text-ds-error underline-offset-2 hover:underline"
              >
                Delete category
              </button>
            </div>
          ) : null}
        </aside>

        <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">{selectedCategory?.name ?? 'Values'}</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] table-fixed border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="px-3 py-2">Value Name</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Abbreviation</th>
                  <th className="px-3 py-2">Impact On</th>
                  <th className="px-3 py-2">Sort Order</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredValues.map((v) => (
                  <tr
                    key={v.id}
                    className="cursor-pointer border-b border-[var(--border)] hover:bg-[var(--bg-muted)]"
                    onClick={() => openEditValue(v)}
                  >
                    <td className="px-3 py-3 font-medium text-[var(--text-primary)]">{v.value}</td>
                    <td className="px-3 py-3 text-[var(--text-muted)]">{v.description || '—'}</td>
                    <td className="px-3 py-3 text-[var(--text-muted)]">{v.abbreviation || '—'}</td>
                    <td className="px-3 py-3 text-[var(--text-muted)]">{v.impactOn || '—'}</td>
                    <td className="px-3 py-3 text-[var(--text-muted)]">{v.sortOrder}</td>
                    <td className="px-3 py-3">
                      <span className="inline-flex rounded-md border border-[var(--border)] bg-[var(--bg-muted)] px-2 py-0.5 text-xs text-[var(--text-primary)]">
                        {v.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => openEditValue(v)}
                        className="mr-3 text-xs text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
                      >
                        Edit
                      </button>
                      {v.active ? (
                        <button
                          type="button"
                          onClick={() => void toggleValueStatus(v, false)}
                          className="text-xs text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
                        >
                          Inactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void toggleValueStatus(v, true)}
                          className="text-xs text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
                        >
                          Reactivate
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void deleteValue(v)}
                        className="ml-3 text-xs text-ds-error underline-offset-2 hover:underline"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredValues.length === 0 ? (
            <div className="mt-4 rounded-md border border-dashed border-[var(--border)] p-5 text-center">
              <p className="text-sm text-[var(--text-muted)]">
                {selectedCategory ? 'No values found for this category.' : 'Select a category to view values.'}
              </p>
            </div>
          ) : null}
        </section>
      </div>

      <SlideOverPanel
        title={
          drawerMode === 'create-category'
            ? 'Add Category'
            : drawerMode === 'edit-category'
              ? 'Edit Category'
              : drawerMode === 'create-value'
                ? 'Add Value'
                : 'Edit Value'
        }
        isOpen={drawerMode != null}
        onClose={() => setDrawerMode(null)}
      >
        {drawerMode === 'create-category' || drawerMode === 'edit-category' ? (
          <form
            className="space-y-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault()
              if (drawerMode === 'create-category') {
                void createCategory()
                return
              }
              void updateCategory()
            }}
          >
            <p className="rounded-md border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-xs text-[var(--text-muted)]">
              Create a category first (for example: Coating), then add detailed values from <span className="font-medium">Add Value</span>.
            </p>
            <div>
              <label className="mb-1 block text-xs text-ds-ink-muted">Category Name</label>
              <input
                className={`ds-input w-full ${categoryErrors.name ? 'border-ds-error/60 ring-1 ring-ds-error/40' : ''}`}
                value={categoryForm.name}
                placeholder="e.g. Coating"
                onChange={(e) => {
                  setCategoryForm((p) => ({ ...p, name: e.target.value }))
                  setCategoryErrors((prev) => ({ ...prev, name: undefined, submit: undefined }))
                }}
              />
              {categoryErrors.name ? <p className="mt-1 text-xs text-ds-error">{categoryErrors.name}</p> : null}
            </div>
            <div>
              <label className="mb-1 block text-xs text-ds-ink-muted">Sort Order</label>
              <input
                type="number"
                className="ds-input w-full"
                value={categoryForm.sortOrder}
                placeholder="100"
                onChange={(e) => setCategoryForm((p) => ({ ...p, sortOrder: e.target.value }))}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-ds-ink-muted">
              <input
                type="checkbox"
                checked={categoryForm.active}
                onChange={(e) => setCategoryForm((p) => ({ ...p, active: e.target.checked }))}
              />
              Active
            </label>
            <div className="pt-2">
              <button type="submit" disabled={saving} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {categoryErrors.submit ? <p className="text-xs text-ds-error">{categoryErrors.submit}</p> : null}
          </form>
        ) : null}

        {drawerMode === 'create-value' || drawerMode === 'edit-value' ? (
          <form
            className="space-y-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault()
              void saveValue()
            }}
          >
            <div>
              <label className="mb-1 block text-xs text-ds-ink-muted">Category</label>
              <input value={selectedCategory?.name ?? ''} readOnly className="ds-input w-full opacity-70" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ds-ink-muted">Value Name</label>
              <input
                className={`ds-input w-full ${valueError ? 'border-ds-error/60 ring-1 ring-ds-error/40' : ''}`}
                value={valueForm.value}
                placeholder="e.g. Gloss"
                onChange={(e) => {
                  setValueForm((p) => ({ ...p, value: e.target.value }))
                  setValueError(null)
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ds-ink-muted">Description</label>
              <textarea
                className="ds-input w-full"
                rows={3}
                placeholder="Optional notes for operators"
                value={valueForm.description}
                onChange={(e) => setValueForm((p) => ({ ...p, description: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ds-ink-muted">Abbreviation</label>
              <input
                className="ds-input w-full"
                value={valueForm.abbreviation}
                placeholder="e.g. SAF"
                onChange={(e) => setValueForm((p) => ({ ...p, abbreviation: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ds-ink-muted">Impact On</label>
              <input
                className="ds-input w-full"
                value={valueForm.impactOn}
                placeholder="e.g. cost_multiplier"
                onChange={(e) => setValueForm((p) => ({ ...p, impactOn: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ds-ink-muted">Sort Order</label>
              <input
                type="number"
                className="ds-input w-full"
                value={valueForm.sortOrder}
                onChange={(e) => setValueForm((p) => ({ ...p, sortOrder: e.target.value }))}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-ds-ink-muted">
              <input type="checkbox" checked={valueForm.active} onChange={(e) => setValueForm((p) => ({ ...p, active: e.target.checked }))} />
              Active
            </label>
            <div className="pt-2">
              <button type="submit" disabled={saving} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {valueError ? <p className="text-xs text-ds-error">{valueError}</p> : null}
          </form>
        ) : null}
      </SlideOverPanel>
    </div>
  )
}
