import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastItem {
  id: number
  message: string
  type: ToastType
  duration: number
}

interface ToastStore {
  toasts: ToastItem[]
  add: (message: string, type?: ToastType, duration?: number) => void
  remove: (id: number) => void
}

let _id = 0

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  add(message, type = 'info', duration = 4000) {
    const id = ++_id
    set((s) => ({ toasts: [...s.toasts, { id, message, type, duration }] }))
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, duration)
    }
  },

  remove(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

/** Imperative helpers — use outside React components */
export const toast = {
  success: (msg: string, duration?: number) =>
    useToastStore.getState().add(msg, 'success', duration),
  error: (msg: string, duration?: number) =>
    useToastStore.getState().add(msg, 'error', duration ?? 6000),
  info: (msg: string, duration?: number) =>
    useToastStore.getState().add(msg, 'info', duration),
  warning: (msg: string, duration?: number) =>
    useToastStore.getState().add(msg, 'warning', duration),
}
