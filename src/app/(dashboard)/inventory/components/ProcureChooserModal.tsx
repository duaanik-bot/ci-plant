'use client'

import { FileText, ShoppingCart } from 'lucide-react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import type { PaperWarehouseRow } from '../page'

type Props = {
  isOpen: boolean
  onClose: () => void
  row: PaperWarehouseRow | null
  /** Route to the Purchase Requisition flow (internal request → approval → PO). */
  onChoosePr: (row: PaperWarehouseRow) => void
  /** Route to the direct vendor Purchase Order flow (no PR). */
  onChoosePo: (row: PaperWarehouseRow) => void
}

export function ProcureChooserModal({ isOpen, onClose, row, onChoosePr, onChoosePo }: Props) {
  if (!row) return null

  const subtitle = [row.board_type_id, row.gsm ? `${row.gsm} gsm` : null, row.size_display]
    .filter(Boolean)
    .join(' · ')

  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={`Procure — ${row.material_code}`}
      metadata={subtitle || undefined}
      mode="preview"
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ds-ink-muted">How do you want to procure this material?</p>

        <button
          type="button"
          onClick={() => onChoosePr(row)}
          className="flex items-start gap-3 rounded-ds-md border border-ds-line/40 p-4 text-left transition-colors hover:border-ds-primary hover:bg-ds-primary/5"
        >
          <FileText size={20} className="mt-0.5 shrink-0 text-ds-primary" />
          <span>
            <span className="block text-sm font-semibold text-ds-ink">Raise Purchase Requisition</span>
            <span className="mt-0.5 block text-xs text-ds-ink-muted">
              Internal request routed to the PR board for approval, then converted to a vendor PO. Use when procurement sign-off is required.
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => onChoosePo(row)}
          className="flex items-start gap-3 rounded-ds-md border border-ds-line/40 p-4 text-left transition-colors hover:border-ds-primary hover:bg-ds-primary/5"
        >
          <ShoppingCart size={20} className="mt-0.5 shrink-0 text-ds-primary" />
          <span>
            <span className="block text-sm font-semibold text-ds-ink">Create Purchase Order</span>
            <span className="mt-0.5 block text-xs text-ds-ink-muted">
              Direct vendor PO with no PR. Fast-track when the vendor and quantity are already decided.
            </span>
          </span>
        </button>
      </div>
    </GlobalPopoutModal>
  )
}
