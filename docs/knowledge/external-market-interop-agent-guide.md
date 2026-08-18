# External Market Interop: Agent Guide

Use this when touching anything related to listings/events/rendering/checkout handoff that should work with external NIP-99 commerce marketplaces, including implementations derived from the earlier GammaMarkets work (currently: Plebeian).

Source policy: `docs/knowledge/external-market-interop-policy.md` (2026-08-16).
Product posture: `docs/knowledge/decentralized-network-product-posture.md`.

## Decision Order

1. Preserve cryptographic, authorization, privacy, identity, and
   payment-sensitive invariants.
2. Establish canonical Open Markets/NIP-99 meaning and emission.
3. Classify missing or divergent state: data integrity,
   discovery/capability, or ecosystem migration.
4. Preserve safe discovery and checkout outcomes under incomplete network
   evidence; do not turn an unavailable source into proof of a negative fact.
5. Isolate, measure, and remove compatibility behavior rather than silently
   redefining the protocol.

## Rules Of Engagement

- Spec-first: implement what the spec says. External codebases are compatibility targets, not authorities.
- Spec-first governs protocol truth and canonical emission, not automatic
  product gating. Define the positive evidence required by the user action and
  the stronger signed evidence that can invalidate it.
- No silent coupling: never hard-code Plebeian-only conventions in shared logic.
- Be liberal in what we accept (safe, best-effort parsing); be conservative in what we emit (strict, spec-aligned).
- If we must support an external quirk, do it behind an explicit compat adapter and document it.
- Public Nostr event `content` must follow the relevant NIP. Do not publish internal JSON in public content unless that NIP explicitly defines JSON content; put structured data in tags, encrypted/private payloads, or NIP-defined JSON content instead.

## Interop Levels (What "Done" Means)

- Level 1 (minimum): Conduit listings show up externally and external listings show up in Conduit with intelligible core fields.
- Level 2 (critical): External discovery -> checkout with Conduit merchant (one-way). Blockers must be escalated.
- Level 3 (optional): Conduit discovery -> checkout with external merchant (link-outs preferred, must not delay Level 1 or Level 2).

## How To Implement Compat Safely

When you observe external behavior that differs from spec or our emitter:

1. Confirm spec requirement first.
2. Classify the divergence and decide whether strict enforcement would block a
   safe, previously working cohort because of incomplete adoption or discovery.
3. Add robust parsing and optional mapping:
   - keep it in an explicit compat layer (e.g., `@conduit/core` protocol parsing helpers or adapter module)
   - do not pollute core types with UI-state or app-specific meaning
4. Document the divergence:
   - add a short entry to the "Compat Notes" appendix in `docs/knowledge/external-market-interop-policy.md`
5. If it affects Level 1 or Level 2 materially, create an interop issue:
   - tag with one of: `spec-ambiguity`, `external-quirk`, `missing-surface`, `rendering-mismatch`, `checkout-blocker`, `security-or-privacy-risk`

## PR/Review Language (Use This)

- "Spec requires X; Plebeian currently does Y; we implement X and add optional compat for Y behind adapter Z."
- "This is spec-correct but may reduce interoperability with Plebeian because ... (documented)."

## Concrete Checks (Before Shipping)

- Can we render a Plebeian listing without throwing?
- Do we show title/description/price/media/merchant identity even if fields are missing or differently tagged?
- Are we emitting spec-aligned events that Plebeian can discover?
- If Level 2 is in scope: can an externally discovered item route into Conduit checkout (or a clear link-out)?
