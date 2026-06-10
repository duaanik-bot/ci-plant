# Procurement Transaction UAT Report

Date: 2026-06-10
Environment: Staging/test database configured by local `.env`
Batch: `UAT-20260610122327-NCEF`
Status: Passed

## Final Staging Readiness Decision

Decision: Ready for staging business-user UAT.

The disposable transaction batch completed the actual PR -> PO -> GRN -> Stock -> Payable flow without manual database correction. No new features, schema changes, deployment, commit, or unrelated business-logic rewrites were performed during this pass.

## Test Data Created

All records were disposable and prefixed or tagged with batch `UAT-20260610122327-NCEF`.

| Object | IDs / References |
| --- | --- |
| Supplier | `09de5ca7-6984-4866-9e73-77c0c13b7d21` |
| UAT user | `c93a734a-c7c4-4655-9ea1-ceb14ee5824d` |
| Materials | `f4d7771f-9dbc-4b74-88a8-da0e5a6544ea`, `40fe15b1-33cd-47e9-a7d3-cd847ff7fcbc`, `63bf606e-7893-40b4-ac2d-db81615c9c86`, `b9c631d8-ebfe-4535-9552-615fc9c5cb29` |
| PRs | `a88d6c89-3a7f-4ea8-bf58-9bbf7989f0d4`, `895eff95-df5e-4e0d-b441-9b194a568052`, `3ecb077b-110e-447b-87c3-45c152d712a0`, `d0a4e555-e690-4407-adfa-f02b6183c00c` |
| POs | `CI-VPO-2026-0002`, `CI-VPO-2026-0003`, `CI-VPO-2026-0004`, plus one cancelled manual PO |
| GRNs | `GRN-2026-C9A5DC6A`, `GRN-2026-1367983D`, `GRN-2026-0C84EDAC` |
| Shortages | `ac6afd8f-26f7-43dc-b3d4-bbe861a0437b`, `6c29b9ed-7f3b-4735-ae62-4f6b891e89b4`, `7885da07-4536-47d4-a9a1-46885ed84948` |

## Scenario Results

| Scenario | Result | Evidence |
| --- | --- | --- |
| Full receipt | PASS | PR `converted_to_po`, PO `received`, GRN `POSTED_TO_STOCK`, stock `100 -> 700`, ledger qty `600`, planning/procurement snapshot `Fully Received`. |
| Partial receipt | PASS | PO qty `1000`, GRN qty `500`, PO `partial_received`, balance qty `500`. |
| QC rejection | PASS | PO qty `1000`, received `1000`, accepted `800`, rejected `200`, stock increased only by `800`, PO stayed `partial_received`. |
| PO cancellation | PASS | Cancelled PO became `cancelled`; GRN creation after cancellation was blocked. |
| Duplicate GRN post prevention | PASS | Second stock-post attempt for `GRN-2026-C9A5DC6A` was blocked. |
| PR rejection with reason | PASS | PR became `rejected`; reason text `UAT reason captured` persisted in remarks. |
| PO close / short close | PASS | Partially received PO became `closed`, `isShortClosed=true`, reason `UAT short close after partial receipt`. |
| Supplier payable preparation | PASS | 3 payable references generated with no duplicate references. |
| Dashboard KPI reconciliation | PASS | Posted GRNs today increased `1 -> 4`; open PO value increased by batch open value `55000`; pending supplier invoices increased `3 -> 6`; pending payable value increased `33810 -> 128010`. |
| PDF validation | PASS | PR, PO, and GRN PDF buffers generated as `%PDF` and included expected document labels and references. |
| Audit trail | PASS | 27 audit rows found across the batch; required events were present. |

## Stock Movement Proof

| Movement ID | Material ID | Qty | Ref Type | GRN Ref |
| --- | --- | ---: | --- | --- |
| `8cf596b4-542a-4dcb-9be7-6719bd9b0018` | `f4d7771f-9dbc-4b74-88a8-da0e5a6544ea` | 600 | `procurement_grn` | `c9a5dc6a-5527-4abe-85ca-ad3fdee3ad45` |
| `330ff437-3918-437a-bb75-c351bc9bc6da` | `40fe15b1-33cd-47e9-a7d3-cd847ff7fcbc` | 500 | `procurement_grn` | `1367983d-c7e9-479f-9bdd-a634d9c0c841` |
| `396888e7-77df-46e0-9580-e9c32b7ae32f` | `63bf606e-7893-40b4-ac2d-db81615c9c86` | 800 | `procurement_grn` | `0c84edac-4a14-4b1c-a157-db4385a9f78c` |

