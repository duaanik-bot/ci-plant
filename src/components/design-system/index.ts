/**
 * Design System contract — every dashboard page should import from here, not hand-roll.
 *
 *   Buttons        → <Button variant="primary|secondary|ghost|danger|success|warning|info|icon|utility" />
 *   Text input     → <InputField label hint error /> or className="ds-input"
 *   Select         → <SelectDropdown label /> or <select className="ds-input">
 *   Modals         → <GlobalPopoutModal size="sm|md|lg|xl|fullscreen" /> (centered — all shared drawers delegate here)
 *   Legacy adapters → <StandardDrawer /> <Drawer /> <SlideOverPanel /> all render as centered modals now
 *   Status pill    → <StatusBadge status="…" /> or <Badge tone="success|warning|danger|info|neutral|tooling|brand" />
 *   Section card   → <CardSection title="…"> {children} </CardSection>
 *   Section label  → <SectionLabel accent? />
 *   KPI tile       → <KpiTile label value tone icon? hint? raw? />
 *   Tables         → DataTableFrame + dataTable.* class bundle
 *
 * Tokens (no raw Tailwind color shades like rose-400 / blue-500):
 *   surfaces  → var(--bg-card|--bg-elevated|--bg-muted|--bg-main)
 *   text      → text-ds-ink / text-ds-ink-muted / text-ds-ink-faint
 *   semantic  → var(--success|--warning|--error|--info|--tooling|--neutral) (+ -bg variants)
 *   brand     → var(--brand-primary|--brand-primary-hover)
 *   radii     → rounded-ds-sm (controls) / rounded-ds-md (cards) / rounded-ds-lg (large cards) / rounded-full (pills/avatars)
 *   shadows   → shadow-ds-depth(-sm) / shadow-ds-drawer / shadow-ds-focus
 *
 * Guardrail: scripts/check-theme-tokens.sh fails CI if raw color shades or non-DS radii leak in.
 *
 * Figma / product-spec mirror — colors, spacing, radii.
 */
export { dsColors, dsRadius, dsSpacing, dsTypography } from '@/lib/design-system/tokens'
export { AppLayout } from './AppLayout'
export { Button } from './Button'
export { InputField } from './InputField'
export { SelectDropdown } from './SelectDropdown'
export { CardSection, SectionLabel } from './CardSection'
export { KpiTile } from './KpiTile'
export type { KpiTileProps } from './KpiTile'
export { SummaryBlock } from './SummaryBlock'
export { Badge } from './Badge'
export { StatusBadge } from './StatusBadge'
export { PageHeader } from './PageHeader'
export { ActionBar } from './ActionBar'
export { LaneCounterChips } from './LaneCounterChips'
export type { LaneCounterChip } from './LaneCounterChips'
export { BulkActionBar } from './BulkActionBar'
export { dataTable, DataTableFrame } from './DataTable'
export * from './tokens'
export { Drawer } from './Drawer'
export { StandardDrawer } from './StandardDrawer'
export type { StandardDrawerAction } from './StandardDrawer'
export type { StandardSlideOverOptions } from '@/components/ui/SlideOverPanel'
export { GlobalPopoutModal } from './GlobalPopoutModal'
export type { GlobalPopoutModalProps, GlobalPopoutModalSize } from './GlobalPopoutModal'
export { Tabs } from './Tabs'
export type { TabItem } from './Tabs'

/* —— Program vocabulary aliases (App*) — thin re-exports, no duplicate implementations —— */
export { Button as AppButton } from './Button'
export { CardSection as AppCard } from './CardSection'
export { DataTableFrame as AppTable } from './DataTable'
export { InputField as AppInput } from './InputField'
export { InputField as AppSearch } from './InputField'
export { Badge as AppBadge } from './Badge'
export { ActionBar as AppToolbar } from './ActionBar'
export { Tabs as AppTabs } from './Tabs'
