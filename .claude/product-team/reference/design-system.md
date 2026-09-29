# Foundation design system

Source: SPEC decisions 11, 12.

## Tokens (complete before the first feature)

- **Colour**: primitive palette → semantic roles (bg, surface, text, border, accent, success, warning, danger,
  focus) → component tokens only where needed. Light and **dark** themes from the start; contrast ≥ WCAG AA.
- **Type**: families, a modular scale, weights, line heights, letter-spacing.
- **Spacing** (4 px base), **radii**, **shadows / elevation**, **z-index layers**, **breakpoints**.
- **Motion**: durations (`instant`, `fast`, `base`, `slow`), easings (`standard`, `enter`, `exit`,
  `emphasised`), and choreography rules (stagger, enter/exit order, what may move). Every motion token has a
  `prefers-reduced-motion` fallback (opacity or none).

Components never use raw values. Lint for it where the stack allows (stylelint, eslint plugin, etc.).

## UI kit — kit-first for primitives

Atomic native elements on a headless library (Radix / Ark / React Aria / Headless UI or the stack's
equivalent): button, icon button, link, input, textarea, select, checkbox, radio, switch, label, field
(label + hint + error), icon, spinner, skeleton, tooltip, dialog, toast.

- Each primitive has a Storybook story: all variants, sizes, states (default, hover, focus-visible, active,
  disabled, loading, error), both themes, reduced motion.
- A feature that needs a missing primitive **adds it to the kit first** (own commit, own story).
- Composite domain components stay inside their feature until a second feature needs them, then move to
  shared.

## Wow

- At kickoff the owner gives 3–5 references → the `ui-designer` offers 2–3 visual directions → the owner picks one
  (recorded as a decision).
- 1–3 **signature moments** per product (e.g. onboarding reveal, the core action's success state), each built
  as an interactive prototype for approval before implementation.
- Every demo lists one wow proposal per shipped feature.
- Rich animation everywhere is rejected: noise, performance cost, accessibility harm.
