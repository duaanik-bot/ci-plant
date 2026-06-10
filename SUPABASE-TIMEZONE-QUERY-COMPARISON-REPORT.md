# Supabase Timezone Query Comparison Report

## Scope

This report compares the previous Supabase DB query-stat snapshot with a recent re-check of the confirmed slow timezone catalog query:

```sql
SELECT name FROM pg_timezone_names
```

The source is Postgres `pg_stat_statements`, inspected through the configured Supabase `DIRECT_URL`. This is cumulative database query-stat data since the `pg_stat_statements` reset time, not timestamped Supabase Log Explorer event data.

## Snapshot Files

- Previous snapshot: recorded during the earlier manual DB inspection in this thread.
- Recent snapshot log: `logs/supabase-timezone-query-2026-06-02_18-28-18-602Z.json`

## Stats Window

| Field | Previous | Recent |
|---|---:|---:|
| Stats reset | `2026-05-19 10:36:45.359 UTC` | `2026-05-19 10:36:45.359 UTC` |
| Recent inspection time | N/A | `2026-06-02 18:28:18.256 UTC` |
| Database | `postgres` | `postgres` |

The stats reset timestamp did not change, so the two snapshots are directly comparable.

## Query Comparison

| Metric | Previous | Recent | Delta |
|---|---:|---:|---:|
| Calls | `95` | `95` | `0` |
| Total rows returned | `113,620` | `113,620` | `0` |
| Total execution time | `18,479.434 ms` | `18,479.434 ms` | `0.000 ms` |
| Mean execution time | `194.520 ms` | `194.520 ms` | `0.000 ms` |
| Min execution time | `54.557 ms` | `54.557 ms` | `0.000 ms` |
| Max execution time | `2,595.723 ms` | `2,595.723 ms` | `0.000 ms` |
| Active matching queries | `0` | `0` | `0` |

## Findings

- No new executions of `SELECT name FROM pg_timezone_names` were recorded between the previous inspection and the recent inspection.
- The query remains present in cumulative DB stats because `pg_stat_statements` has not been reset.
- The total cost is still visible historically: `95` calls and about `18.48 seconds` total execution time.
- There was no active matching query during the recent inspection.

## Interpretation

The recent cleanup did not remove a local timezone query call site because no such call site exists in this worktree. However, the comparison shows that the problematic query has not run again since the previous DB inspection.

This supports one of these possibilities:

- The code path that triggered the query has not been exercised again.
- The live/deployed caller is inactive right now.
- The original source was another Supabase-connected client, tool, or deployed build not represented in this local worktree.

It does not prove the deployed root cause is permanently fixed, because the local source still does not contain the call site.

## Logs Created

The recent DB inspection log was saved at:

```text
logs/supabase-timezone-query-2026-06-02_18-28-18-602Z.json
```

The log includes:

- inspected target metadata with DB user redacted
- `pg_stat_statements_info`
- exact `pg_timezone_names` query stats
- top timezone-related statements
- active query check result

## Recommended Next Step

Continue monitoring after exercising the deployed app screens suspected of opening timezone/date picker UI. If the `calls` count remains `95`, the repeated runtime issue is currently dormant. If it increases, inspect the deployed build or connected client active at that time, because the local worktree still has no `pg_timezone_names` call site.
