# Planning Module Modernization Audit

Date: 2026-06-10
Scope: Planning Dashboard, Planning Engine, Planning Tables, Filters, KPIs, API calls
Mode: Audit only; no fixes implemented.

## Executive Summary

The Planning module is powerful but heavy. It mixes board allocation, production readiness, procurement status, tooling interlock, customer priority, job-card creation, machine choice, material reservation, recall actions, and detailed drawers into one large operating surface.

Primary modernization theme: simplify the Planning list into a lightweight command center and move deep calculations/details into focused drilldowns.

## Reviewed Areas

- Planning page: `src/app/(dashboard)/orders/planning/page.tsx`
- Planning API: `src/app/api/planning/po-lines/route.ts`
- Planning Engine components under `src/components/planning/engine`
- Planning drawers and summary components under `src/components/planning`

## Findings

| Finding | Evidence | Impact | Recommendation |
| --- | --- | --- | --- |
| Planning page is too large | `orders/planning/page.tsx` is ~1333 lines | Hard to maintain; high render/state complexity | Split page into list, filters, action bar, drawer host, and workflow commands |
| Planning endpoint is overloaded | `/api/planning/po-lines` fetches PO lines, machines, all active inventory, paper warehouse, FG, job cards, reservations | Slow list load and large responses | Create compact list endpoint; lazy-load detailed readiness |
| Heavy calculations run on list load | Readiness, material gate, tooling interlock, paper matching, FG matching all happen per row | User pays cost even when just scanning | Compute summary status for list, details only when row opens |
| Filters are likely underpowered for data volume | API supports status/customer, but page has richer user needs | Operators may scroll/search too much | Prioritize server-side filters for customer, status, material status, priority, machine, date |
| UI has too many responsibilities | Planning page includes recalls, edits, material reservation, AW handoff, processing actions | Excessive cognitive load | Separate “Planning Board” from “Planning Actions” and “Exceptions” |
| Planning Engine is component-rich | Many specialized sections for product requirement, smart match, UPS/spec, board allocation, warehouse availability, batch decision | Strong functionality but complex navigation | Keep as guided workflow; reduce default page exposure |
| Duplicate visibility with Procurement/Warehouse | Planning displays procurement suggestions/status while Procurement now owns workflow | Risk of users expecting procurement actions in Planning | Keep status/ETA only; route action to Procurement when needed |
| Slow widgets | Planning line API observed `2195ms`, previous smoke `3106ms` and `5320ms` | Perceived slowness for planners | Prioritize API split/caching |

## Planning API Calls

Observed fetch patterns:

- `/api/customers?q=...`
- `/api/planning/po-lines?...`
- `/api/planning/po-lines/[id]`
- `/api/planning/po-lines/[id]/recall-from-aw`
- `/api/planning/po-lines/make-processing`
- Related reservation/material actions from planning engine components

Risk: multiple row actions refetch individual line data, and the main list endpoint is already heavy.

## Redundant Screens / Duplicate Functionality

Potential overlaps:

- Planning page and Planning Engine both expose material/readiness context.
- Planning material visibility overlaps with Warehouse stock visibility.
- Planning procurement status overlaps with Procurement dashboard/PR/PO/GRN records.
- Production readiness appears both in Planning and Production job cards.

Recommendation: define ownership boundaries:

- Planning owns sequencing, feasibility, readiness, and decisioning.
- Procurement owns PR/PO/GRN workflow.
- Warehouse owns stock/ledger/shortage visibility.
- Production owns execution/job-card status.

## UI Clutter / Excessive Clicks

Likely clutter sources:

- Many action handlers in one page.
- Multiple drawers/modals for details and actions.
- Dense table plus workflow actions.
- Planning Engine sections exposed as many steps.

Modernization opportunity:

- Default view: exception-first queue.
- Row click: concise drawer with only top decisions.
- Advanced detail: separate drilldown for sheet math/readiness proof.
- Batch operations: move to a dedicated planner action panel.

## Missing Visibility

The module has a lot of data, but users may still miss:

- Clear reason why a line is blocked.
- One next best action per line.
- ETA source and confidence for procurement-linked lines.
- Whether material status is warehouse-confirmed vs procurement-in-progress vs production-issued.
- Aging of planning decisions and idle blockers.

## Modernization Recommendations

Priority 1:

- Split `/api/planning/po-lines` into compact list and detail endpoints.
- Add a Planning “blocked by” field: artwork, tooling, material, procurement, machine, production.
- Cache reference data used by planning calculations.

Priority 2:

- Redesign information architecture without changing workflow: Board, Exceptions, Ready to Release, In Procurement, In Production.
- Make the list action model explicit: one primary next action per row.

Priority 3:

- Reduce modal/drawer stacking.
- Add saved filters for planner roles.
- Add row virtualization if list grows.

## Do Not Do Yet

- Do not add new Procurement actions into Planning.
- Do not rewrite planning business logic before business-user validation.
- Do not add new Planning dashboards until redundant screens are consolidated.

## Conclusion

Planning should be the next major simplification target after Procurement freeze. The module is functionally broad, but its list endpoint and UI surface are carrying too much responsibility.
