# Real Performance Profiling Report

Date: 2026-06-10  
Runtime measured: authenticated browser CDP trace against warmed `next dev` on `http://127.0.0.1:3016`  
User/session: `anik@gmail.com`, role `md`, `permissions.all=true`  
Capture file: `/tmp/ci-real-performance-profile.json`

## Executive Summary

This was a real browser/network capture, not a code-only audit. Production profiling could not be completed because a clean `npx next build` still fails during page-data collection with `.next/server/pages-manifest.json` missing; `next start` then returned server 500s from stale/missing page bundles. To avoid fabricating production data, I profiled a live authenticated dev server after route warm-up and disabled browser cache in Chrome DevTools Protocol.

The runtime bottleneck is concentrated. The top 3 measured API routes account for 80.3% of all captured API bytes. The top 10 account for 98.5%.

The dominant payload issue is `/api/tooling-hub/dashboard?tool=dies&view=board`, called twice on first render and returning a 273-row `inventory` array plus nested matches. The dominant latency issues are `/api/procurement/dashboard`, `/api/production/stages/cutting?limit=150&mode=compact&tab=pending`, `/api/designing/po-lines`, `/api/plate-hub/dashboard?view=board`, and `/api/job-cards?mode=compact&paged=1&limit=150&yieldMetrics=1`.

Repeated first-render calls are still common: `/api/auth/session` is called twice on most pages, and several heavy module APIs are also called twice on first render.

## Methodology and Limits

- Browser: headless Chrome controlled through CDP.
- Auth: direct NextAuth credentials flow, then session cookies injected into the browser.
- Route warm-up: each target route fetched once before measurement to reduce dev compile noise.
- Cache: browser cache disabled for measured route visits.
- Wait window: 9-11 seconds per module to capture post-hydration API calls.
- Payload: `encodedDataLength` from CDP, with JSON body sizes and row counts from `Network.getResponseBody`.
- Limitation: dev chunk sizes and timings are not production-equivalent. API route names, duplicate calls, JSON sizes, row counts, and nested relation shapes are still valid runtime signals.
- Blocker: production profiling remains blocked by the Next build manifest failure.

## Page Ranking

| Rank | Page/module | First render | Total network | API count | API bytes | Commonisation opportunity | Expected gain |
|---:|---|---:|---:|---:|---:|---|---|
| 1 | Tooling Hub `/hub/dies` | 813 ms | 3,778.2 KB | 7 | 564.0 KB | Very high: duplicate dashboard/operator calls, large inventory array, shared hub lane/detail loader | Very high |
| 2 | Designing/AW Queue `/orders/designing` | 1,254 ms | 2,800.8 KB | 9 | 105.4 KB | High: duplicate customers/users/designing calls, heavy spec overrides in list | High |
| 3 | Production Stage Board `/production/stages/cutting` | 989 ms | 2,605.7 KB | 7 | 46.8 KB | High: duplicate stage/operator calls, compact response still nested | High |
| 4 | Purchase Orders `/orders/purchase-orders` | 484 ms | 2,830.8 KB | 6 | 34.7 KB | Medium-high: duplicate compact PO list and metrics, first-render dashboard redirect repeats same work | Medium-high |
| 5 | Job Cards `/production/job-cards` | 777 ms | 2,473.9 KB | 4 | 21.6 KB | Medium-high: compact list still includes stages/yield/PO-line enrichment | Medium-high |
| 6 | Billing `/billing` | 853 ms | 2,542.2 KB | 6 | 16.4 KB | Medium: customer preload and queue/list calls should be gated | Medium |
| 7 | Procurement `/procurement` | 402 ms | 2,350.6 KB | 5 | 15.3 KB | High: dashboard call is slow and duplicated | High |
| 8 | Plate Hub `/hub/plates` | 1,969 ms | 3,512.5 KB | 5 | 9.7 KB | Medium-high: dashboard call is slow and duplicated, shared hub pattern | Medium-high |
| 9 | GRN `/procurement/grn` | 461 ms | 2,341.0 KB | 5 | 5.6 KB | Medium: duplicate list call, status filters loaded early | Medium |
| 10 | Reports `/reports` | 1,280 ms | 2,199.5 KB | 3 | 3.9 KB | Low-medium: no report dataset fetched before selection | Low |
| 11 | Inventory `/inventory` | Invalid in browser trace | 1,751.6 KB | 3 | 3.9 KB | Unknown from this run | Requires route render fix/recheck |
| 12 | Planning `/orders/planning` | Invalid in browser trace | 1,156.7 KB | 0 | 0 KB | Unknown from this run | Requires route render fix/recheck |
| 13 | Dashboard `/` | Redirected to Purchase Orders | 2,830.8 KB | 6 | 34.7 KB | Same as Purchase Orders | Medium-high |

