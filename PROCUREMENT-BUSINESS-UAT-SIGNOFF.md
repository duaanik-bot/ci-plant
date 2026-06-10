# Procurement Business UAT Signoff

Date: 2026-06-10
Status: Business UAT packet ready; final named business-user signoff pending.
Procurement state: Feature complete and frozen.

## Freeze Statement

Procurement development is frozen for this pass. No new Procurement features, dashboards, reports, workflows, screens, schema changes, or modules were created.

Technical readiness already completed:

- PR -> PO -> GRN transaction UAT: passed
- Warehouse separation: passed
- Planning integration: passed
- Production visibility integration: passed at shared status-service/page-smoke level
- Supplier analytics: passed
- Procurement reports: passed
- Control Tower dashboard: passed
- Payable preparation: passed
- PDF generation: passed
- Audit trail: passed
- Build validation: passed
- Browser smoke validation: passed
- Staging readiness validation: passed

## Business UAT Execution Model

This document is the structured signoff pack for department representatives. Because no live business users were present in this Codex session, final human signoff must be completed by named representatives before marking Business UAT closed.

Evidence basis available before user signoff:

- Transaction UAT batch: `UAT-20260610122327-NCEF`
- Staging readiness report: `PROCUREMENT-STAGING-READINESS-REPORT.md`
- Browser smoke: Procurement, Warehouse, Planning, Production, Reports, Supplier Analytics

## Department Scenarios

| Department | User Name | Scenario Tested | Expected Result | Actual Result | Issues Found | Severity | Recommendation | Final Signoff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Procurement | Pending named buyer | Raise PR, approve PR, convert to PO, create GRN, QC accept, post stock | User can complete full PR -> PO -> GRN -> stock workflow without manual DB correction | Technical UAT passed in batch `UAT-20260610122327-NCEF` | None in technical UAT | None | Buyer to repeat once on staging with disposable supplier/material | Pending |
| Procurement | Pending named buyer | Partial receipt: PO qty 1000, GRN qty 500 | PO status becomes partial received; balance remains open | Technical UAT passed: PO `partial_received`, balance `500` | None in technical UAT | None | Buyer to verify labels and balance wording | Pending |
| Procurement | Pending named buyer | QC rejection: received 1000, accepted 800, rejected 200 | Only accepted quantity posts to stock; rejection captured | Technical UAT passed: stock +800, rejected 200 | None in technical UAT | None | Buyer/QC to confirm rejection reason options match operations | Pending |
| Warehouse | Pending warehouse lead | Confirm Warehouse is stock-focused and procurement-free | Warehouse should show stock, shortages, ledger/movement visibility; old PR/PO/GRN forms not used | Browser smoke passed `/inventory`; Phase 1 cleanup documented | No runtime issue found | None | Warehouse lead to validate stock table and shortage visibility with live operating examples | Pending |
| Warehouse | Pending warehouse lead | Verify GRN stock posting visibility | Posted procurement inward appears in stock and ledger | Technical UAT stock movements created with `procurement_inward` | None in technical UAT | None | Warehouse lead to verify ledger terminology and filters | Pending |
| Production Planning | Pending planning lead | View Planning procurement status after shortage-to-procurement flow | Planning should show PR/PO/ETA/status visibility | Technical UAT shared snapshot resolved `Fully Received`; browser smoke passed `/orders/planning` | Planning list endpoint remains performance concern | Medium | Planning lead to validate statuses on real planning jobs; performance audit follow-up required | Pending |
| Production | Pending production supervisor | View production job-card procurement/material readiness | Production should expose procurement/material status without requiring procurement workflow actions | Browser smoke passed `/production/job-cards`; shared procurement snapshot validated | Full disposable job-card lifecycle not executed in transaction UAT | Low | Supervisor to test one disposable customer PO/job card lifecycle in Business UAT | Pending |
| Accounts | Pending accounts owner | Verify payable preparation after GRN posting | Payable reference generated once per posted PO; no duplicates | Technical UAT passed: 3 payable refs, no duplicates | None in technical UAT | None | Accounts to validate payable naming and invoice matching handoff | Pending |
| Management | Pending management user | Review dashboard/control tower and reports | KPIs update; open PR/PO/GRN, payable and supplier visibility available | Technical UAT passed dashboard KPI reconciliation; browser smoke passed reports and suppliers | None in technical UAT | None | Management to validate KPI definitions and display language | Pending |

## Issues Register

| ID | Department | Issue | Severity | Status | Recommendation |
| --- | --- | --- | --- | --- | --- |
| BUAT-001 | All | Final named department signoff not yet captured in-session | High for process closure | Open | Schedule Business UAT with named owners and complete this signoff table |
| BUAT-002 | Planning | Planning list API showed multi-second responses during smoke | Medium | Open | Address in performance audit before high-volume rollout |
| BUAT-003 | Production | Production job-card-specific procurement status needs one full disposable business lifecycle validation | Low | Open | Include in Business UAT with production supervisor |

## Signoff Criteria

Each department should mark final signoff only when:

- A named representative has tested the assigned scenario on staging.
- Actual results match expected results or accepted deviations are logged.
- Severity High/Critical issues are closed or formally deferred.
- The representative confirms the workflow is usable for business operations.

## Current Signoff Decision

Business UAT is ready to execute with department representatives.

Final business signoff is not yet complete because no named business users provided approval during this Codex session.
