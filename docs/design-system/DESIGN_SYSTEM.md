# DESIGN_SYSTEM.md

TraceCue is primarily a command-line tool. The product may later generate HTML or Markdown reports, so this design-system placeholder records a small visual contract for future report surfaces.

## Principles

- Reports should be dense, readable, and evidence-focused.
- Issue severity, action history, screenshots, and reproduction steps should be easy to scan.
- Visual styling must not hide uncertainty or missing evidence.

## Current Status

TraceCue now includes a React + Vite local review center surface under `control-center/`. The surface imports `docs/design-system/tokens.json` and `docs/design-system/components.json` so colors, spacing, radius, fonts, and component contracts remain product-local design-system inputs instead of hard-coded one-off UI policy.

The browser surface follows the accepted Control Center prototype. Desktop uses a 232px navigation rail, an 1120px ordinary content width, and a 760px narrow form/settings width. The UI font stack is the operating-system sans serif stack with `Noto Sans JP`; body text is 16px, page titles are 30px, settings section titles are 19px, and supporting copy is 14px. Ordinary pages use white space and divider lines instead of stacked cards. It must not add decorative backgrounds, nested cards, marketing layout, raw JSON-first pages, command launchers, provider selectors, or execution controls.

## Approved Production Mock

The durable HTML mock and its desktop/mobile PNG captures live under
`docs/design-system/mockups/control-center/`. They define the approved ordinary
Control Center flow used by the React production surface: start from
a user goal, choose review depth in everyday language, explicitly confirm an
external AI send, follow progress, decide what to do with findings, and manage
the small set of ordinary preferences. Query-string screen states are stable so
the same design can be reviewed and recaptured without relying on transient
browser evidence.

The mock is the visual and interaction baseline. Its progress, findings, and
completion content are representative interaction data only. Production code
derives those states from persisted TraceCue execution and evidence and never
copies sample data as runtime behavior.

## Purpose-Led Control Center

The ordinary Control Center experience uses three top-level destinations:
`確認` (`confirm`), `進行中` (`running`), and `設定` (`settings`). The `confirm`
destination is the default purpose-led workspace. `running` shows only work
supported by current read-model truth, and `settings` contains ordinary display
and evidence-mode preferences. English locale labels remain Reviews, In
progress, and Settings.
Technical persistence state, paths, locale internals, diagnostic summaries,
regression import forms, and CI policy details are not shown on the ordinary
settings page. Their backend, CLI, API, and read-model contracts remain intact.

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
The submitted operation retains the exact canonical effort. Preparation runs a
real page review. When AI suggestions are enabled, the external provider runs
only after a concrete service/evidence disclosure and one-time confirmation.

Ordinary screens follow a focused source/action/result pattern: one current
goal, one primary safe action, adjacent status, and one clear result or empty
state. Settings follows one continuous form: display language, default screen
size, concise Playwright Test mode, AI suggestions, mandatory send confirmation,
and one save action. Status badges, duplicate
headings, storage paths, locale codes, text-direction values, translation state,
trust-boundary badges, and diagnostic disclosures stay out of this page.

The send-confirmation dialog is centered in the work area, not the full browser
viewport. It names the configured service and the evidence classes that will be
sent. Finding decisions start unselected. Provider/model/credential controls,
paths, hashes, commands, and raw artifacts never appear in the ordinary UI.