Notes:
- `/` redirected to `/orders/purchase-orders` for the measured user, so Dashboard numbers are Purchase Order first-render numbers.
- `/inventory` and `/orders/planning` returned the 404 shell in the browser capture even though route warm-up returned HTTP 200. Treat those two as profiling gaps until the dev/prod route artifact issue is resolved.

## Top 10 APIs Responsible for Perceived Slowness

| Rank | API route | Modules | Calls | Total bytes | Max time | Rows / largest array | Main issue | Recommendation |
|---:|---|---|---:|---:|---:|---|---|---|
| 1 | `/api/tooling-hub/dashboard?tool=dies&view=board` | Tooling Hub | 2 | 555.5 KB | 2,869 ms | `inventory[273]` | Largest payload; duplicated; loads full die inventory and nested matches before interaction | Split board summary from inventory ledger/detail, tab-gate inventory, dedupe first-render fetch |
| 2 | `/api/procurement/dashboard` | Procurement | 2 | 11.4 KB | 9,690 ms | max array 8 | Small payload but slowest route; duplicated | Cache/parallelize summary queries, dedupe client caller, move non-visible control tower detail behind tab |
| 3 | `/api/production/stages/cutting?limit=150&mode=compact&tab=pending` | Production Stage Board | 2 | 42.1 KB | 6,719 ms | `jobCards[6]` | Slow despite few rows; duplicate call; nested job/stage/meta | Reduce compact fields further, load tab counts separately/cache, dedupe effect |
| 4 | `/api/designing/po-lines` | Designing/AW Queue | 2 | 75.6 KB | 6,276 ms | 11 rows | Heavy nested `specOverrides` and repeated first render | Add compact AW list contract, move overrides/orchestration payload to detail drawer |
| 5 | `/api/plate-hub/dashboard?view=board` | Plate Hub | 2 | 5.8 KB | 5,740 ms | max array 4 | Small but slow; duplicated; several related lookups visible in server log | Dedupe and separate lane summary from detail enrichment |
| 6 | `/api/job-cards?mode=compact&paged=1&limit=150&yieldMetrics=1` | Job Cards | 1 | 17.7 KB | 3,949 ms | 9 rows, stages[9] | Compact still includes stages and yield metrics | Remove yield/stages from first list unless visible, detail-on-demand for stage timeline |
| 7 | `/api/purchase-orders?mode=compact&paged=1&limit=100` | Dashboard, Purchase Orders | 4 | 60.8 KB | 2,642 ms | 19 rows | Duplicated twice per PO render, and again via dashboard redirect | Dedupe fetch/effect, lower first limit to visible rows, load readiness in detail |
| 8 | `/api/purchase-orders/executive-metrics` | Dashboard, Purchase Orders | 2 | 0.7 KB | 2,999 ms | summary only | Tiny payload but expensive query; loads alongside list | Cache metrics, defer below-fold metrics, avoid running twice |
| 9 | `/api/masters/customers` | Designing, Billing | 3 | 33.0 KB | 1,221 ms | 23 rows | Full customer list preloaded for filters/selects | Searchable lookup with limit, reuse cached registry/select options |
| 10 | `/api/masters/registry` | Most modules | 12 | 22.7 KB | 1,264 ms | max array 9 | Repeated on nearly every route | App-level cache/provider, avoid duplicate module-level calls |

