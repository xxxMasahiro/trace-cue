# DESIGN_SYSTEM.md

TraceCue is primarily a command-line tool. The product may later generate HTML or Markdown reports, so this design-system placeholder records a small visual contract for future report surfaces.

## Principles

- Reports should be dense, readable, and evidence-focused.
- Issue severity, action history, screenshots, and reproduction steps should be easy to scan.
- Visual styling must not hide uncertainty or missing evidence.

## Current Status

TraceCue now includes a React + Vite local review center surface under `control-center/`. The surface imports `docs/design-system/tokens.json` and `docs/design-system/components.json` so colors, spacing, radius, fonts, and component contracts remain product-local design-system inputs instead of hard-coded one-off UI policy.

The first browser surface keeps a compact operational layout: status, next action, evidence matrix, findings, and advanced diagnostics. It should stay dense, readable, and evidence-focused. It must not add decorative backgrounds, nested cards, marketing layout, raw JSON-first pages, command launchers, provider selectors, or execution controls.
