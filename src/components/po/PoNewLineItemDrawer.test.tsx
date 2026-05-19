import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PoNewLineItemDrawer } from './PoNewLineItemDrawer'

vi.mock('@/components/masters/MastersProvider', () => ({
  useMaster: () => ({ options: [] }),
}))

const baseLine = {
  cartonId: 'c1', cartonName: 'ACEBROBID', cartonSize: '', quantity: '2000',
  artworkCode: 'AW-001', backPrint: 'No', wastagePct: '10', rate: '1.81',
  gstPct: '12', gsm: '350', coatingType: 'Full UV Coating',
  embossingLeafing: '', paperType: 'Ivory', boardGrade: 'SBS (Solid Bleached Sulphate)',
  foilType: '', remarks: '', dieMasterId: '', toolingDieType: '', toolingDims: '',
  toolingUnlinked: false, pastingStyle: 'BSO', masterPastingStyleMissing: false,
  ghostFromMaster: { size: false, gsm: false, pasting: false, rate: false },
  specProvenance: { boardGrade: 'spec', paperType: 'master', gsm: 'override' },
  specPackBase: { v: 1, board: { caliperMicrons: 450, plyCount: 1 },
    dimensions: { finishedL: 59 }, sheet: { ups: 6 }, print: {}, finishing: {},
    tooling: {}, linkage: {}, pharma: {}, source: {} },
  specPackLegacy: false,
}

const noop = () => {}

function renderDrawer(line: unknown) {
  return render(
    <PoNewLineItemDrawer
      isOpen lineIndex={0} line={line as never} onClose={noop}
      updateLine={noop as never} updateLineField={noop as never}
      fieldErrors={{}} inputCls="" inputClsGhost="" inputErr="" poMono=""
      masterPasteSavingLine={null} masterPastePopoverLine={null}
      setMasterPastePopoverLine={noop} onSavePastingToMaster={noop as never}
    />,
  )
}

describe('PoNewLineItemDrawer spec-pack UI', () => {
  it('renders provenance badges per field', () => {
    renderDrawer(baseLine)
    expect(screen.getByText(/spec pack/i)).toBeInTheDocument()
    expect(screen.getByText(/^master$/i)).toBeInTheDocument()
    expect(screen.getByText(/overridden/i)).toBeInTheDocument()
  })

  it('renders the read-only spec block with non-editable groups', () => {
    renderDrawer(baseLine)
    expect(screen.getByText(/caliper/i)).toBeInTheDocument()
    expect(screen.getByText(/ups/i)).toBeInTheDocument()
  })

  it('shows the legacy notice when no pack', () => {
    renderDrawer({ ...baseLine, specPackBase: null, specPackLegacy: true, specProvenance: {} })
    expect(screen.getByText(/no locked spec pack/i)).toBeInTheDocument()
  })
})
