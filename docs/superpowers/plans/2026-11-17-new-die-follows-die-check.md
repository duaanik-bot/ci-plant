# New die tick and "Die in the factory" follow the die check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Die Master die of exactly the costing's size turns New die off by itself; a die-list die shows on the
card with a one-click "No new die — use Job N's die"; the card shows both lists in the size check's words.

**Architecture:** pure rule change in `client/src/lib/costingRules.js` (+ `recommend` in `costingUi.js`); the editor's
size check route returns the die list too (shared `server/src/die-list.js`); the card in `CostingEditor.jsx`.

**Tech Stack:** React (Vite), Express + pg, `node:test`, embedded Postgres (`SIZING_PG=1`).

**Spec:** `docs/superpowers/specs/2026-11-17-new-die-follows-die-check-design.md`

## Global Constraints

- No commit / push / deploy without the owner's word in this session. Public repo: invented dies and job numbers only.
- A hand-set tick (`new_die` not null) and a product keep today's behaviour. Bulk costing and `matchDies` unchanged.

## Review Focus

- A costing reopened from the register (`valueFromSaved` sets `new_die` from the saved process) must not change.
- The check still loading / failing: New die stays on (no die known), no flicker into a wrong saved value.
- Changing the size away from a Die Master die's size turns New die back on (no hand-set tick).
- Several die-list dies of the size: each line has its own button; after one click all buttons go.
- Read-only view (`CostingView`): the card shows the dies but no button.

---

### Task 1: The rule

**Files:** Modify `client/src/lib/costingRules.js` (`newDieDefault`, `houseRuleValues`), `client/src/lib/costingUi.js`
(`recommend` passes `masterDie`), `client/src/lib/die-check.js` (`noNewDieLabel`). Test: `server/src/costing-rules.test.js`,
`server/src/die-check.test.js`.

**Interfaces — produces:** `newDieDefault(v, { masterDie = null } = {}): boolean`;
`houseRuleValues(v, { …, masterDie = null })`; `noNewDieLabel(d): string` → `"No new die — use Job 12345's die"`.

- [ ] Failing tests: `newDieDefault({}, { masterDie: '49' })` false; `newDieDefault({ new_die: true }, { masterDie: '49' })` true;
      `newDieDefault({})` true; houseRuleValues process 2000 with note `existing die (Die Master 49) — ₹2,000` for
      `({ style: 'LOCK' }, { masterDie: '49' })`, 3000 without; `recommend(v, { check: { dies: { exact: [{ code: 'D-1' }] }, library: { exact: [] } } })`
      → process 2000; with only `register.exact` → 3000; `noNewDieLabel`.
- [ ] Run `cd server && node --test src/costing-rules.test.js src/die-check.test.js` → FAIL; implement; → PASS; falsify.

### Task 2: The route

**Files:** Create `server/src/die-list.js` (`registerMatches(size)` moved from `routes/sizing.js`); modify
`routes/sizing.js` (import it), `routes/costing.js` (`/costing/size-check` → `dies: dieMasterMatches(...)`,
`register: registerMatches(size)`). Test: `server/src/sizing-pg.test.js`.

- [ ] Failing test: `/costing/size-check?size=…` for invented rows → `register.exact` job, `dies.exact` code, the DM- copy
      absent, `dies.reordered` for a Die Master die in another order. `SIZING_PG=1` → FAIL; implement; → PASS; falsify.

### Task 3: The card and the tick

**Files:** Modify `client/src/pages/costing/CostingEditor.jsx` (`newDie` from the check's Die Master die; `SizeKnowledge`
props `newDie`, `onNoNewDie`; the card).

- [ ] Build; TEMP-VERIFY harness of `SizeKnowledge` with invented data (Die Master die; die-list die + button; read-only;
      nothing) → screenshot → delete.

### Task 4: Whole check + final review

- [ ] Server suite (the 2 known path-space fails only), `SIZING_PG=1` sizing-pg, client build, baseline; fresh reviewer.