Payload concentration:
- Total captured API bytes: 862.1 KB.
- Top 1 route: 64.4%.
- Top 3 routes by bytes: 80.3%.
- Top 10 routes by bytes: 98.5%.

## Module Findings

### Dashboard

- Route requested: `/`
- Actual page reached: `/orders/purchase-orders`
- API requests: 6
- Total payload: 2,830.8 KB
- API payload: 34.7 KB
- Slowest API: `/api/purchase-orders/executive-metrics`, 2,999 ms
- Largest API: `/api/purchase-orders?mode=compact&paged=1&limit=100`, 15.2 KB, 19 rows
- Duplicates: `/api/auth/session` twice, `/api/purchase-orders?limit=100&mode=compact&paged=1` twice
- Recommendation: confirm intended dashboard landing for this role; if redirect is expected, dedupe Purchase Order first-render calls. If not expected, profile the real dashboard route after routing is corrected.

### Inventory

- Route requested: `/inventory`
- Browser result: 404 shell during measured trace
- API requests captured: 3
- API payload: 3.9 KB
- Duplicates: `/api/auth/session` twice
- Recommendation: re-profile after build/dev route artifact issue is fixed. Current trace cannot prove inventory table/runtime behavior.

### Planning

- Route requested: `/orders/planning`
- Browser result: 404 shell during measured trace
- API requests captured: 0
- Recommendation: re-profile after route artifact issue is fixed. Current trace cannot prove planning runtime behavior.

### Purchase Orders

- Route: `/orders/purchase-orders`
- API requests: 6
- Total payload: 2,830.8 KB
- API payload: 34.7 KB
- Slowest API: `/api/purchase-orders?mode=compact&paged=1&limit=100`, 1,692 ms on measured page visit
- Largest API: `/api/purchase-orders?mode=compact&paged=1&limit=100`, 15.2 KB, 19 rows, nested `customer`, `lineItems`, `readiness`
- Duplicate APIs: compact PO list twice, auth session twice
- First-render before interaction: compact list, executive metrics, registry, auth
- Lazy-load candidates: readiness and line item enrichment where not visible; executive metrics if below fold
- Recommendation: fix duplicate list call first. Then reduce compact list to visible row fields and fetch readiness/detail in drawer.

### Procurement

- Route: `/procurement`
- API requests: 5
- Total payload: 2,350.6 KB
- API payload: 15.3 KB
- Slowest/largest module API: `/api/procurement/dashboard`, 9,690 ms, 5.7 KB, duplicated
- Nested data: `controlTower.cards`, `criticalShortages[6]`, `pendingApprovals[8]`
- Recommendation: this is a query-latency problem more than a payload problem. Dedupe first, then cache or split dashboard summary from heavy operational lists.

### GRN

- Route: `/procurement/grn`
- API requests: 5
- Total payload: 2,341.0 KB
- API payload: 5.6 KB
- Slowest API: `/api/procurement/grn?limit=50&q=&status=&supplier=&posted=`, 1,820 ms, 2 rows, duplicated
- Recommendation: dedupe list fetch and keep PO/material lookup on-demand. Payload is already small in this dataset.

### Designing/AW Queue

- Route: `/orders/designing`
- API requests: 9
- Total payload: 2,800.8 KB
- API payload: 105.4 KB
- Slowest API: `/api/designing/po-lines`, 6,276 ms
- Largest API: `/api/designing/po-lines`, 37.8 KB per call, 11 rows, duplicated
- Nested data: `specOverrides`, `specOverrides.orchestration`, `specOverrides.designerCommand`, `specOverrides.plateHubPayload`
- Other duplicates: `/api/masters/customers`, `/api/users`, `/api/auth/session`
- Recommendation: introduce compact AW queue list response and move `specOverrides` detail into row drawer/modal. Dedupe customers/users.

### Job Cards

