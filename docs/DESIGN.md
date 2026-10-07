# Conduit Design System

This document defines the shared visual system for Conduit and where shared UI decisions should live.

## Overview

Conduit uses one shared visual system across `apps/market`, `apps/merchant`, `apps/store-builder`, and shared UI in `packages/ui`.

- `market` and `merchant` use the same token set and named theme vocabulary.
- `store-builder` should inherit the same shared foundations unless a documented product need requires a scoped variation.
- Night Market and Day Market preserve the existing dark and light value sets.
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

## Component System Rule

Conduit uses shadcn-style primitives wrapped and themed in `@conduit/ui`. Product work should compose those shared primitives before adding app-local controls.

- Use existing `@conduit/ui` components for common controls: `Button`, `Input`, `Textarea`, `Select`, `Combobox`, `DropdownMenu`, `Dialog`, `Sheet`, `Tabs`, `Badge`, `StatusPill`, and shared cards.
- Do not hand-roll native `<select>`, custom listboxes, custom comboboxes, modal shells, dropdown menus, tabs, or textareas in app routes when a shared primitive exists.
- If a needed shadcn-style primitive does not exist yet, add it to `packages/ui/src/components`, export it from `@conduit/ui`, and then use that shared component from apps.
- Route files may own workflow-specific composition and state, but interaction primitives, keyboard behavior, focus handling, overlays, and shared styling belong in `@conduit/ui`.
- When there is an intentional exception, call it out in the PR description with the reason and expected follow-up.

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
- Use the brand palette for actions and status: purple for primary actions, orange for attention, rose for errors, and violet for information. Ready states use a neutral checkmark.
- Favor deliberate typography hierarchy over extra decoration.
- Use the shared tokens first; only add a new token when an existing one cannot express the intended role.

## Themes

Night Market (`night-market`) and Day Market (`day-market`) are Conduit's first two named themes. `system` is a preference resolver, not a theme: it follows `prefers-color-scheme` and resolves to one of those stable theme IDs.

Named theme values live in `packages/ui/src/styles/theme.css` under the root `data-theme` attribute. IDs, labels, local preference persistence, system resolution, document application, and browser metadata behavior live in `packages/ui/src/theme/`. The shared direct control is composed through `packages/ui/src/components/ThemeToggleButton.tsx`.

The header control always performs a direct preference change. Its initial cycle is System, Day Market, and Night Market, then back to System. The icon shows the current preference: SunMoon for System, Sun for Day Market, and Moon for Night Market. System is the default and remains selectable so the app can resume following live device changes. Additional preference UI may later configure which preferences participate in the direct cycle without replacing the header interaction.

Direct activation keeps the 44px button icon-only. The icon swaps to the new preference immediately and the button's colors change with the page theme; no label, popup, or focus move accompanies the change. Accessible names and polite announcements retain the full preference names, so screen-reader users hear the selection. Automatic system and cross-tab updates change the icon without announcing it.

The current named themes vary color and elevation values only. Typography, spacing, radii, and layout remain shared product-family foundations. Broader custom-theme authoring, scoped previews, and user-authored theme assets remain future work.

### Night Market

Night Market preserves the current dark values.

- `--background`: global page background
- `--surface`: primary card and panel surface
- `--surface-elevated`: lifted surfaces like search fields and nested panels
- `--surface-dialog`: modal/dialog background that should pop above page chrome
- `--border`: default structural border

### Day Market

Day Market preserves the current light values.

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

- `--font-display`: `Poppins` for strong brand moments and large headlines
- `--font-heading`: `Poppins` for section titles and structured headings
- `--font-body`: `Poppins` for paragraphs, forms, tables, and general UI copy
- `--font-mono`: system monospace stack for ids, pubkeys, technical metadata, and dense utility labels

Poppins follows the primary type specimen in Conduit Design’s Brand Identity
board (node `1153:44953`). The shared package bundles the same normal-style
Latin WOFF2 files used by the landing site in weights 400, 500, 600 and 700, with
the SIL Open Font License in `src/assets/fonts/Poppins-OFL.txt`. Fonts load from
the app’s own assets with `font-display: swap`; no font service request or
proprietary font is required. Other scripts use the system fallback stack.

### When To Use Each Font

- Use `display` for large headlines and standout marketing moments. Use existing image/vector artwork for the logo; do not reproduce the wordmark with a runtime font.
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
- `tertiary-*`: rose, error/destructive and highlight accent
- `accent-*`: violet, informational and utility accent
- `neutral-*`: gray scale for structure and type support
- `success`, `warning`, `error`, `info`: semantic aliases to neutral, orange, rose and violet

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

