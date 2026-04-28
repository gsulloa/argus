# Argus

A Tauri 2 desktop app for inspecting and editing data across multiple sources. V1 targets Postgres; V2+ adds DynamoDB and CloudWatch.

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, border radii, motion, and aesthetic direction are defined there. Do not deviate without explicit user approval.

A live preview of the system rendered against the real Argus shell lives at `design/preview.html` — open it in a browser when you need to see how a token reads in context.

In QA or design-review mode, flag any code that doesn't match `DESIGN.md` (wrong fonts, wrong accent color, thick borders, decorative gradients, bubbly radii, AI-slop layouts).
