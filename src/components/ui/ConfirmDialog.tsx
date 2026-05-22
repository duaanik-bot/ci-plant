'use client'

import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { Button } from './Button'

/**
 * ConfirmDialog
 * ──────────────
 * A small modal pre-wired for destructive confirmation.
 * Always renders at size="sm". Uses preview-mode dismissal (Escape + backdrop
 * click both close), matching the lightweight confirm-prompt UX.
 *
 * Usage:
 *   <ConfirmDialog
 *     open={showDelete}
 *     onClose={() => setShowDelete(false)}
 *     onConfirm={handleDelete}
 *     title="Delete Customer"
 *     message="This will permanently delete this customer and all associated records. Are you sure?"
 *     confirmLabel="Yes, Delete"
 *     loading={isDeleting}
 *   />
 */
interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title?: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  loading?: boolean
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title        = 'Are you sure?',
  message      = 'This action cannot be undone.',
  confirmLabel = 'Confirm',
  cancelLabel  = 'Cancel',
  loading      = false,
}: ConfirmDialogProps) {
  return (
    <GlobalPopoutModal isOpen={open} onClose={onClose} title={title} size="sm" mode="preview">
      <p className="text-sm text-ds-ink-muted mb-6 leading-relaxed">{message}</p>
      <div className="flex gap-3 justify-end">
        <Button variant="secondary" onClick={onClose} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button variant="danger" onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </GlobalPopoutModal>
  )
}

export default ConfirmDialog