- Route: `/production/job-cards`
- API requests: 4
- Total payload: 2,473.9 KB
- API payload: 21.6 KB
- Slowest/largest API: `/api/job-cards?mode=compact&paged=1&limit=150&yieldMetrics=1`, 3,949 ms, 17.7 KB, 9 rows
- Nested data: `customer`, `poLine`, `stages[9]`, `yield`
- Recommendation: compact mode is improved but still carries detail-level stage/yield data. Keep list lean and fetch stage timeline/yield on row click.

### Production Stage Boards

- Route: `/production/stages/cutting`
- API requests: 7
- Total payload: 2,605.7 KB
- API payload: 46.8 KB
- Slowest/largest API: `/api/production/stages/cutting?limit=150&mode=compact&tab=pending`, 6,719 ms, 21.0 KB, 6 rows, duplicated
- Nested data: `jobCards[6]`, `stageRecord`, `jobCard`, `meta.tabCounts`
- Other duplicates: `/api/operator-master?activeOnly=1&stageKey=cutting`, auth session
- Recommendation: dedupe stage board fetch, clamp first limit to visible lane count, and move job/stage enrichment to detail. Consider cached tab counts.

### Billing

- Route: `/billing`
- API requests: 6
- Total payload: 2,542.2 KB
- API payload: 16.4 KB
- Slowest API: `/api/billing/queue`, 1,300 ms, 0 rows
- Largest API: `/api/masters/customers`, 11.0 KB, 23 rows
- Billing list: `/api/bills?compact=1&paged=1&limit=100`, 1.3 KB, 1 row
- Recommendation: replace full customer preload with capped search/select. Keep bill queue lazy if not visible.

### Reports

- Route: `/reports`
- API requests: 3
- Total payload: 2,199.5 KB
- API payload: 3.9 KB
- APIs before interaction: registry, auth session twice
- Recommendation: report landing is healthy from an API-data perspective. Continue enforcing preview-only rows and server-side export.

### Plate Hub

- Route: `/hub/plates`
- API requests: 5
- Total payload: 3,512.5 KB
- API payload: 9.7 KB
- Slowest/largest API: `/api/plate-hub/dashboard?view=board`, 5,740 ms, 2.9 KB, duplicated
- Nested data: `triage[3]`, `linkedCustomerNames[1]`, `plateColours[4]`
- Recommendation: query latency is the issue. Dedupe first, then split visible board summary from linked customer/color enrichment.

### Tooling Hub

- Route: `/hub/dies`
- API requests: 7
- Total payload: 3,778.2 KB
- API payload: 564.0 KB
- Slowest/largest API: `/api/tooling-hub/dashboard?tool=dies&view=board`, 2,869 ms, 277.8 KB per call, duplicated
- Rows over 100: `inventory[273]`
- Nested data: `triage[6]`, `similarMatches[3]`, full inventory
- Recommendation: highest-priority payload fix. Do not load full die inventory on first board render. Load active lane summary first; inventory ledger/search/details only when opened.

## Duplicate API Requests

High-value duplicates found on first render:

- `/api/tooling-hub/dashboard?tool=dies&view=board` twice
- `/api/procurement/dashboard` twice
- `/api/production/stages/cutting?limit=150&mode=compact&tab=pending` twice
- `/api/designing/po-lines` twice
- `/api/plate-hub/dashboard?view=board` twice
- `/api/purchase-orders?mode=compact&paged=1&limit=100` twice per Purchase Orders render; four calls total because `/` redirected there too
- `/api/procurement/grn?limit=50&q=&status=&supplier=&posted=` twice
- `/api/masters/customers` twice on AW Queue plus once on Billing
- `/api/users` twice on AW Queue
- `/api/auth/session` twice on most measured pages

## APIs Returning More Than 100 Rows

- `/api/tooling-hub/dashboard?tool=dies&view=board`: `inventory[273]`

No other captured JSON response had an array over 100 rows in this small local dataset, but several first-render routes still request high limits (`limit=100`, `limit=150`) and should remain clamped for larger production data.

## Nested Relations Loaded Before Interaction

