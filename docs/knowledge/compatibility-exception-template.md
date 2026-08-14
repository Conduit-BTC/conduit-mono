# Decentralized Compatibility Exception Template

Use this template when canonical protocol behavior cannot yet be enforced
without avoidable user harm because adoption, discovery, or network convergence
is incomplete. An exception is a migration contract, not an implicit protocol
extension.

Do not use compatibility to weaken cryptographic validity, authorization,
privacy, recipient identity, payment amount or destination, or other
irreversible-value safety requirements.

## Header

- **Name:** A specific, searchable lane or adapter name
- **Status:** proposed | active | removal-ready | removed
- **Canonical target:** The protocol-correct end state
- **Owner:** Maintainer role responsible for review and removal
- **Started:** YYYY-MM-DD
- **Next review:** YYYY-MM-DD
- **Rollout control:** Feature flag, deployment profile, or other auditable gate
- **Activation state:** disabled | preview | staged | production

## Ecosystem Divergence

Describe:

- the behavior expected by the canonical public protocol source;
- the behavior observed from current clients or relays;
- when and how the divergence was verified;
- the confidence and limits of that evidence;
- which previously working cohort is harmed by strict enforcement.

Relay omission, timeout, or a complete bounded read must be described as scoped
evidence. Do not claim global absence from a finite fanout.

## Requirement Classification

Identify which facts are:

- security, authorization, privacy, identity, or payment invariants;
- data-integrity or monotonic-evidence invariants;
- discovery, capability, preference, or optional metadata;
- ecosystem-migration conditions.

State which facts remain hard gates and which may degrade.

## Behavior Matrix

| Observed state                          | Reads | Writes | User-visible state |
| --------------------------------------- | ----- | ------ | ------------------ |
| Canonical state present                 |       |        |                    |
| Previously valid state, lookup degraded |       |        |                    |
| Absent within the bounded plan          |       |        |                    |
| Partial/unavailable lookup              |       |        |                    |
| Malformed or conflicting signed state   |       |        |                    |

For each row, define the minimum positive evidence and any stronger negative
evidence that blocks the action.

## Bounds And Prohibitions

Document:

- allowed event kinds, actors, routes, and user journeys;
- allowed relay/source registry and maximum fanout;
- read and write boundaries separately;
- eligibility proof for entering the exception;
- explicit exclusions and sources that must never widen the lane;
- encryption, signing, validation, and deduplication requirements;
- local persistence and retry behavior;
- acknowledgement semantics.

## Repair And Migration

- Which surface owns repair?
- What intentional signer or user action is required?
- How does the app recognize that the canonical state now exists?
- How do subsequent operations return to canonical behavior?
- How is degraded state explained without requiring protocol expertise?

## Rollout And Rollback

- Default state by deployment profile
- Preview or synthetic validation plan
- Production enablement decision
- Immediate rollback mechanism
- Behavior when the flag is disabled while pending local work exists

No environment-only toggle should be able to widen the exception without an
auditable repository or deployment-policy change.

## Privacy-Safe Measurement

Define only aggregate, allowlisted fields needed to answer:

- How often is canonical behavior available?
- How often is the exception selected?
- Does the exception uniquely preserve successful outcomes?
- Which bounded failure classes remain?
- Is repair adoption improving?

Do not collect pubkeys, npubs, event/order/product/conversation identifiers,
relay URLs, message or order contents, ciphertext, invoices, addresses, signer
data, IPs, or fingerprints.

The denominator, aggregation window, and source of every removal metric must be
implemented and testable before production activation. A document that merely
says "track" a metric does not make the exception removable.

## Removal Gate

Specify measurable thresholds, observation duration, supported-release window,
and the exact maintainer action required to remove the exception.

Removal, renewal, or widening requires an explicit reviewed change. There is no
silent expiry.

## Regression Matrix

At minimum cover:

- canonical happy path;
- previously working non-canonical cohort;
- partial and unavailable discovery;
- signed malformed/conflicting state;
- known stronger negative evidence;
- zero, partial, and complete acknowledgement;
- retry after restart;
- transition from compatibility to canonical state;
- feature flag disabled;
- prohibited actor/event/source attempts.

## Public References

List canonical protocol sources, relevant public implementation context, and
sanitized reproducible evidence. Keep private support and operational links out
of tracked docs.
