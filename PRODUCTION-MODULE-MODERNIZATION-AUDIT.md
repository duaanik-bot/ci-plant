# Production Module Modernization Audit

Date: 2026-06-10
Scope: Production Dashboard, Job Cards, Production Orders, Daily Entry, Shift Logs, Machine Logs, WIP Flow, Finished Goods Posting, Reports
Mode: Audit only; no fixes implemented.

## Executive Summary

The Production module appears operationally rich but fragmented across job cards, stage queues, cutting queue, machine flow, print planning, stage detail pages, and many job-card detail actions. The main opportunity is to simplify shopfloor execution into fewer screens, fewer modals, and clearer stage ownership.

## Reviewed Areas

- Job card list: `src/app/(dashboard)/production/job-cards/page.tsx`
- Job card detail: `src/app/(dashboard)/production/job-cards/[id]/page.tsx`
- Stage screens: `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`
- Production APIs under `src/app/api/production`
- Job card APIs under `src/app/api/job-cards`

## Findings

| Finding | Evidence | Impact | Recommendation |
| --- | --- | --- | --- |
| Production screens are large | Job-card detail ~1760 lines; stage page ~2796 lines | High maintenance and render complexity | Split into execution shell, stage board, job-card summary, material panel, QA panel |
| Many APIs per job-card detail | Detail page fetches job card, material readiness, material timeline, users, machines, plate/die/emboss checks | High request count and duplicate context | Add a consolidated job-card execution context endpoint |
| Stage page is very broad | Stage screen includes OEE, incentives, queues, controls, routing logic | Operators may face UI clutter | Separate operator execution from supervisor analytics |
| Duplicate workflow surfaces | Job-card list, stage queues, machine flow, cutting queue, print planning all overlap WIP visibility | Confusing ownership | Define one primary shopfloor queue and make others filtered views |
| Modal/action density | Job-card detail contains many actions: enqueue cutting, tooling dispatch, reservations, PDF, status updates | Excessive clicks and training burden | Convert frequent actions into guided workflow steps |
| Production status and procurement/material readiness overlap | Job-card detail shows procurement/material status while Planning/Warehouse also own visibility | Risk of conflicting interpretations | Keep Production view read-only for procurement status; link to source |
| Slow API risk | Stage and job-card detail include many relations and calculations | Potential page delay under volume | Profile production execution endpoints next |

## API and Fetch Observations

Job-card list:

- `/api/job-cards?mode=compact&paged=1&limit=50`
- Row actions patch individual job cards.

Job-card detail:

- `/api/job-cards/[id]?auditTimeline=1`
- `/api/job-cards/[id]/material-readiness`
- `/api/job-cards/[id]/material-timeline`
- `/api/users`
- `/api/machines`
- Plate, die, emboss, tooling, and reservation endpoints depending on actions.

Stage screens:

- `/api/production/stages/[stageKey]`
- Stage controls and triage endpoints
- OEE/operator/machine health endpoints

Risk: job-card detail can become chatty and expensive even before the user performs a shopfloor action.

## Duplicate Workflows

Potential overlaps:

- Cutting queue vs stage queue for Cutting.
- Print planning vs production machine flow.
- Job-card list vs stage screens for WIP status.
- Stage detail actions vs job-card detail actions.
- Production reports vs dashboard-level KPIs.

Recommendation: establish a single source of action per role:

- Operator: stage queue and current job execution only.
- Supervisor: WIP flow, exceptions, shift performance.
- Planner: release decisions and production readiness.
- Management: KPI and reports.

## Excessive Data Entry Risks

Areas likely to benefit from automation:

- Re-entering counts across stages.
- Re-selecting machine/operator where already assigned.
- Manual status transition after counter updates.
- Manual finished-goods posting when final QA/release completes.
- Manual WIP movement between adjacent stages.

No automation was implemented in this pass.

## UI Clutter and Modal Overuse

Likely clutter sources:

- Large all-in-one job-card detail page.
- Stage page combining queue, machine health, OEE, incentives, and action controls.
- Multiple management views for production flow.
- PDF/export actions mixed with execution actions.

Modernization opportunity:

- Operator-first mobile/tablet execution card.
- Supervisor-first WIP board.
- Job-card detail as read-only evidence plus controlled actions.
- Keep analytics out of the operator execution path.

## Missing Visibility

Potential gaps to validate with users:

- Which stage owns the next action?
- Why a job is blocked.
- Whether material is issued, reserved, short, or consumed.
- Whether FG posting is pending or complete.
- Which operator/machine is currently accountable.
- Shift-level exceptions and idle time.

## Modernization Recommendations

Priority 1:

- Profile `/api/job-cards/[id]` and `/api/production/stages/[stageKey]` under realistic row counts.
- Consolidate job-card detail context into fewer API calls.

Priority 2:

- Define operator, supervisor, and management surfaces separately.
- Reduce duplicate WIP views.
- Create a clear stage ownership model.

Priority 3:

- Reduce modal stacking in job-card detail and stage screens.
- Automate obvious status transitions after validated shopfloor rules.

## Do Not Do Yet

- Do not redesign Production until business users validate current pain points.
- Do not add new production dashboards before consolidating existing WIP views.
- Do not automate FG posting without Accounts/Warehouse signoff.

## Conclusion

Production is the highest-value modernization candidate after performance issues. The biggest wins are fewer screens, fewer API calls, clearer stage ownership, and less data entry for operators.
