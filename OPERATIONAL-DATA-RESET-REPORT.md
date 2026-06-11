# Operational Data Reset Report

Started: 2026-06-11T05:37:58.041Z
Finished: 2026-06-11T05:38:29.044Z

## Scope

Reset operational entries across Orders, Printing/Planning, Live Production, and Procurement.

## Preserved

- UI/UX and application code
- Database schema and migrations
- Users, roles, customers, suppliers
- Carton/product masters
- Material definitions and reorder settings
- Machine and instrument masters
- Plate store, die, emboss block, and shade card masters

## Cleared

- bill_line_items: 1 -> 0
- bills: 1 -> 0
- bom_lines: 0 -> 0
- communication_logs: 4 -> 0
- dispatches: 2 -> 0
- grn_shortage_allocations: 5 -> 0
- job_stages: 0 -> 0
- jobs: 0 -> 0
- material_queue: 11 -> 0
- material_reservations: 2 -> 0
- material_shortages: 13 -> 0
- material_weight_reconciliations: 0 -> 0
- ncrs: 0 -> 0
- paper_issue_to_floor: 0 -> 0
- plate_hub_events: 3 -> 0
- plate_requirements: 3 -> 0
- po_line_items: 21 -> 0
- production_downtime_logs: 0 -> 0
- production_job_cards: 9 -> 0
- production_oee_ledgers: 0 -> 0
- production_stage_records: 59 -> 0
- purchase_orders: 19 -> 0
- purchase_requisitions: 16 -> 0
- qc_records: 0 -> 0
- sheet_issue_records: 0 -> 0
- sheet_issues: 0 -> 0
- short_excess_records: 1 -> 0
- stock_movements: 25 -> 0
- vendor_material_po_lines: 18 -> 0
- vendor_material_purchase_orders: 9 -> 0
- vendor_material_receipts: 2 -> 0
- vendor_po_requisition_links: 7 -> 0
- vendor_quality_debit_notes: 0 -> 0
- waste_records: 0 -> 0
- workflow_stages: 0 -> 0

## Inventory Balance Reset

Material master balance fields reset to zero for 271 inventory rows: qty_quarantine, qty_available, qty_reserved, qty_fg, physical_stock_sheets, shortage_sheets, total_weight_kg.

## Backup

Full JSON backup written before deletion: /Users/anikdua/Documents/Projects/CI-Production/OPERATIONAL-DATA-RESET-BACKUP-2026-06-11T05-38-18-981Z.json

## Notes

- This was a transactional-data reset only; no masters, UI, schema, or workflows were removed.
- Job card numbers and database sequences were not reset.
- Audit and communication rows were cleared as part of the fresh operational handover scope.
