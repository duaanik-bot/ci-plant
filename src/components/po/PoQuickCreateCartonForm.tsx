'use client'

import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import {
  BOARD_GRADES,
  COATING_TYPES,
  EMBOSSING_TYPES,
  FOIL_TYPES,
  PAPER_TYPES,
} from '@/lib/constants'
import { useMaster } from '@/components/masters/MastersProvider'
import { MASTER } from '@/lib/masters/registry'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { Button } from '@/components/design-system/Button'
import { cn } from '@/lib/cn'

export type PoQuickCreateCartonValues = {
  cartonName: string
  artworkCode: string
  sizeL: string
  sizeW: string
  sizeH: string
  rate: string
  gstPct: string
  boardGrade: string
  gsm: string
  paperType: string
  coatingType: string
  embossingLeafing: string
  foilType: string
  pastingType: string
}

const comboboxControl =
  'bg-ds-elevated/50 shadow-sm transition-[border-color,box-shadow] duration-150 hover:bg-ds-elevated/70 focus-within:ring-2 focus-within:ring-ds-brand/20'
const comboboxInput = 'text-sm text-ds-ink placeholder:text-ds-ink-faint'
const errRing = 'ring-1 ring-ds-error/40'

type Props = {
  values: PoQuickCreateCartonValues
  setValues: Dispatch<SetStateAction<PoQuickCreateCartonValues>>
  errors: Record<string, string>
  saving: boolean
  onSubmit: (e: FormEvent) => void
}

