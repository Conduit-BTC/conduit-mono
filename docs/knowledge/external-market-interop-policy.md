# Conduit <-> External Market Interoperability Policy

**Status:** Active
**Owner:** Protocol / Market Lead
**Applies to:** Conduit Market, Merchant Portal, Store Builder, shared protocol utilities
**Last updated:** 2026-08-16
**Decision rule:** Spec-correct emission, safe bounded compatibility, and explicit migration. External implementations inform compatibility, not protocol truth.

## External Codebase References (Expandable)

### Plebeian Market (Primary reference for now)

- Repo: https://github.com/PlebeianApp/market
- Notes: Gamma Markets / NIP-99 compliant (per partner claims); retained as a deployed compatibility target for the earlier specification lineage.

### Additional external markets

- (Add here as new partners become relevant)

## Purpose

Define the bounds of interoperability between Conduit and external NIP-99 commerce marketplaces, including implementations derived from the earlier GammaMarkets work, starting with Plebeian, while preserving:

- protocol correctness
- Conduit merchant checkout requirements
- development velocity
- architectural integrity (no silent coupling to any single app)

## Decision Order

1. Safety and protocol truth
   - Validate signatures, authorship, authorization, privacy, coordinates, and
     payment-sensitive terms strictly.
   - Implement canonical emission from NIP-99 and the current default-branch Open Markets working specification.
   - Treat branch-only Open Markets proposals as non-normative until accepted on the default branch.
   - Do not treat any external codebase as spec authority.
2. Product availability under real network conditions
   - A specification defines event meaning; it does not prove that unevenly
     adopted discovery or capability metadata is safe to make a hard gate.
   - Preserve safe user outcomes under partial, stale, delayed, or divergent
     relay views. Require positive evidence for irreversible actions without
     treating unknown negative evidence as a veto.
3. Network interoperability
   - Conduit-created listings render and are discoverable in compatible Open Markets/NIP-99 markets.
   - Compatible Open Markets/NIP-99 listings render and are discoverable in Conduit.
4. Conduit merchant checkout
   - Enable external discovery -> checkout with Conduit merchants wherever feasible.
5. Velocity and design quality
   - Do not block spec-correct implementation to mirror non-spec or fragile external patterns.
   - If we observe issues, surface and bound them; do not silently adopt them.

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

- The Open Markets repository is the active working and governance venue for the commerce specification alongside NIP-99.
- Current default-branch Open Markets material is the working reference; branch-only proposals are non-normative.
- Earlier GammaMarkets behavior remains relevant as deployed compatibility and historical context, not as the active governance source.
- Plebeian’s implementation is a compatibility target and a pragmatic reference, not an authority.
- "Spec-first" determines protocol claims, validation, and canonical emission.
  It does not automatically decide whether absent or undiscovered metadata may
  block a previously safe user journey. Apply
  `docs/knowledge/decentralized-network-product-posture.md` before introducing
  a strict product gate.

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

- verify Open Markets/NIP-99 compliance first
- classify safety, data-integrity, discovery/capability, and migration facts
  before deciding which states block the user
- distinguish signed negative evidence from incomplete or unavailable discovery
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
- Spec expectation: Open Markets/NIP-99 product listing `content` is human-readable Markdown description; structured metadata belongs in tags.
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
- Spec expectation: Open Markets/NIP-99 product listing `content` is human-readable Markdown description text; authoritative commerce fields such as price remain in structured tags or related commerce events.
- Observed behavior: External listings may include price, category, attribution, links, or other generated display copy in Markdown even when structured tags are present.
- Conduit behavior: Render product descriptions through a constrained Markdown renderer for display only. Do not infer checkout price, shipping, stock, payment, merchant identity, or order state from Markdown text.
- Risk: Level 1 rendering mismatch.
- Action: adapter.

- **[2026-07-31]** Omitted product format compatibility
- Spec expectation: GammaMarkets defaults an omitted product format to `digital`.
- Observed behavior: NIP-99 listings can predate the Gamma `type` format slot, and Conduit historically treated an omitted format as `physical`; changing that fallback would silently hide shipping behavior on existing listings.
- Conduit behavior: Continue accepting an omitted format as `physical` for backward-compatible reads. Merchant emits the explicit `digital` or `physical` format on every new listing.
- Risk: Level 1 rendering mismatch and Level 2 checkout degradation.
- Action: compatibility parser fallback; keep emitted events explicit and spec-aligned.

- **[2026-07-28]** Legacy Conduit inline product shipping tags
- Spec expectation: Gamma fixed shipping is a complete kind `30406` referenced
  by a product `shipping_option` coordinate. Price and country constraints live
  on the option; product extra cost is optional and is not used by Conduit's
  fixed launch path.
- Observed behavior: Older Conduit listings may contain `shipping_cost`,
  `shipping_country`, `shipping_restrict`, and `shipping_exclude` directly on
  kind `30402`.
- Conduit behavior: Parse those tags only through an explicit compatibility
  adapter for display and Merchant republishing. They do not authorize direct
  payment and the canonical writer never emits them.
- Risk: Level 2 checkout mismatch.
- Action: adapter.

- **[2026-08-10]** Event-backed product collections
- Spec expectation: The current Open Markets / Gamma collection text defines
  product `a` references and `shipping_option` references; it does not yet
  normatively define NIP-52 event links, empty upcoming collections, or
  organizer-authoritative two-sided membership.
- Observed behavior: Event commerce needs an organizer-owned catalog before any
  products are accepted and must distinguish merchant inclusion requests from
  organizer approval.
- Conduit behavior: Keep NIP-52 `a` linkage, empty collections, and membership
  resolution inside the explicit event-market boundary in
  `docs/specs/event-markets.md`. Emit only existing kinds and generic
  coordinates, exclude one-sided requests from the official catalog, and keep
  an upstream-ready proposal in
  `docs/knowledge/open-markets-event-commerce-proposal.md`. Pickup authorship
  remains public provenance: merchant-authored options represent merchant booth
  handoff, while an organizer-authored option advertised by the collection is
  an optional standing offer. The separate redacted organizer fulfillment
  receipt is a Conduit private-commerce message and is not presented as Gamma
  order-message interoperability.
- Risk: Level 1 catalog membership and Level 2 checkout provenance.
- Action: upstream proposal plus narrow, removable parser/writer boundary.
  Governance and removal criteria are tracked in
  `docs/knowledge/event-market-collection-extension.md`.
