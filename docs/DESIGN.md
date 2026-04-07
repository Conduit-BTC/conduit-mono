# Design Guidance

This document defines where shared UI decisions live and how to avoid hardcoded theme drift as Conduit moves toward open-source collaboration.

## Goals

- keep shared visual decisions easy to find
- reduce repeated hardcoded colors, spacing, radii, shadows, and typography values
- make it obvious when a style should become a token versus staying local

## Source of Truth

- shared tokens, theme variables, and reusable visual primitives belong in `@conduit/ui`
- app-local composition belongs in `apps/*`
- implementation requirements that change behavior still belong in `docs/specs/*`

## Token-First Rule

- prefer shared tokens or CSS variables over raw hardcoded values when the value is brand-defining, reused, or likely to spread
- if a new value is likely to be reused across Market, Merchant, or Store Builder, promote it into shared theme infrastructure before copying it into app code
- keep one-off local styling local only when it is truly isolated and not a new design-system decision

## Where Design Decisions Should Live

- `packages/ui/src/styles/*`: theme variables, token definitions, typography, and shared primitives
- `packages/ui/src/components/*`: reusable components built from those shared tokens
- `apps/*`: route-level layout, composition, and app-specific presentation that does not redefine the shared system

## Hardcoded Value Policy

Avoid adding raw values directly in app code when they represent any of the following:

- repeated brand colors
- shared spacing or sizing conventions
- repeated border radius or shadow patterns
- typography scales used in multiple surfaces
- reusable background treatments or elevation rules

If a hardcoded value is temporary or intentionally local, keep it close to the component and leave a short explanation in the PR description.

## PR Expectations For UI Work

- update shared tokens before repeating a new visual value in multiple places
- link the relevant docs/spec PR if the design change affects shared implementation expectations
- include screenshots or other visual evidence for meaningful UI changes
- keep tracked design guidance public-repo-safe and free of private planning language

## Current Cleanup Direction

Near-term cleanup should focus on:

- consolidating repeated theme values into shared tokens
- reducing app-local hardcoded values that should live in `@conduit/ui`
- documenting shared visual rules before broad refactors spread inconsistent patterns