export function PoQuickCreateCartonForm({ values, setValues, errors, saving, onSubmit }: Props) {
  // Sourced from the cached master registry; dropdowns store the human
  // label (legacy carton/PO records store labels, not codes). Fall back to
  // the static constants when a category has no values yet.
  const boardTypeMaster = useMaster(MASTER.BOARD_TYPE)
  const coatingMaster = useMaster(MASTER.COATING)
  const embossMaster = useMaster(MASTER.EMBOSS)
  const foilMaster = useMaster(MASTER.FOIL)
  const pastingMaster = useMaster(MASTER.PASTING)
  const paperOptions = boardTypeMaster.options.length
    ? boardTypeMaster.options.map((o) => o.label)
    : (PAPER_TYPES as unknown as string[])
  const boardGradeOptions = boardTypeMaster.options.length
    ? boardTypeMaster.options.map((o) => o.label)
    : (BOARD_GRADES as unknown as string[])
  const coatingOptions = coatingMaster.options.length
    ? coatingMaster.options.map((o) => o.label)
    : (COATING_TYPES as unknown as string[])
  const embossOptions = embossMaster.options.length
    ? embossMaster.options.map((o) => o.label)
    : (EMBOSSING_TYPES as unknown as string[])
  const foilOptions = foilMaster.options.length
    ? foilMaster.options.map((o) => o.label)
    : (FOIL_TYPES as unknown as string[])
  const pastingOptions = pastingMaster.options.map((o) => o.label)

  const set = (patch: Partial<PoQuickCreateCartonValues>) =>
    setValues((prev) => ({ ...prev, ...patch }))

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onSubmit(e)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 text-sm">
      <div>
        <label className="mb-1 block text-xs font-medium text-ds-ink-muted">
          Carton name<span className="text-ds-error">*</span>
        </label>
        <input
          type="text"
          value={values.cartonName}
          onChange={(e) => set({ cartonName: e.target.value })}
          className={cn(
            'ds-input w-full [color-scheme:dark] placeholder:text-ds-ink-faint',
            errors.cartonName && errRing,
          )}
        />
        {errors.cartonName ? <p className="mt-1 text-xs text-ds-error">{errors.cartonName}</p> : null}
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Artwork Code (AW)</label>
        <input
          type="text"
          value={values.artworkCode}
          onChange={(e) => set({ artworkCode: e.target.value.toUpperCase() })}
          className="ds-input w-full font-mono text-sm [color-scheme:dark] placeholder:text-ds-ink-faint"
          placeholder="e.g. AW-12345"
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">L<span className="text-ds-error">*</span></label>
          <input
            type="number"
            step={0.01}
            value={values.sizeL}
            onChange={(e) => set({ sizeL: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
          {errors.sizeL ? <p className="mt-1 text-xs text-ds-error">{errors.sizeL}</p> : null}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">W<span className="text-ds-error">*</span></label>
          <input
            type="number"
            step={0.01}
            value={values.sizeW}
            onChange={(e) => set({ sizeW: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
          {errors.sizeW ? <p className="mt-1 text-xs text-ds-error">{errors.sizeW}</p> : null}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">H<span className="text-ds-error">*</span></label>
          <input
            type="number"
            step={0.01}
            value={values.sizeH}
            onChange={(e) => set({ sizeH: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
          {errors.sizeH ? <p className="mt-1 text-xs text-ds-error">{errors.sizeH}</p> : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Rate</label>
          <input
            type="number"
            step={0.01}
            value={values.rate}
            onChange={(e) => set({ rate: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">GST%</label>
          <input
            type="number"
            min={0}
            max={28}
            value={values.gstPct}
            onChange={(e) => set({ gstPct: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Board grade<span className="text-ds-error">*</span></label>
        <PackagingEnumCombobox
          aria-label="Board grade"
          options={boardGradeOptions}
          value={values.boardGrade || null}
          onChange={(v) => set({ boardGrade: v ?? '' })}
          controlClassName={comboboxControl}
          inputClassName={comboboxInput}
          className="w-full"
        />
        {errors.boardGrade ? <p className="mt-1 text-xs text-ds-error">{errors.boardGrade}</p> : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">GSM<span className="text-ds-error">*</span></label>
          <input
            type="number"
            value={values.gsm}
            onChange={(e) => set({ gsm: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
          {errors.gsm ? <p className="mt-1 text-xs text-ds-error">{errors.gsm}</p> : null}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Paper</label>
          <PackagingEnumCombobox
            aria-label="Paper / board"
            options={paperOptions}
            value={values.paperType || null}
            onChange={(v) => set({ paperType: v ?? '' })}
            controlClassName={comboboxControl}
            inputClassName={comboboxInput}
            className="w-full"
          />
        </div>
      </div>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Coating</label>
          <PackagingEnumCombobox
            aria-label="Coating"
            options={coatingOptions}
            value={values.coatingType || null}
            onChange={(v) => set({ coatingType: v ?? '' })}
            controlClassName={comboboxControl}
            inputClassName={comboboxInput}
            className="w-full"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Emboss</label>
          <PackagingEnumCombobox
            aria-label="Embossing"
            options={embossOptions}
            value={values.embossingLeafing || null}
            onChange={(v) => set({ embossingLeafing: v ?? '' })}
            controlClassName={comboboxControl}
            inputClassName={comboboxInput}
            className="w-full"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Foil</label>
          <PackagingEnumCombobox
            aria-label="Foil"
            options={foilOptions}
            value={values.foilType || null}
            onChange={(v) => set({ foilType: v ?? '' })}
            controlClassName={comboboxControl}
            inputClassName={comboboxInput}
            className="w-full"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Pasting</label>
          <PackagingEnumCombobox
            aria-label="Pasting"
            options={pastingOptions}
            value={values.pastingType || null}
            onChange={(v) => set({ pastingType: v ?? '' })}
            controlClassName={comboboxControl}
            inputClassName={comboboxInput}
            className="w-full"
          />
        </div>
      </div>
      <div className="flex justify-end pt-4">
        <Button type="submit" disabled={saving} variant="primary" className="min-w-[8rem]">
          {saving ? 'Saving…' : 'Save Carton'}
        </Button>
      </div>
    </form>
  )
}
