# Conduit Design System

This document defines the shared visual system for Conduit and where shared UI decisions should live.

## Overview

Conduit uses one shared visual system across `apps/market`, `apps/merchant`, `apps/store-builder`, and shared UI in `packages/ui`.

- `market` and `merchant` use the same token set and the same dark-first visual language.
- `store-builder` should inherit the same shared foundations unless a documented product need requires a scoped variation.
- Light mode already exists in the token layer through `prefers-color-scheme`, even if not every screen is fully refined for it yet.
- Design decisions should be expressed through tokens in `packages/ui/src/styles/theme.css` and typography variables in `packages/ui/src/styles/typography.css`.
- New UI should not introduce raw hex, `rgba(...)`, or Tailwind palette colors when a Conduit token already exists.

## Goals

- keep shared visual decisions easy to find
- reduce repeated hardcoded colors, spacing, radii, shadows, and typography values
- make it obvious when a style should become a token versus staying local

## Source of Truth

- shared tokens, theme variables, reusable visual primitives, and shared components belong in `@conduit/ui`
- app-local composition belongs in `apps/*`
- implementation requirements that change behavior still belong in `docs/specs/*`
- this document defines shared visual and theming guidance for the monorepo

## Token-First Rule

- prefer shared tokens or CSS variables over raw hardcoded values when the value is brand-defining, reused, or likely to spread
- if a new value is likely to be reused across Market, Merchant, or Store Builder, promote it into shared theme infrastructure before copying it into app code
- keep one-off local styling local only when it is truly isolated and not a new design-system decision

## Where Design Decisions Should Live

- `packages/ui/src/styles/*`: theme variables, token definitions, typography, and shared primitives
- `packages/ui/src/components/*`: reusable components built from those shared tokens
- `apps/*`: route-level layout, composition, and app-specific presentation that does not redefine the shared system

## Design Principles

- Use a dark, high-contrast base with luminous brand accents.
- Keep structure calm: background, card, and border tones should recede so content and actions stand out.
- Use purple as the core brand/action color, orange as a warm secondary accent, rose as a decorative highlight, and semantic colors for status.
- Favor deliberate typography hierarchy over extra decoration.
- Use the shared tokens first; only add a new token when an existing one cannot express the intended role.

## Themes

### Dark Theme

Dark theme is the current default.

- `--background`: global page background
- `--surface`: primary card and panel surface
- `--surface-elevated`: lifted surfaces like search fields and nested panels
- `--surface-dialog`: modal/dialog background that should pop above page chrome
- `--border`: default structural border

### Light Theme

Light theme is already available via `@media (prefers-color-scheme: light)` in `packages/ui/src/styles/theme.css`.

- `--background` becomes a light neutral surface
- `--foreground` and text tokens flip to dark values
- `--surface`, `--surface-elevated`, and `--surface-dialog` become white-based surfaces
- `--border` becomes a neutral light border

Guidance:

- All new UI should use semantic tokens so it can inherit both dark and light themes correctly.
- Do not hardcode dark-specific colors in app components.

## Typography

Typography is defined in `packages/ui/src/styles/typography.css`.

### Font Roles

- `--font-display`: `Whyte Inktrap Variable` for strong brand moments and large headlines
- `--font-heading`: `Poppins` for section titles and structured headings
- `--font-body`: `Poppins` for paragraphs, forms, tables, and general UI copy
- `--font-mono`: `Whyte Mono Inktrap Variable` for ids, pubkeys, technical metadata, and dense utility labels

### When To Use Each Font

- Use `display` for hero titles, logo-adjacent lockups, and standout marketing moments.
- Use `heading` for dashboards, section headings, card titles, and interface labels that need clarity.
- Use `body` for all general reading and control text.
- Use `mono` only for technical strings such as pubkeys, IDs, invoice references, and relay-like metadata.

### Voice Scale

Use the `voice-*` scale from `packages/ui/src/styles/typography.css` when possible.

- `voice-xs`, `voice-sm`, `voice-base`, `voice-lg` for supporting copy and product UI
- `voice-xl` to `voice-4xl` for headings inside app surfaces
- `voice-5xl` and `voice-6xl` for landing and brand-heavy display moments

Guidance:

- Prefer a smaller number of clear typographic levels.
- Avoid mixing display font into dense dashboard/table areas.
- Avoid long blocks of all-caps text; reserve uppercase for tags, overlines, and tiny metadata.

## Color System

### Primitive Palettes

Defined in `packages/ui/src/styles/theme.css`:

- `primary-*`: brand purple, main action color
- `secondary-*`: orange, warm support/action accent
- `tertiary-*`: rose, decorative glow/highlight accent
- `accent-*`: indigo, utility accent when purple is already occupied
- `neutral-*`: gray scale for structure and type support
- `success`, `warning`, `error`, `info`: semantic system colors

### Semantic Tokens

Use these first in app code:

- `--background`
- `--foreground`
- `--surface`
- `--surface-elevated`
- `--surface-dialog`
- `--border`
- `--text-primary`
- `--text-secondary`
- `--text-muted`
- `--ring`

### Figma / Asset Mapping

- `#05001D` -> `--background`
- `#BB00FF` -> `--primary-500`
- merchant pink/rose glows -> `--tertiary-500`
- dark card tones around `#211E31` -> express through `--surface`, `--surface-elevated`, and `--surface-dialog`
- white text/icons -> `--text-primary` or token foreground equivalents

