#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/lib/product_common.sh
source "$SCRIPT_DIR/lib/product_common.sh"

ROOT="$(product_repo_root)"
failed=0

for rel in \
  docs/product/REQUIREMENTS.md \
  docs/product/SPECIFICATION.md \
  docs/product/IMPLEMENTATION_PLAN.md \
  docs/workflow/TASK_TRACKER.md \
  docs/workflow/HANDOFF.md; do
  product_require_nonempty_file "$ROOT" "$rel" || failed=1
done

require_pattern() {
  local rel="$1"
  local pattern="$2"
  local label="$3"
  if ! grep -Eiq "$pattern" "$ROOT/$rel"; then
    printf 'missing %s in %s\n' "$label" "$rel" >&2
    failed=1
  fi
}

require_pattern docs/product/REQUIREMENTS.md 'Purpose|Required Outcomes|Success Criteria' 'requirements sections'
require_pattern docs/product/SPECIFICATION.md 'Product Shape|Planned Architecture|Browser Modes' 'specification sections'
require_pattern docs/product/IMPLEMENTATION_PLAN.md 'Phase 0|Phase 1|Approval Boundaries' 'implementation-plan phases'
require_pattern docs/workflow/TASK_TRACKER.md 'Current Status|Remaining Work|HANDOFF|TASK_TRACKER' 'workflow pair context'
require_pattern docs/workflow/HANDOFF.md 'Current State|Next Step|HANDOFF|TASK_TRACKER' 'workflow pair context'

[[ ! -e "$ROOT/REQUIREMENTS.md" ]] || failed=1
[[ ! -e "$ROOT/SPECIFICATION.md" ]] || failed=1
[[ ! -e "$ROOT/IMPLEMENTATION_PLAN.md" ]] || failed=1
[[ ! -e "$ROOT/TASK_TRACKER.md" ]] || failed=1
[[ ! -e "$ROOT/HANDOFF.md" ]] || failed=1

[[ "$failed" -eq 0 ]] || {
  printf 'Product docs check failed.\n' >&2
  exit 1
}

printf 'Product docs check passed.\n'
