import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SectionBoardAllocation } from './SectionBoardAllocation'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const baseLine = {
  id: 'L1',
  cartonId: null,
  cartonName: 'Test carton',
  cartonSize: '340×240 mm',
  quantity: 18000,
  artworkCode: null,
  coatingType: null,
  otherCoating: null,
  embossingLeafing: null,
  paperType: 'FBB',
  gsm: 100,
  remarks: null,
  planningStatus: 'planning',
  specOverrides: null,
  po: { id: 'PO1', poNumber: 'PO-2024-0842', poDate: '2026-05-10', customer: { id: 'C1', name: 'Pureflix' } },
  materialQueue: { boardType: 'FBB', sheetLengthMm: 720, sheetWidthMm: 1020, ups: 4 },
} as unknown as PlanningEngineLine

const readinessWithShortage: PlanningEngineReadiness = {
  materialId: 'm1', materialCode: 'ITC-FBB-100',
  boardType: 'FBB', boardClassification: null, size: '720×1020 mm', gsm: 100,
  requiredSheets: 4800, availableSheets: 1240, reservedSheets: 3100,
  incomingSheets: 0, shortageSheets: 3560,
  prId: 'PR-2024-1143', prStatus: 'on_order', grnEta: '2026-05-18',
  status: 'red',
}

