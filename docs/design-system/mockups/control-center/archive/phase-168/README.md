# TraceCue Control Center Production Mock

This directory contains the approved, durable HTML design reference for the
non-engineer Control Center workflow. It is separate from the React production
implementation under `control-center/` and from ignored browser evidence under
`.browser-debug/`.

## Open

Open `index.html` directly in a browser. Query parameters provide stable mock
states for review and screenshot generation:

- `?screen=home`
- `?screen=new`
- `?screen=new&source=document_text` (file intake)
- `?screen=progress`
- `?screen=recovery`
- `?screen=result`
- `?screen=finding`
- `?screen=running`
- `?screen=settings`
- `?screen=settings&saved=1` (settings saved feedback)

The send-confirmation dialog is opened from the New review screen or by adding
`&dialog=send` to `?screen=new`.

## Captures and Checks

`assets/` contains the desktop and mobile PNG review set. Regenerate the set
with `node capture.mjs` and run the focused interaction/responsive check with
`node verify.mjs` from this directory or with the full paths from the repository
root.

## Design Source

Typography, colors, spacing, radius, sidebar width, and narrow content width
mirror `docs/design-system/tokens.json` and the accepted exploratory prototype
kept outside this production repository.

## Status

This is the approved design reference, not runtime behavior. The progress and
result content is representative interaction data. The React/Vite production
implementation uses real persisted TraceCue state and does not simulate
execution, findings, decisions, or completion.

The Phase 155 baseline is preserved under `archive/phase-155/`. The active mock
is the Phase 168 goal-completion reference and adds the unified source choice,
plain-language AI availability, and truthful recovery states while retaining
the approved layout and visual tokens.
