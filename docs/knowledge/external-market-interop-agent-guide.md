# External Market Interop: Agent Guide

Use this when touching anything related to listings/events/rendering/checkout handoff that should work with external Gamma/NIP-99 marketplaces (currently: Plebeian).

Source policy: `docs/knowledge/external-market-interop-policy.md` (2026-02-10).

## Priority Order (Non-Negotiable)

1. Spec correctness (Gamma/NIP-99)
2. Discovery parity (Conduit <-> external listings render + are discoverable)
3. External discovery -> Conduit checkout (critical path)
4. Velocity + design (no roadmapping hostage to external quirks)

## Rules Of Engagement

- Spec-first: implement what the spec says. External codebases are compatibility targets, not authorities.
- No silent coupling: never hard-code Plebeian-only conventions in shared logic.
- Be liberal in what we accept (safe, best-effort parsing); be conservative in what we emit (strict, spec-aligned).
- If we must support an external quirk, do it behind an explicit compat adapter and document it.

## Interop Levels (What "Done" Means)

- Level 1 (minimum): Conduit listings show up externally and external listings show up in Conduit with intelligible core fields.
- Level 2 (critical): External discovery -> checkout with Conduit merchant (one-way). Blockers must be escalated.
- Level 3 (optional): Conduit discovery -> checkout with external merchant (link-outs preferred, must not delay L1/L2).

## How To Implement Compat Safely

When you observe external behavior that differs from spec or our emitter:

1. Confirm spec requirement first.
2. Add robust parsing and optional mapping:
   - keep it in an explicit compat layer (e.g., `@conduit/core` protocol parsing helpers or adapter module)
   - do not pollute core types with UI-state or app-specific meaning
3. Document the divergence:
   - add a short entry to the "Compat Notes" appendix in `docs/knowledge/external-market-interop-policy.md`
4. If it affects L1/L2 materially, create an interop issue:
   - tag with one of: `spec-ambiguity`, `external-quirk`, `missing-surface`, `rendering-mismatch`, `checkout-blocker`, `security-or-privacy-risk`

## PR/Review Language (Use This)

- "Spec requires X; Plebeian currently does Y; we implement X and add optional compat for Y behind adapter Z."
- "This is spec-correct but may reduce interoperability with Plebeian because ... (documented)."

## Concrete Checks (Before Shipping)

- Can we render a Plebeian listing without throwing?
- Do we show title/description/price/media/merchant identity even if fields are missing or differently tagged?
- Are we emitting spec-aligned events that Plebeian can discover?
- If L2 is in scope: can an externally discovered item route into Conduit checkout (or a clear link-out)?