Use token mapping rather than copying raw asset colors into components.

## Color Usage Rules

### Backgrounds

- Use `bg-[var(--background)]` for page backgrounds and route shells.
- Use `bg-[var(--surface)]` for standard cards, sections, and persistent chrome.
- Use `bg-[var(--surface-elevated)]` for nested panels, search fields, and secondary containers.
- Use `bg-[var(--surface-dialog)]` for modal/dialog shells so they pop above the page.

### Borders

- Use `border-[var(--border)]` for structural borders.
- Use stronger border treatments only for explicit hover, active, or selected states.
- When a state needs a brand border, prefer token palette classes like `border-primary-500/70` over raw Tailwind colors.

### Text

- Use `text-[var(--text-primary)]` for default foreground text.
- Use `text-[var(--text-secondary)]` for supporting copy.
- Use `text-[var(--text-muted)]` for tiny metadata, hints, and inactive labels.
- Prefer `--text-secondary` over ad hoc opacity on `--text-primary` unless a specific art direction calls for it.

### Actions And Emphasis

- Use `primary` for primary CTAs, active filters, selection, and brand emphasis.
- Use `secondary` for warm support states, merchant/signer accents, and warm highlights.
- Use `tertiary` for decorative radial glows and accent lighting, not as the main CTA color.
- Use `accent` sparingly when a non-purple utility distinction is helpful.

### Status Colors

- Use `success`, `warning`, `error`, and `info` tokens for system state.
- Do not use Tailwind palette shortcuts like `text-emerald-400`, `text-amber-300`, or `bg-fuchsia-500` in app UI.

### Shadows And Effects

- Use Tailwind shadow tokens (`shadow-sm`, `shadow-md`, `shadow-lg`, `shadow-xl`) when they fit.
- Use `shadow-[var(--shadow-glass-inset)]` for the recurring glass top-edge highlight.
- Use `shadow-[var(--shadow-dialog)]` for dialog depth.
- Decorative glow effects should derive from token colors via `color-mix(...)`, not raw `rgba(...)` values.

## Hardcoded Value Policy

Avoid adding raw values directly in app code when they represent any of the following:

- repeated brand colors
- shared spacing or sizing conventions
- repeated border radius or shadow patterns
- typography scales used in multiple surfaces
- reusable background treatments or elevation rules

If a hardcoded value is temporary or intentionally local, keep it close to the component and leave a short explanation in the PR description.

## Style Rules

### Surfaces

- Keep most panels restrained and readable.
- Let texture come from subtle border, blur, and highlight treatment rather than heavy gradients everywhere.
- Reserve stronger gradients for onboarding, confirmations, charts, and brand storytelling moments.

### Motion

- Use motion to support orientation and state change.
- Keep transitions smooth and short.
- Avoid ornamental animation in data-dense screens.

### Iconography

- Default icons should inherit surrounding text color.
- Brand or status icons may use token palette colors.
- Avoid one-off icon colors unless they encode real meaning.

### Radius And Shape

- Use the radius tokens from `theme.css` and Tailwind config.
- Larger panels may use `rounded-[2rem]` when they are hero surfaces or modal shells.
- Smaller controls should stay within the shared radius system.

## Approved Patterns

### Standard Card

```tsx
<section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
```

### Elevated Input Or Nested Panel

```tsx
<div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]">
```

### Dialog Shell

```tsx
<DialogContent className="border-[var(--border)] bg-[var(--surface-dialog)] shadow-[var(--shadow-dialog)]" />
```

### Decorative Glow Using Tokens

```tsx
<div className="bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--tertiary-500)_16%,transparent),transparent_36%)]" />
```

### Active Brand State

```tsx
<button className="border-primary-500/70 bg-primary-500 text-white" />
```

## Anti-Patterns

Do not introduce these in new code:

- raw dark backgrounds like `bg-[#090314]`, `bg-[#0d0424]`, `bg-[#090512]`, `bg-[#0b0717]`
- structural card styles like `bg-white/[0.04]` and `border-white/10` when `--surface` and `--border` fit
- raw decorative brand glows like `rgba(255,86,164,...)`
- Tailwind palette substitutions like `bg-fuchsia-500`, `text-emerald-400`, `text-amber-300`
- one-off purple shadow values that do not derive from tokens
- default/system font fallbacks as the intended product typography

## Where To Edit

- color tokens: `packages/ui/src/styles/theme.css`
- typography: `packages/ui/src/styles/typography.css`
- shared site/base styles: `packages/ui/src/styles/site.css`
- shared components: `packages/ui/src/components/*`
- app-specific implementation: `apps/market/src/**`, `apps/merchant/src/**`, `apps/store-builder/src/**`

## PR Expectations For UI Work

- update shared tokens before repeating a new visual value in multiple places
- link the relevant docs/spec PR if the design change affects shared implementation expectations
- include screenshots or other visual evidence for meaningful UI changes
- keep tracked design guidance public-repo-safe and free of private planning language

## Review Checklist

Before merging UI work, verify:

- no new raw hex or `rgba(...)` color values were added without a good reason
- structural surfaces use semantic tokens
- active/brand states use Conduit palette tokens
- typography uses the shared font roles and not ad hoc stacks
- the screen remains legible in both dark and light token contexts
- new decorative treatments derive from tokens instead of one-off palette values

## Notes

- `market`, `merchant`, and `store-builder` should feel like one product family with different workflows, not separate brands.
