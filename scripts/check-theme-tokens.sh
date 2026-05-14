#!/usr/bin/env bash
# Theme-token guardrail.
#
# Fails (exit 1) if dashboard or shared components introduce raw Tailwind color
# shades or non-DS border-radius classes. Allowed exceptions:
#   - src/app/(dashboard)/hub/**                (Plate Hub printing channels: C/M/Y/K)
#   - src/app/(dashboard)/dashboard/**          (industrial glass tiles)
#   - src/app/(dashboard)/director/**           (industrial command-center tiles)
#   - src/components/industrial/**              (industrial shell + glass tiles)
#   - src/components/hub/**, src/components/po/** (printing-channel semantics)
#   - src/app/(dashboard)/orders/designing/[poLineId]/page.tsx → printing-channel string literals
#
# Run: bash scripts/check-theme-tokens.sh
# Or wire into a pre-commit / CI step.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FIND_ARGS=(
  src/app/\(dashboard\)
  src/components
  -type f
  -name "*.tsx"
  ! -path "*/hub/*"
  ! -path "*/dashboard/*"
  ! -path "*/director/*"
  ! -path "*/industrial/*"
  ! -path "*/po/*"
  ! -path "*/design-system/*"
  ! -path "*/orders/designing/*"
)

COLOR_RE='\b(text|bg|border|hover:bg|hover:border|hover:text|ring|hover:ring|dark:hover:border)-(rose|amber|emerald|sky|red|green|indigo|blue|purple|violet|fuchsia|yellow)-[0-9]{3}\b'
RADIUS_RE='\brounded-(md|lg|xl)\b'

COLOR_HITS="$(find "${FIND_ARGS[@]}" -exec grep -nE "$COLOR_RE" {} + 2>/dev/null || true)"
RADIUS_HITS="$(find "${FIND_ARGS[@]}" -exec grep -nE "$RADIUS_RE" {} + 2>/dev/null || true)"

STATUS=0

if [ -n "$COLOR_HITS" ]; then
  echo "✗ Raw Tailwind color shades found — use var(--success/warning/error/info/tooling) tokens instead:"
  echo "$COLOR_HITS"
  STATUS=1
fi

if [ -n "$RADIUS_HITS" ]; then
  echo "✗ Non-DS border-radius found — use rounded-ds-sm / rounded-ds-md / rounded-ds-lg:"
  echo "$RADIUS_HITS"
  STATUS=1
fi

if [ "$STATUS" -eq 0 ]; then
  echo "✓ Theme tokens clean — no raw color shades, no non-DS radii."
fi

exit "$STATUS"
