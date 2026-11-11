#!/usr/bin/env bash
set -eu

input="${1:-/workspace/skills/sales-report/assets/sales.csv}"
output="${2:-/workspace/output/sales-summary.md}"
mkdir -p "$(dirname "$output")"

# ponytail: demo CSV has no quoted fields; use a CSV-aware parser for arbitrary CSV.
awk -F, '
BEGIN {
  print "# 範例銷售摘要\n"
  print "| 品項 | 數量 | 單價 | 金額 |"
  print "| --- | ---: | ---: | ---: |"
}
NR > 1 {
  amount = $2 * $3
  total += amount
  printf "| %s | %.0f | %.2f | %.2f |\n", $1, $2, $3, amount
}
END { printf "\n總金額：%.2f\n", total }
' "$input" > "$output"

printf '%s\n' "$output"