- `/api/tooling-hub/dashboard?tool=dies&view=board`: `inventory[273]`, `triage`, `similarMatches`
- `/api/designing/po-lines`: full `specOverrides` including orchestration and plate hub payload
- `/api/job-cards?mode=compact&paged=1&limit=150&yieldMetrics=1`: `poLine`, `stages[9]`, `yield`
- `/api/production/stages/cutting?limit=150&mode=compact&tab=pending`: `stageRecord`, `jobCard`, tab count metadata
- `/api/purchase-orders?mode=compact&paged=1&limit=100`: `customer`, `lineItems`, `readiness`
- `/api/bills?compact=1&paged=1&limit=100`: `customer`, `lineItems`

## APIs Called Before User Interaction That Should Be Lazy

- Tooling inventory data inside `/api/tooling-hub/dashboard?tool=dies&view=board`
- AW `specOverrides` detail inside `/api/designing/po-lines`
- Job Card `stages` and `yield` inside first list load
- Stage Board job-card enrichment beyond visible lane fields
- Purchase Order readiness/line detail if not rendered in the first visible table
- Billing customer full list, unless the current filter UI requires it immediately
- Hub linked customer/color/audit-like enrichment where not visible

## Client-Side Filtering of Large Arrays

Runtime evidence found one large first-render client candidate:

- Tooling Hub receives `inventory[273]` in the dashboard response. Any search/filter over die inventory on the client is operating over this broad array. This should move to server-side search/pagination or tab-gated inventory loading.

Likely medium-sized client-side filtering candidates:

- AW Queue filters over 11 heavy `poLines` plus full customer/user lists.
- Billing filters over a full customers list.
- Purchase Orders filters over 19 compact rows in this dataset, but the `limit=100` first request will become expensive with production data.

## Commonisation Opportunities

Highest-value commonisation should target behavior first, not visual redesign:

1. Shared duplicate-fetch guard or stable effect pattern for list pages.
2. Shared `usePagedList`/query-key convention for `page`, `limit`, `q`, `sort`, `mode=compact`.
3. Shared master-data/registry provider to avoid repeated `/api/masters/registry`.
4. Shared searchable lookup for customers/users/operators instead of full list preload.
5. Shared hub board contract: lane summary first, inventory/detail/export on demand.
6. Shared detail loader state for row click/drawer/modal.

## Priority Recommendations

### Phase A: Immediate Bottlenecks

- Dedupe `/api/tooling-hub/dashboard?tool=dies&view=board` and remove full `inventory[273]` from first render.
- Dedupe `/api/procurement/dashboard` and profile/optimize its DB query path.
- Dedupe `/api/production/stages/cutting?...` and reduce first-list nested job/stage enrichment.
- Dedupe `/api/designing/po-lines` and create a compact AW list.

Expected speed gain: high. These routes dominate both payload and perceived wait.

### Phase B: Payload Tightening

- Reduce Job Cards compact response by moving `stages` and `yield` detail to row click.
- Reduce Purchase Orders compact response and stop duplicate first-render list calls.
- Replace Billing and AW full customer/user list preload with searchable capped lookup.

Expected speed gain: medium-high, especially on production data volume.

### Phase C: Shared Runtime Hygiene

- Cache `/api/masters/registry` at app/provider level.
- Normalize `/api/auth/session` consumption to avoid double call per route.
- Add runtime regression measurements to CI or a local profiling script once production build is fixed.

Expected speed gain: medium but broad.

## Build and Profiling Blockers

- `npx next build` compiled successfully, then failed during page-data collection:
  - `ENOENT: no such file or directory, open '.next/server/pages-manifest.json'`
- `next start` on stale artifacts returned 500s:
  - Missing `.next/server/pages/_error.js`
  - Missing several `.next/server/app/.../page.js` bundles
- Because of this, production-mode profiling is not deploy-ready and must be rerun after the manifest blocker is fixed.

## Final Recommendation

The true top bottleneck is Tooling Hub payload size. The next true bottlenecks are duplicated, slow summary/list APIs in Procurement, Production Stage Boards, Designing/AW Queue, Plate Hub, and Job Cards. Do not start another broad refactor yet. First fix production build, then rerun this same profiling flow against `next start`, and only then implement the high-confidence API and duplicate-call fixes above.
