# DESIGN_SYSTEM.md

TraceCue is primarily a command-line tool. The product may later generate HTML or Markdown reports, so this design-system placeholder records a small visual contract for future report surfaces.

## Principles

- Reports should be dense, readable, and evidence-focused.
- Issue severity, action history, screenshots, and reproduction steps should be easy to scan.
- Visual styling must not hide uncertainty or missing evidence.

## Current Status

TraceCue now includes a React + Vite local review center surface under `control-center/`. The surface imports `docs/design-system/tokens.json` and `docs/design-system/components.json` so colors, spacing, radius, fonts, and component contracts remain product-local design-system inputs instead of hard-coded one-off UI policy.

The first browser surface keeps a compact operational layout: status, next action, evidence matrix, findings, and advanced diagnostics. It should stay dense, readable, and evidence-focused. It must not add decorative backgrounds, nested cards, marketing layout, raw JSON-first pages, command launchers, provider selectors, or execution controls.

## Purpose-Led Control Center

The ordinary Control Center experience uses three top-level destinations:
`確認` (`confirm`), `進行中` (`running`), and `設定` (`settings`). The `confirm`
destination is the default purpose-led workspace. `running` shows only work
supported by current read-model truth, and `settings` contains ordinary display
and evidence-mode preferences. English locale labels remain Reviews, In
progress, and Settings.
Regression, Evidence, Findings, and Advanced remain reachable through an
explicit details group and retain their existing data and bounded actions.

The ordinary workflow may summarize five user stages: `準備` (`prepare`), `確認`
(`review`), `判断` (`decide`), `再確認` (`recheck`), and `完了` (`complete`). A
stage is navigation and status chrome, not simulated execution. The UI must not
create fake timers, percentages, findings, recheck results, or completion. Every
visible stage and completion statement must be derived from current local
read-model evidence; unavailable stages remain plainly unavailable.

Review effort is presented by user purpose while preserving canonical values:
`大切な改善点を知りたい` maps to `standard`,
`改善点を詳しく洗い出したい` maps to `deep`, and
`重要な判断の前に念入りに確かめたい` maps to `xhigh`. Their short action
labels are `大切な改善点を確認`, `詳しく確認`, and `念入りに確認`.
The submitted proposal retains the exact canonical effort. Selecting an effort
creates only the existing local proposal and does not run a provider or launch
a browser.

Ordinary screens follow a focused source/action/result pattern: one current
goal, one primary safe action, adjacent status, and one clear result or empty
state. Technical paths, commands, evidence matrices, regression controls,
diagnostics, and contract metadata stay in their existing detail destinations.
