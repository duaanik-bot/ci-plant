# ERP Next Phase Roadmap

Date: 2026-06-10
Context: Procurement feature-complete and frozen; audits completed for Business UAT, Performance, Planning, and Production.

## Priority 1: Critical Performance Issues

1. Optimize `/api/planning/po-lines`
   - Split compact list from detailed readiness hydration.
   - Cache/reference-load machines, material candidates, and paper stock.
   - Reduce per-row enrichment on initial load.
   - Add payload and response-time budgets.

2. Optimize `/api/inventory/paper-warehouse`
   - Push pagination/search into SQL.
   - Split KPI aggregate from row list.
   - Cache KPI where acceptable.
   - Make compact row mode the default for table rendering.

3. Add ERP performance observability
   - API timing logs with payload size.
   - Duplicate request detection.
   - Slow endpoint dashboard for internal engineering.

## Priority 2: Production Workflow Modernization

1. Consolidate job-card detail context
   - Reduce separate fetches for job card, readiness, timeline, users, machines, and tooling checks.

2. Simplify shopfloor execution
   - Separate operator execution from supervisor analytics.
   - Reduce modal stacking.
   - Clarify stage ownership and next action.

3. Rationalize WIP surfaces
   - Align job-card list, stage queues, cutting queue, machine flow, and print planning into role-based views.

4. Validate automation candidates
   - Counter-driven status transitions.
   - FG posting after QA release.
   - Shift/operator defaults.

## Priority 3: Planning Simplification

1. Convert Planning into an exception-first board
   - Show blocked reason, next action, owner, and ETA.

2. Reduce Planning page complexity
   - Split large page into smaller components.
   - Move deep calculations to detail views.

3. Clarify ownership boundaries
   - Planning: readiness and release decisions.
   - Procurement: PR/PO/GRN workflow.
   - Warehouse: stock and ledger.
   - Production: execution.

4. Add planner-friendly filters
   - Customer, priority, material status, procurement status, machine, date, blocked reason.

## Priority 4: UI Commonization

1. Standardize list pages
   - Shared table state, pagination, search, filters, row click, empty/loading states.

2. Standardize action patterns
   - One primary action per row.
   - Consistent danger/approval dialogs.
   - Fewer prompt-based flows.

3. Clean release hygiene warnings
   - Existing React hook warnings.
   - Existing a11y warnings.
   - Invalid `next.config.js` experimental `viewTransition` warning.

4. Reduce duplicated UI concepts
   - Dashboards vs reports vs operational boards.
   - Modals vs drawers vs full-page details.

## Priority 5: Future Enhancements

Only after performance and workflow simplification:

1. Advanced operational analytics
   - Production bottleneck analytics.
   - Planner workload analytics.
   - Warehouse aging/coverage analytics.

2. Automation
   - Suggested production sequencing.
   - Auto-release checks.
   - Exception alerts.

3. Business-user personalization
   - Saved filters by role.
   - Department landing views.
   - Notification preferences.

## Procurement Freeze Guardrails

Do not resume Procurement feature development unless a signed Business UAT issue requires a bug fix.

Allowed Procurement work:

- Critical bug fixes from Business UAT.
- Performance fixes that do not alter workflows.
- Documentation and training material.

Not allowed in next cycle:

- New Procurement dashboards.
- New Procurement reports.
- New PR/PO/GRN workflows.
- New schema changes for Procurement unless blocking defect requires it.

## Recommended Next Sprint

Sprint theme: Planning/Warehouse performance stabilization.

Deliverables:

1. Compact Planning list endpoint.
2. SQL-paged Warehouse stock endpoint.
3. Response-size/timing instrumentation.
4. Business UAT execution with named department signoffs.

Success measure:

- Planning list API under 800ms at current data volume.
- Warehouse list API under 500ms at current data volume.
- Business UAT signoff table completed by named owners.
