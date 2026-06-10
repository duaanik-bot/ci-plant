# Next Build Manifest Blocker Fix Report

Date: 2026-06-10

## Executive Summary

The Next.js build blocker is fixed. A clean `rm -rf .next tsconfig.tsbuildinfo && npx next build` now compiles, collects page data, generates static pages, finalizes optimization, collects build traces, and exits successfully.

No deployment, commit, Prisma migration, schema change, permission change, calculation change, or business workflow change was made.

## Exact Root Cause

The project is an App Router application under `src/app`, but Next 14 still expects Pages Router runtime artifacts for built-in pages during the production build. The failing build produced an incomplete `.next` output where `.next/server/pages-manifest.json` was missing during page-data and manifest collection.

Adding minimal Pages Router compatibility stubs under `src/pages` allowed Next to emit the expected built-in pages artifacts:

- `/_app`
- `/_document`
- `/_error`
- `/404`

The project had no application Pages Router routes before this pass. The new files are inert compatibility stubs and do not change the App Router page tree or user workflows.

## Files Changed

- `src/pages/_app.tsx`
- `src/pages/_document.tsx`
- `src/pages/_error.tsx`
- `src/pages/404.tsx`
- `src/app/(auth)/login/page.tsx`
- `tsconfig.json`
- `next-env.d.ts`

## Why `pages-manifest.json` Was Missing

The clean build was compiling the App Router tree successfully, but page-data collection still expected Pages Router manifest artifacts. Without any `src/pages` stubs, the server pages manifest was not available when Next attempted to collect built-in page metadata.

With the compatibility stubs in `src/pages`, the clean build now creates the server pages artifacts and completes.

## Why The Fix Is Safe

- The stubs do not add user-facing routes beyond the standard built-in pages.
- No App Router page logic was moved.
- No API route behavior was changed by the build fix.
- No auth or permission checks were changed.
- `src/app/(auth)/login/page.tsx` only guards `useSearchParams()` for the Pages Router compatibility type surface.
- `tsconfig.json` explicitly keeps `strictNullChecks: false`, preserving the previous non-strict project behavior after Next added compatibility navigation types.

## Verification Results

| Check | Result | Notes |
| --- | --- | --- |
| `rm -rf .next tsconfig.tsbuildinfo && npx next build` | Passed | Build completed fully and emitted the route size table. |
| `npm run typecheck` | Passed | `tsc --noEmit` completed successfully. |
| `npx prisma validate` | Passed | Prisma schema is valid. |
| `npx next lint` | Passed with warnings | Existing React hook, image, and ARIA warnings remain. |
| `git diff --check` | Passed | No whitespace errors before report writing. |
| Route import validation | Passed | Imported 386 API route files. |
| Production server | Passed | `npx next start -p 3016` started successfully from the clean build. |

## Browser Smoke

Production browser profiling was completed against `http://127.0.0.1:3016` using an authenticated session. The runtime profile covered Dashboard, Inventory, Planning, Purchase Orders, Procurement, GRN, Designing/AW Queue, Job Cards, Cutting Queue, Production Stage Board, Billing, New Bill, Reports, Plate Hub, Tooling Hub, Stores Issue, and Job Card New.

Non-API `ERR_ABORTED` entries were observed from Next route prefetches being cancelled during navigation. No failed API calls were captured.

## Staging Deploy Readiness

The build blocker is resolved. The branch is ready for manual QA from a build perspective, with remaining performance recommendations documented in the targeted runtime reports.