## Ledger Proof

All stock ledger rows used movement type `procurement_inward`, reference type `procurement_grn`, and pointed back to the created GRN IDs. No manual stock adjustment was used to make the stock balances pass.

## Dashboard KPI Reconciliation

| KPI | Before | After | Batch Effect |
| --- | ---: | ---: | ---: |
| Open PRs | 8 | 8 | Net zero after conversions/rejection |
| Pending approval PRs | 8 | 8 | Net zero |
| Approved PRs | 1 | 1 | Net zero after conversion |
| Open POs | 7 | 8 | +1 open QC rejection PO |
| Pending GRNs | 0 | 0 | All created GRNs posted |
| Posted GRNs today | 1 | 4 | +3 |
| Open PO value | 0 | 55000 | +55000 |
| Pending supplier invoices | 3 | 6 | +3 |
| Pending payable value | 33810 | 128010 | +94200 |

## Payable Verification

| Payable Reference | PO | Amount | Status |
| --- | --- | ---: | --- |
| `PAYABLE-CI-VPO-2026-0002` | `CI-VPO-2026-0002` | 25200 | `pending_supplier_invoice` |
| `PAYABLE-CI-VPO-2026-0003` | `CI-VPO-2026-0003` | 25000 | `pending_supplier_invoice` |
| `PAYABLE-CI-VPO-2026-0004` | `CI-VPO-2026-0004` | 44000 | `pending_supplier_invoice` |

Duplicate payable references: none found.

## PDF Verification

| Document | Result | Bytes | Reference Check |
| --- | --- | ---: | --- |
| PR PDF | PASS | 4098 | `Purchase Requisition`, `PR-2026-A88D6C89` present |
| PO PDF | PASS | 4426 | `Vendor material purchase order`, `CI-VPO-2026-0002` present |
| GRN PDF | PASS | 4187 | `Goods Receipt Note`, `GRN-2026-C9A5DC6A` present |

## Audit Trail Verification

Required audit events found:

- `PR_CREATED`
- `PR_SUBMITTED`
- `PR_APPROVED`
- `PO_CREATED`
- `GRN_CREATED`
- `GRN_QC_UPDATED`
- `GRN_POSTED_TO_STOCK`
- `PO_CANCELLED`
- `PR_REJECTED`
- `PO_CLOSED`

## Planning / Production / Warehouse Integration

Warehouse stock visibility was verified through direct inventory stock increase and stock ledger rows.

Planning/procurement status was verified through the shared material procurement snapshot for the planning shortage. The full receipt material resolved to `Fully Received` with the linked PR/PO/GRN chain.

Production procurement status uses the same procurement snapshot service with a production requirement input. No separate production job card was created in this disposable pass, so the validation covered the shared status resolver rather than a full job-card lifecycle.

## Browser Smoke

Production build was served locally on `http://localhost:3010` and checked with the in-app browser.

Pages checked without hard runtime error:

- `/procurement`
- `/procurement/pr`
- `/procurement/po`
- `/procurement/grn`
- `/procurement/reports`
- `/procurement/suppliers`
- `/inventory`
- `/orders/planning`
- `/production/job-cards`
- `/`

Server log performance notes during smoke:

- `/api/inventory/paper-warehouse`: about `3296ms`
- `/api/purchase-orders`: about `2467ms`
- `/api/planning/po-lines`: about `5320ms`

These did not block transaction UAT, but they should remain in the performance-hardening backlog.

## Bugs Found

No new blocking procurement transaction bugs were found during this staging/disposable-data pass.

The earlier PO numbering fix remained in place and was exercised successfully: newly created POs advanced from the current `CI-VPO-2026-` prefix without duplicate `po_number` errors.

## Bugs Fixed

No additional code fixes were required during this pass.

## Validation Commands

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npx prisma validate` | Passed |
| `npm run lint` | Passed with existing warnings |
| `npm run build` | Passed |
| `git diff --check` | Passed |
| Browser smoke after fixes | Passed |

## Follow-Up Notes

- Keep the disposable `UAT-20260610122327-NCEF` records in staging as evidence unless business users request cleanup.
- Production job-card-specific procurement status should get a separate lifecycle UAT with a disposable customer PO and generated job card.
- Planning and inventory list endpoints showed multi-second response times during smoke and should be revisited in the next performance pass.
