#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/lib/product_common.sh
source "$SCRIPT_DIR/lib/product_common.sh"

ROOT="$(product_repo_root)"
failed=0
SECURITY_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trace-cue-security.XXXXXX")"

cleanup_security_temp() {
  rm -rf -- "$SECURITY_TEMP_DIR"
}

trap cleanup_security_temp EXIT

repository_files() {
  find "$ROOT" \
    \( -path "$ROOT/.git" \
      -o -path "$ROOT/node_modules" \
      -o -path "$ROOT/dist" \
      -o -path "$ROOT/build" \
      -o -path "$ROOT/coverage" \
      -o -path "$ROOT/test-results" \
      -o -path "$ROOT/playwright-report" \
      -o -path "$ROOT/.browser-debug" \
      -o -path "$ROOT/.trace-cue" \) -prune \
    -o -type f -print0
}

product_require_nonempty_file "$ROOT" docs/workflow/SECURITY.md || failed=1
product_require_nonempty_file "$ROOT" ops/SECURITY_MANIFEST.tsv || failed=1
product_require_nonempty_file "$ROOT" .codex-plugin/plugin.json || failed=1
product_require_nonempty_file "$ROOT" .mcp.json || failed=1
product_require_nonempty_file "$ROOT" skills/trace-cue-review/SKILL.md || failed=1

while IFS= read -r -d '' file; do
  rel="$(product_rel "$ROOT" "$file")"
  case "$rel" in
    .git/*|node_modules/*|dist/*|build/*|coverage/*|test-results/*|playwright-report/*|.browser-debug/*|.trace-cue/*|tools/check_product_security.sh)
      continue
      ;;
  esac
  grep -Iq . "$file" 2>/dev/null || continue
  secret_scan_file="$SECURITY_TEMP_DIR/secret-scan"
  if grep -nE '(SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[[:space:]]*[:=][[:space:]]*[^[:space:]#]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY' "$file" >"$secret_scan_file"; then
    if [[ "$rel" == "tests/cli.test.js" || "$rel" == "tests/agentic-human-review.test.js" ]]; then
      grep -Ev 'TRACE_CUE_TEST_SECRET:[[:space:]]*sentinel' "$secret_scan_file" >"$SECURITY_TEMP_DIR/secret-filtered" || true
      mv "$SECURITY_TEMP_DIR/secret-filtered" "$secret_scan_file"
    fi
  fi
  if [[ -s "$secret_scan_file" ]]; then
    printf 'secret-like data found in %s\n' "$rel" >&2
    failed=1
  fi
  rm -f "$secret_scan_file"
done < <(repository_files)

while IFS= read -r -d '' file; do
  case "$(basename "$file")" in
    .env|.env.*) ;;
    *) continue ;;
  esac
  rel="$(product_rel "$ROOT" "$file")"
  printf 'environment file must not be committed: %s\n' "$rel" >&2
  failed=1
done < <(repository_files)

scan_runtime_pattern() {
  local pattern="$1"
  local label="$2"
  local ignore_regex="${3:-}"
  if grep -RInE "$pattern" "$ROOT/src" "$ROOT/bin" >"$SECURITY_TEMP_DIR/runtime-scan" 2>/dev/null; then
    if [[ -n "$ignore_regex" ]]; then
      grep -Ev "$ignore_regex" "$SECURITY_TEMP_DIR/runtime-scan" >"$SECURITY_TEMP_DIR/runtime-filtered" || true
      mv "$SECURITY_TEMP_DIR/runtime-filtered" "$SECURITY_TEMP_DIR/runtime-scan"
    fi
    if [[ ! -s "$SECURITY_TEMP_DIR/runtime-scan" ]]; then
      return
    fi
    while IFS= read -r line; do
      printf 'forbidden runtime pattern for %s: %s\n' "$label" "${line#$ROOT/}" >&2
    done <"$SECURITY_TEMP_DIR/runtime-scan"
    failed=1
  fi
  rm -f "$SECURITY_TEMP_DIR/runtime-scan"
}

scan_runtime_pattern 'launchPersistentContext|userDataDir' 'browser profile reuse'
scan_runtime_pattern 'storageState' 'unapproved storageState persistence' 'src/browser-session-worker\.js:|src/browser-session-manager\.js:|src/mcp-profiles\.js:|src/operation-registry\.js:|src/mcp-capabilities\.js:'
scan_runtime_pattern 'createServer|listen\(|WebSocket|EventSource' 'unapproved external control channel' 'src/mcp-http-transport\.js:|src/agentic-human-review-responses-adapter\.js:|src/control-center-server\.js:'
scan_runtime_pattern "node:child_process|from ['\"]child_process|require\\(['\"]child_process|execFile|spawn\\(" 'arbitrary shell execution' "src/daemon\\.js:|src/browser-session-manager\\.js:[0-9]+:import \\{ spawn as defaultSpawn \\} from 'node:child_process';|src/browser-session-manager\\.js:[0-9]+:  const child = spawn\\(process\\.execPath, args, \\{|src/playwright-test-runners\\.js:[0-9]+:import \\{ spawn \\} from 'node:child_process';|src/playwright-test-runners\\.js:[0-9]+:    const child = spawn\\(command, args, \\{|src/control-center-launcher\\.js:[0-9]+:import \\{ spawn as defaultSpawn \\} from 'node:child_process';|src/fixed-process-runner\\.js:[0-9]+:import \\{ spawn as nodeSpawn \\} from 'node:child_process';"
scan_runtime_pattern 'npm publish|gh repo|curl |wget ' 'publication or external transfer'

if ! grep -q 'trace-cue-mcp' "$ROOT/.mcp.json"; then
  printf 'plugin MCP configuration must reference trace-cue-mcp\n' >&2
  failed=1
fi

if grep -RInE 'createServer|listen\(|WebSocket|EventSource|curl |wget |npm publish|launchPersistentContext|userDataDir|storageState' \
  "$ROOT/.codex-plugin" "$ROOT/.mcp.json" "$ROOT/skills/trace-cue-review/SKILL.md" >"$SECURITY_TEMP_DIR/plugin-scan" 2>/dev/null; then
  while IFS= read -r line; do
    printf 'forbidden plugin metadata pattern: %s\n' "${line#$ROOT/}" >&2
  done <"$SECURITY_TEMP_DIR/plugin-scan"
  failed=1
fi
rm -f "$SECURITY_TEMP_DIR/plugin-scan"

if grep -RInE 'browser_debug_agentic.*review|agentic_human_review|raw_pixel_transfer|page_text_transfer' \
  "$ROOT/.codex-plugin" "$ROOT/.mcp.json" "$ROOT/src/mcp-profiles.js" >"$SECURITY_TEMP_DIR/agentic-mcp-scan" 2>/dev/null; then
  while IFS= read -r line; do
    printf 'agentic human review must not be exposed through MCP or plugin metadata: %s\n' "${line#$ROOT/}" >&2
  done <"$SECURITY_TEMP_DIR/agentic-mcp-scan"
  failed=1
fi
rm -f "$SECURITY_TEMP_DIR/agentic-mcp-scan"

[[ "$failed" -eq 0 ]] || {
  printf 'Product security check failed.\n' >&2
  exit 1
}

printf 'Product security check passed.\n'
