'use client'

import { readCartonSpecPack } from '@/lib/carton-spec-pack'

type Props = { specPack: unknown; specOverrides: unknown }

function Row({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === '') return null
  const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-ds-ink-muted">{label}</span>
      <span className="font-medium text-foreground">{text}</span>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-ds-md bg-ds-card p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ds-ink-faint">{title}</h4>
      {children}
    </div>
  )
}

export function SpecPackPanel({ specPack, specOverrides }: Props) {
  const { pack, legacy } = readCartonSpecPack({ specPack, specOverrides })
  const overridden = !!(
    specOverrides &&
    typeof specOverrides === 'object' &&
    (specOverrides as Record<string, unknown>).specPack
  )

  if (legacy) {
    return (
      <div className="rounded-ds-md bg-ds-card p-3 text-sm text-ds-ink-muted">
        No locked spec pack (legacy line — entered before spec-pack snapshotting).
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ds-ink">Locked Spec Pack</h3>
        {overridden && (
          <span className="rounded bg-[var(--warning-bg)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ds-warning">
            Overridden for this line
          </span>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Group title="Board">
          <Row label="Board grade" value={pack.board.boardGrade} />
          <Row label="GSM" value={pack.board.gsm} />
          <Row label="Paper type" value={pack.board.paperType} />
          <Row label="Caliper (µm)" value={pack.board.caliperMicrons} />
          <Row label="Ply" value={pack.board.plyCount} />
        </Group>
        <Group title="Dimensions">
          <Row label="Finished L" value={pack.dimensions.finishedL} />
          <Row label="Finished W" value={pack.dimensions.finishedW} />
          <Row label="Finished H" value={pack.dimensions.finishedH} />
          <Row label="Blank L" value={pack.dimensions.blankL} />
          <Row label="Blank W" value={pack.dimensions.blankW} />
          <Row label="Tolerance" value={pack.dimensions.dimensionTol} />
        </Group>
        <Group title="Sheet & UPS">
          <Row label="Sheet size L" value={pack.sheet.sheetSizeL} />
          <Row label="Sheet size W" value={pack.sheet.sheetSizeW} />
          <Row label="UPS" value={pack.sheet.ups} />
        </Group>
        <Group title="Print">
          <Row label="Printing type" value={pack.print.printingType} />
          <Row label="Colours" value={pack.print.numberOfColours} />
          <Row label="Back print" value={pack.print.backPrint} />
          <Row label="Artwork code" value={pack.print.artworkCode} />
        </Group>
        <Group title="Finishing">
          <Row label="Coating" value={pack.finishing.coatingType} />
          <Row label="Laminate" value={pack.finishing.laminateType} />
          <Row label="Foil" value={pack.finishing.foilType} />
          <Row label="Emboss/Leafing" value={pack.finishing.embossingLeafing} />
          <Row label="Spot UV" value={pack.finishing.spotUv} />
          <Row label="Braille" value={pack.finishing.braille} />
        </Group>
        <Group title="Tooling & Pharma">
          <Row label="Pasting style" value={pack.tooling.pastingStyle} />
          <Row label="Drug schedule" value={pack.pharma.drugSchedule} />
          <Row label="Schedule M" value={pack.pharma.scheduleMRequired} />
        </Group>
      </div>
    </div>
  )
}
