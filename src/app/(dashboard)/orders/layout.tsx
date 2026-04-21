import { ErrorBoundary } from '@/components/ErrorBoundary'

export default function OrdersLayout({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary moduleName="Orders">{children}</ErrorBoundary>
}