### Brand Source And Derived UI Colors

The color authority is Conduit Design, Brand Identity, **Brand elements / Colors**
(node `1153:44774`, the palette in the brand guide). The five source swatches are:

| Swatch | Exact value | Shared anchor / palette role                                     |
| ------ | ----------- | ---------------------------------------------------------------- |
| Ink    | `#05001D`   | `--brand-ink`, Night Market background, orange-action foreground |
| Purple | `#BB00FF`   | `--brand-purple`, `--primary-500`                                |
| Orange | `#F7771B`   | `--brand-orange`, `--secondary-500`, warning signal              |
| Rose   | `#D32973`   | `--brand-rose`, `--tertiary-500`, error/destructive signal       |
| Violet | `#5521C3`   | `--brand-violet`, `--accent-500`, informational signal           |

The other palette steps are derived UI shades/tints with the source hue and
saturation; they are not additional brand-guide swatches. Neutral surfaces remain
shared theme infrastructure. Use semantic foreground roles for readable copy:
exact orange, purple and rose do not all pass small-text contrast on both base
surfaces. Orange actions pair the exact orange fill with ink text. Destructive
actions pair the exact rose fill with white text.

The Foundations workbench shows the exact anchors beside live status components.
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
- Use `text-[var(--text-secondary)]` for readable metadata and hints. Reserve `--text-muted` for nonessential decoration or disabled controls; verify contrast before using it for text.
- Prefer `--text-secondary` over ad hoc opacity on `--text-primary` unless a specific art direction calls for it.

### Actions And Emphasis

- Use `primary` for primary CTAs, active filters, selection, and brand emphasis.
- Use `secondary` for warm support states, merchant/signer accents, and warm highlights.
- Use `tertiary` for errors, destructive actions and rose highlights, not the main CTA.
- Use `accent` for information and deliberate violet utility emphasis.

### Status Colors

- Use `success`, `warning`, `error`, and `info` for signal fills. Use the matching `--success-text`, `--warning-text`, `--error-text`, and `--info-text` roles for readable state labels in both themes.
- Ready/success uses neutral copy and a checkmark, warning uses brand orange, error uses rose, and information uses violet. Small error/information text uses derived shades in Day Market and tints in Night Market. Day Market warning labels use neutral copy with an orange icon, avoiding both low contrast and a brown substitute. Always preserve explicit words and distinct icons.
- Passive status uses `StatusPill` (historical export name): icon and text, without a capsule. Use a small rectangular `Badge` for attention or classification, plain text for routine counts, and a real pressed/removable control for an active filter.
- Do not use Tailwind palette shortcuts like `text-emerald-400`, `text-amber-300`, or `bg-fuchsia-500` in app UI.

### Shadows And Effects

- Persistent content is flat by default. Use spacing and rules before adding a containing card.
- Reserve depth for overlays. Do not add glass highlights or hover shadows to passive labels, product listings or settings groups.
- Use `shadow-[var(--shadow-dialog)]` for dialog depth.
- Decorative glow effects should derive from token colors via `color-mix(...)`, not raw `rgba(...)` values.

### Field Spacing

- Labels render as blocks with a readable line height. `Field` uses a 4 px label-to-control gap and 8 px before help or error text.
- Do not rely on vertical margins on inline labels; they do not establish the intended label-to-control separation.

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
- Let product imagery, merchant identity, type and aligned information provide character. Avoid repeating a panel around every section or nesting panels solely for visual grouping.
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
- Default to 4 px for tags/media/segmented choices, 8 px for contained cards and 12 px for dialogs. Most buttons and fields retain the established small control radius.
- Settings use headings and rules. Product cards retain one 8 px-radius bordered surface: media at the top, with identity, options, price and action contained in a padded body. Avoid adding another frame inside it.
- Fully round geometry belongs to avatars, switches and genuine circular controls. Do not use a capsule as the default for status, metadata or navigation.

## Shared Patterns

### Standard Card

```tsx
<section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
```

### Selected Control Surface

```tsx
<div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-elevated)]">
```

### Dialog Shell

```tsx
<DialogContent className="border-[var(--border)] bg-[var(--surface-dialog)] shadow-[var(--shadow-dialog)]" />
```

### Exceptional Brand Treatment

Reserve this for a specifically reviewed brand composition, never routine controls or status.

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
- update the relevant repo contract in the same PR when the design changes shared implementation expectations
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
