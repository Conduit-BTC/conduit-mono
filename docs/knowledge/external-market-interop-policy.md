# Conduit <-> External Market Interoperability Policy

**Status:** Active
**Owner:** Protocol / Market Lead
**Applies to:** Conduit Market, Merchant Portal, Store Builder, shared protocol utilities
**Last updated:** 2026-07-10
**Decision rule:** Spec-first. External implementations inform compatibility, not correctness.

## External Codebase References (Expandable)

### Plebeian Market (Primary reference for now)

- Repo: https://github.com/PlebeianApp/market
- Notes: Gamma Markets / NIP-99 compliant (per partner claims); used to catch practical interoperability footguns.

### Additional external markets

- (Add here as new partners become relevant)

## Purpose

Define the bounds of interoperability between Conduit and external Gamma/NIP-99 marketplaces, starting with Plebeian, while preserving:

- protocol correctness
- Conduit merchant checkout requirements
- development velocity
- architectural integrity (no silent coupling to any single app)

## Non-Negotiable Priority Order

1. Protocol correctness
   - Implement Gamma Markets / NIP-99 as specified.
   - Do not treat any external codebase as spec authority.
2. Network interoperability
   - Conduit-created listings render and are discoverable in external Gamma/NIP-99 markets.
   - External Gamma/NIP-99 listings render and are discoverable in Conduit.
3. Conduit merchant checkout
   - Enable external discovery -> checkout with Conduit merchants wherever feasible.
4. Velocity and design quality
   - Do not block spec-correct implementation to mirror non-spec or fragile external patterns.
   - If we observe issues, we surface them; we don’t silently adopt them.

## Interoperability Levels

### Level 1 - Discovery Parity (Minimum acceptable)

**Required**

- Listings created in Conduit appear in Plebeian (and other compliant markets).
- Listings created in Plebeian appear in Conduit.
- Core fields render intelligibly (title, description, price, media, shipping basics if present, merchant identity surface).

**Fallback allowed**

- If checkout handoff is not feasible, provide explicit link-out to merchant checkout surface.

### Level 2 - One-way Checkout: External -> Conduit (Critical)

**Target**

- User discovers product in Plebeian and checks out with a Conduit merchant.
- Conduit handles order messaging and payment coordination using Conduit-supported rails and protocol flows.

**Notes**

- This path is higher priority than reverse checkout.
- Any blocker must be documented and escalated (see "Escalation").

### Level 3 - Reverse Checkout: Conduit -> External (Optional)

**Nice-to-have**

- User discovers product in Conduit and checks out with a Plebeian merchant.

**Constraints**

- Conduit will not design, implement, or debug Plebeian’s merchant UI.
- Prefer link-outs or clean protocol handoff surfaces.
- Must not delay Levels 1-2.

## Engineering Rules

### Spec-first, then compatibility

- Gamma/NIP-99 spec is the source of truth.
- Plebeian’s implementation is a compatibility target and a pragmatic reference, not an authority.

### No silent coupling

Do not bake Plebeian-specific assumptions into core logic:

- no hard-coded tag conventions unless mandated by spec
- no UI-state encoded into protocol fields
- no interpretation based solely on Plebeian UI behavior

If a Plebeian-specific behavior is required for compatibility:

- implement it behind an explicit adapter/compat layer
- document it (see "Compat Notes" below)

### Prefer robust parsing over strict "looks like our output"

- Be liberal in what we accept (within spec and safe bounds).
- Be conservative and spec-compliant in what we emit.

### Don’t endorse bad patterns

If Plebeian uses patterns that are:

- ambiguous
- non-spec
- brittle
- hostile to long-term interoperability

Then Conduit:

- implements the clean spec-aligned behavior
- records the divergence
- raises it in interoperability meetings

## Agent Instructions (Executable)

Agents and reviewers must:

- verify spec compliance first (Gamma/NIP-99)
- check Plebeian codebase conventions to avoid obvious incompatibilities
- avoid "copy-the-app" decisions without spec justification
- surface interoperability risks early with minimal patches and clear notes

Preferred phrasing in PRs:

- "Spec requires X; Plebeian currently does Y; we implement X and add optional compat for Y behind adapter Z."
- "This is spec-correct but may reduce interoperability with Plebeian because ... (documented below)."

## Escalation + Documentation

### When to create an interoperability issue

Create an issue (and add a note here) if:

- Level 1 discovery parity breaks or is at risk
- Level 2 checkout (external -> Conduit) is blocked or materially degraded
- spec ambiguity prevents a deterministic implementation
- observed divergences appear likely to fragment the ecosystem

### Issue classification tags

- `spec-ambiguity`
- `external-quirk`
- `missing-surface`
- `rendering-mismatch`
- `checkout-blocker`
- `security-or-privacy-risk`

### Monthly meeting input

For any Level 1 or Level 2 issue:

- add an agenda bullet with: symptom, minimal repro, suspected cause, proposed resolution, impact level

## Compat Notes (Living Appendix)

Add short entries here as they arise:

- **[YYYY-MM-DD]** Topic: ...
- Spec expectation: ...
- Plebeian behavior: ...
- Conduit behavior: ...
- Risk: Level 1 / Level 2 / Level 3
- Action: adapter / escalate / ignore (with reason)

- **[2026-07-08]** Partial JSON listing content display fallback
- Spec expectation: NIP-99/Gamma product listing `content` is human-readable Markdown description; structured metadata belongs in tags.
- Observed behavior: Some relayed listings use JSON object content with fields such as `title` and `description`, but do not match Conduit's legacy product schema.
- Conduit behavior: Continue parsing full legacy Conduit JSON listings, but for partial JSON content only project safe display fields (`title`, `summary`/`description`) and never render the raw JSON object as product copy.
- Risk: Level 1 rendering mismatch.
- Action: adapter.

- **[2026-07-09]** Generated storefront/card metadata in product summaries
- Spec expectation: Product listing `content` and `summary` are product description surfaces; title, price, type, category, and merchant identity have dedicated tags or profile surfaces.
- Observed behavior: Some relayed listings place generated Markdown card text in `summary`, including bare price/category/type lines and `Listed by [merchant](url)` attribution.
- Conduit behavior: Treat these repeated card metadata lines as display-only noise and strip them from parsed product summaries while preserving remaining merchant-authored description text.
- Risk: Level 1 rendering mismatch.
- Action: adapter.

- **[2026-07-09]** Product description Markdown rendering
- Spec expectation: NIP-99/Gamma product listing `content` is human-readable Markdown description text; authoritative commerce fields such as price remain in structured tags or related commerce events.
- Observed behavior: External listings may include price, category, attribution, links, or other generated display copy in Markdown even when structured tags are present.
- Conduit behavior: Render product descriptions through a constrained Markdown renderer for display only. Do not infer checkout price, shipping, stock, payment, merchant identity, or order state from Markdown text.
- Risk: Level 1 rendering mismatch.
- Action: adapter.