describe('SectionBoardAllocation', () => {
  it('renders board, GSM, sheet size and UPS as editable fields plus required sheets', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByLabelText('Board type')).toHaveValue('FBB')
    expect(screen.getByLabelText('GSM')).toHaveValue('100')
    expect(screen.getByLabelText('Sheet length')).toHaveValue('720')
    expect(screen.getByLabelText('Sheet width')).toHaveValue('1020')
    expect(screen.getByLabelText('Units per sheet')).toHaveValue('4')
    expect(screen.getAllByText('4,650 sh').length).toBeGreaterThan(0)
  })

  it('auto-calculates units per sheet from selected parent stock and child size', () => {
    const line = {
      ...baseLine,
      quantity: 8500,
      specOverrides: {
        meta: {
          sheetUnit: 'inch',
          sheetLengthMm: 15,
          sheetWidthMm: 24,
          cutType: 2,
          ups: 4,
          upsEdited: false,
        },
      },
      materialQueue: null,
    } as unknown as PlanningEngineLine
    const readiness: PlanningEngineReadiness = {
      ...readinessWithShortage,
      size: '24.6×31.2',
      requiredSheets: 0,
    }
    render(<SectionBoardAllocation line={line} readiness={readiness} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByLabelText('Units per sheet')).toHaveValue('2')
    expect(screen.getByText('4,250 sh')).toBeInTheDocument()
  })

  it('does not render the old shortage tile under board allocation', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText(/Paper warehouse — shortage/i)).toBeNull()
    expect(screen.getAllByText('1,240 sh').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3,100 sh').length).toBeGreaterThan(0)
    expect(screen.queryByText('3,560 sh')).toBeNull()
  })

  it('does not render the old PR on-order tile when prId is present', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText('PR-2024-1143')).toBeNull()
    expect(screen.queryByText(/ETA 18 May/)).toBeNull()
  })

  it('does not render the old stock-covered tile when shortageSheets is zero', () => {
    const noShortage: PlanningEngineReadiness = { ...readinessWithShortage, shortageSheets: 0, prId: null, status: 'green' }
    render(<SectionBoardAllocation line={baseLine} readiness={noShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText(/Paper warehouse — shortage/i)).toBeNull()
    expect(screen.queryByText(/stock covers required sheets/i)).toBeNull()
  })

  it('keeps readiness loading out of the old board-allocation tile area', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={null} readinessLoading={true} onPatch={async () => true} />)
    expect(screen.queryByText(/Checking material/i)).toBeNull()
  })

  it('does not render the old spec-incomplete warning tile when specComplete is false', () => {
    const lineWithIncomplete = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: {
          specComplete: false,
          specIncompleteReason: 'Missing UPS in spec pack',
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineWithIncomplete} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText(/missing ups in spec pack/i)).toBeNull()
  })

  it('does not render the old spec-incomplete fallback tile', () => {
    const lineNullReason = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: {
          specComplete: false,
          specIncompleteReason: null,
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineNullReason} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText(/spec incomplete/i)).toBeNull()
    expect(screen.queryByText(/reason unavailable/i)).toBeNull()
  })

  it('does NOT render spec-incomplete warning for a legacy line without specComplete', () => {
    const legacyLine = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: {
          boardWanted: 'FBB',
          gsmWanted: 100,
          suggestedBoardOptions: [],
          availableMainSheets: 5000,
          availableLeftoverSheets: 0,
          availableTotalSheets: 5000,
          reservedSheets: 0,
          requiredSheets: 4800,
          stockSignal: 'green' as const,
          // specComplete intentionally omitted — legacy shape
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={legacyLine} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText(/spec incomplete/i)).toBeNull()
  })

  it('commits an edited board type via onPatch on blur', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    render(<SectionBoardAllocation line={baseLine} readiness={readinessWithShortage} readinessLoading={false} onPatch={onPatch} />)
    const input = screen.getByLabelText('Board type')
    fireEvent.change(input, { target: { value: 'SBS' } })
    fireEvent.blur(input)
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ paperType: 'SBS' }))
  })

  it('does not render the old carton-master link control', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const lineWithCarton = {
      ...baseLine,
      paperType: null,
      gsm: null,
      materialQueue: null,
      carton: { paperType: 'SBS', gsm: 300 },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineWithCarton} readiness={null} readinessLoading={false} onPatch={onPatch} />)
    expect(screen.queryByRole('button', { name: /Carton master/ })).toBeNull()
  })

  it('does not render the old board-master dropdown', () => {
    const onSelectBoard = vi.fn().mockResolvedValue(undefined)
    const readinessWithOptions: PlanningEngineReadiness = {
      ...readinessWithShortage,
      suggestedBoardOptions: [
        {
          materialId: 'opt1', materialCode: 'ITC-FBB-100', boardType: 'FBB', gsm: 100,
          size: '720×1020', freeSheets: 1240, availableSheets: 1240, requiredParentSheets: 4800,
          shortageParentSheets: 3560, wastagePct: 12, yieldPct: 78, cutsPerSheet: 6,
          matchType: 'Direct Size', status: 'Partial', tags: [], gsmDelta: 0,
        },
      ],
    }
    render(
      <SectionBoardAllocation
        line={baseLine}
        readiness={readinessWithOptions}
        readinessLoading={false}
        onPatch={async () => true}
        onSelectBoard={onSelectBoard}
      />,
    )
    expect(screen.queryByRole('button', { name: /Board master/ })).toBeNull()
    expect(onSelectBoard).not.toHaveBeenCalled()
  })

  it('does not render the old procurement suggestion tile', () => {
    const lineWithProcurement = {
      ...baseLine,
      planningLedger: {
        boardStockInsight: {
          procurementSuggestion: { boardGrade: 'SBS', gsm: 350, paperType: 'White', suggestedSheets: 1200 },
        },
      },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineWithProcurement} readiness={readinessWithShortage} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText(/1,200/)).toBeNull()
  })

  it('defaults the Sheet unit to inch when nothing is stored', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByLabelText('Sheet unit')).toHaveValue('inch')
  })

  it('no longer renders the Child sheet size tile', () => {
    render(<SectionBoardAllocation line={baseLine} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.queryByText('Child sheet size')).toBeNull()
  })

  it('autopopulates sheet length/width (inches) and UPS from the carton master', () => {
    const lineWithMaster = {
      ...baseLine,
      cartonId: 'CARTON1',
      materialQueue: null,
      carton: { sheetSizeL: 25, sheetSizeW: 36, ups: 8 },
    } as unknown as PlanningEngineLine
    render(<SectionBoardAllocation line={lineWithMaster} readiness={null} readinessLoading={false} onPatch={async () => true} />)
    expect(screen.getByLabelText('Sheet length')).toHaveValue('25')
    expect(screen.getByLabelText('Sheet width')).toHaveValue('36')
    expect(screen.getByLabelText('Units per sheet')).toHaveValue('8')
  })

  it('saves an edited sheet length back to the carton master (inches) and the line spec', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const onSaveCartonMaster = vi.fn().mockResolvedValue(undefined)
    const lineWithMaster = {
      ...baseLine,
      cartonId: 'CARTON1',
      materialQueue: null,
      carton: { sheetSizeL: 25, sheetSizeW: 36, ups: 8 },
    } as unknown as PlanningEngineLine
    render(
      <SectionBoardAllocation
        line={lineWithMaster}
        readiness={null}
        readinessLoading={false}
        onPatch={onPatch}
        onSaveCartonMaster={onSaveCartonMaster}
      />,
    )
    const input = screen.getByLabelText('Sheet length')
    fireEvent.click(screen.getByRole('button', { name: 'Cut type' }))
    fireEvent.click(screen.getByRole('button', { name: '2-cut' }))
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    // Only the changed dimension is pushed to the master (width is unchanged at 36).
    expect(onSaveCartonMaster).toHaveBeenCalledWith({ sheetSizeL: 30 })
    expect(onPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        specOverrides: expect.objectContaining({
          meta: expect.objectContaining({
            sheetLengthMm: 30,
            sheetUnit: 'inch',
            cutPlanChildSizes: [expect.objectContaining({ lMm: 30 * 25.4, wMm: 36 * 25.4, qty: 2 })],
            cutPlanEdited: false,
          }),
        }),
      }),
    )
  })

  it('displays mm-backed sheetSpec values as editable inches', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const lineWithMmSpec = {
      ...baseLine,
      materialQueue: null,
      specOverrides: { meta: { sheetUnit: 'inch' } },
      sheetSpec: {
        lengthMm: 381,
        widthMm: 609.6,
        unit: 'inch',
        cutType: 2,
        parentSize: '15 x 24',
        childSize: null,
      },
    } as unknown as PlanningEngineLine

    render(
      <SectionBoardAllocation
        line={lineWithMmSpec}
        readiness={null}
        readinessLoading={false}
        onPatch={onPatch}
      />,
    )

    expect(screen.getByLabelText('Sheet length')).toHaveValue('15')
    expect(screen.getByLabelText('Sheet width')).toHaveValue('24')

    fireEvent.change(screen.getByLabelText('Sheet length'), { target: { value: '16.5' } })
    expect(screen.getByLabelText('Sheet length')).toHaveValue('16.5')
  })

  it('saves an edited units-per-sheet back to the carton master', () => {
    const onPatch = vi.fn().mockResolvedValue(true)
    const onSaveCartonMaster = vi.fn().mockResolvedValue(undefined)
    const lineWithMaster = {
      ...baseLine,
      cartonId: 'CARTON1',
      materialQueue: null,
      carton: { sheetSizeL: 25, sheetSizeW: 36, ups: 8 },
    } as unknown as PlanningEngineLine
    render(
      <SectionBoardAllocation
        line={lineWithMaster}
        readiness={null}
        readinessLoading={false}
        onPatch={onPatch}
        onSaveCartonMaster={onSaveCartonMaster}
      />,
    )
    const input = screen.getByLabelText('Units per sheet')
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.blur(input)
    expect(onSaveCartonMaster).toHaveBeenCalledWith({ ups: 12 })
  })

  it('does not render the old unreserve banner action below board allocation', async () => {
    const onUnreserve = vi.fn().mockResolvedValue(undefined)
    const noShortageWithReserved: PlanningEngineReadiness = {
      ...readinessWithShortage,
      shortageSheets: 0,
      reservedSheets: 3100,
      prId: null,
      status: 'green',
    }
    render(
      <SectionBoardAllocation
        line={baseLine}
        readiness={noShortageWithReserved}
        readinessLoading={false}
        onPatch={async () => true}
        onUnreserve={onUnreserve}
      />,
    )
    expect(screen.queryByText(/stock covers required sheets/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Unreserve/i })).toBeNull()
    expect(onUnreserve).not.toHaveBeenCalled()
  })
})
