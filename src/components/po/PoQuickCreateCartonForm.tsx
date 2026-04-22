'use client'

import type { Dispatch, FormEvent, SetStateAction } from 'react'
import {
  BOARD_GRADES,
  COATING_TYPES,
  EMBOSSING_TYPES,
  FOIL_TYPES,
  PAPER_TYPES,
} from '@/lib/constants'
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
}

const comboboxControl =
  'border-ds-line/80 bg-ds-elevated/50 shadow-sm transition-[border-color,box-shadow] duration-150 hover:bg-ds-elevated/70 focus-within:ring-2 focus-within:ring-ds-brand/20'
const comboboxInput = 'text-sm text-ds-ink placeholder:text-ds-ink-faint'
const errRing = 'ring-1 ring-ds-error/40 !border-ds-error/60'

type Props = {
  values: PoQuickCreateCartonValues
  setValues: Dispatch<SetStateAction<PoQuickCreateCartonValues>>
  errors: Record<string, string>
  saving: boolean
  onSubmit: (e: FormEvent) => void
}

export function PoQuickCreateCartonForm({ values, setValues, errors, saving, onSubmit }: Props) {
  const set = (patch: Partial<PoQuickCreateCartonValues>) =>
    setValues((prev) => ({ ...prev, ...patch }))

  return (
    <form onSubmit={onSubmit} className="space-y-4 text-sm">
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
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">L</label>
          <input
            type="number"
            step={0.01}
            value={values.sizeL}
            onChange={(e) => set({ sizeL: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">W</label>
          <input
            type="number"
            step={0.01}
            value={values.sizeW}
            onChange={(e) => set({ sizeW: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">H</label>
          <input
            type="number"
            step={0.01}
            value={values.sizeH}
            onChange={(e) => set({ sizeH: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
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
        <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Board grade</label>
        <PackagingEnumCombobox
          aria-label="Board grade"
          options={BOARD_GRADES}
          value={values.boardGrade || null}
          onChange={(v) => set({ boardGrade: v ?? '' })}
          controlClassName={comboboxControl}
          inputClassName={comboboxInput}
          className="w-full"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">GSM</label>
          <input
            type="number"
            value={values.gsm}
            onChange={(e) => set({ gsm: e.target.value })}
            className="ds-input w-full [color-scheme:dark] tabular-nums"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Paper</label>
          <PackagingEnumCombobox
            aria-label="Paper / board"
            options={PAPER_TYPES}
            value={values.paperType || null}
            onChange={(v) => set({ paperType: v ?? '' })}
            controlClassName={comboboxControl}
            inputClassName={comboboxInput}
            className="w-full"
          />
        </div>
      </div>
      <div>
        <p className="mb-1 block text-xs font-medium text-ds-ink-muted">Coating / Emboss / Foil</p>
        <div className="mb-2">
          <PackagingEnumCombobox
            aria-label="Coating"
            options={COATING_TYPES}
            value={values.coatingType || null}
            onChange={(v) => set({ coatingType: v ?? '' })}
            controlClassName={comboboxControl}
            inputClassName={comboboxInput}
            className="w-full"
          />
        </div>
        <div className="mb-2">
          <PackagingEnumCombobox
            aria-label="Embossing"
            options={EMBOSSING_TYPES}
            value={values.embossingLeafing || null}
            onChange={(v) => set({ embossingLeafing: v ?? '' })}
            controlClassName={comboboxControl}
            inputClassName={comboboxInput}
            className="w-full"
          />
        </div>
        <PackagingEnumCombobox
          aria-label="Foil"
          options={FOIL_TYPES}
          value={values.foilType || null}
          onChange={(v) => set({ foilType: v ?? '' })}
          controlClassName={comboboxControl}
          inputClassName={comboboxInput}
          className="w-full"
        />
      </div>
      <div className="flex justify-end border-t border-ds-line/40 pt-4">
        <Button type="submit" disabled={saving} variant="primary" className="min-w-[8rem]">
          {saving ? 'Saving…' : 'Save Carton'}
        </Button>
      </div>
    </form>
  )
}
