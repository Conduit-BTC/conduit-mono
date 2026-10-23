# Central relay policy and installed delivery plans

The versioned registry in `packages/core/src/config.ts` owns app relay URLs,
roles and curated operator identities. The three app members are Conduit,
Brainstorm and Ditto. General reads, publishing, inbox discovery and account
storage currently execute through Conduit and Ditto; Brainstorm's execution
roles are pending qualification below. Public zap visibility and Clave wake-up
routing retain their separate specialist roles outside the app membership. These are configured candidates, not
promises of retention, availability or successful delivery.

Account storage uses `protocol/account-storage-relay-policy.ts`. Recovery,
wallet-name and address-request production factories consume that policy.
NIP-78 private data uses the existing authenticated reader/writer. A successful
connection or NIP-11 advertisement cannot establish private-storage durability:
the exact signed event must receive an ACK and be read back. Curated operator
identity supplies the independence classification; caller labels and URL aliases
cannot manufacture another operator. E2E isolation replaces the set with the
single configured loopback relay.

Configured grants are constructed through `configuredRelayTargets` in the
existing Account Network policy owner. Final I/O rechecks the same registry,
the app-source switch, whole-relay exclusions and current account authority.
Signed owner/recipient selections, protocol hints and provider destinations
remain distinct grants. Moving a URL into a configured list does not create
signed NIP-65 or NIP-17 authority.

## Coexistence and scheduling

App participation starts enabled and remains independent of the personal
NIP-65 switch. The existing versioned Account Network state retains explicit
off choices and whole-relay exclusions; registry updates never reset them.
Network settings keeps the app state visible and places disabling under a
collapsed Advanced / Danger zone at the bottom. Disabling always requires
confirmation; an off state provides a direct re-enable action.

Selection and concurrency are separate. The operation planner retains every
applicable app/personal target and alternates the source groups while retaining
order within each group. URL deduplication retains independent grants. Existing
reader workers drain the selected set through the global admission queue;
publisher workers drain the immutable write plan (default four, maximum eight
concurrent writes; authenticated prompt delivery remains serial). The existing
`maxRelayAttempts`/`maxPrimaryRelayAttempts` fields now specify concurrency,
not a first-N target cap. Per-attempt connection/read/write deadlines,
cancellation and final live authority checks still apply. No generic queue or
outbox was introduced.

Shipping, commerce, follow diagnostics and Event Market candidate paging no
longer turn concurrency into dropped source coverage. Domain event/page/request
budgets remain explicit; incomplete work retains its continuation. Required
author evidence for payments remains distinct from optional app coverage.
Recipient-specific private delivery and the bounded validated-order exception
still select their own permitted destinations. Additive public scheduling does
not authorize private broadcast or change operation success criteria.

## Brainstorm qualification

On 19 October 2026, the [deployed public configuration](https://brainstorm.world/config.js)
identified `wss://search.brainstorm.world/` as the search endpoint.
Its [NIP-11 document](https://search.brainstorm.world/) identified SearchOverTrust
(staging), advertised NIP-50 and NIP-42, and described observer-ranked search.
Bounded anonymous product, product-search and profile reads all returned
`CLOSED auth-required`, asking for an observer or authenticated identity despite
the advertised `auth_required: false`. Two further bounded queries using only
the relay-advertised public observer completed empty with EOSE. That is scoped
read completion, not proof of catalog coverage or global absence.

No write, private inbox, NIP-78 retention or authenticated readback was tested.
Brainstorm is registered as an app member with a visible qualification note
and no executable read/write/private/storage role yet. Activation requires an
explicit observer/authentication contract and suitable runtime evidence. The
separate `nip85.brainstorm.world` trust-assertion endpoint is not this service.

## Installed state

Recovery journal migration is local, transactional and idempotent. Only the
recognized legacy default prefix is eligible. Original signed events, original
targets/receipts, export acknowledgements, uncertainty and removal decisions
remain retained. An additive, versioned active delivery plan selects the current
version-1 Conduit + Ditto storage targets and preserves explicit suffix targets.
The version-1 destination history is pinned independently of future defaults.
A shared URL can retain
its existing receipt; a new URL begins pending with no invented ACK or readback.
Unrecognized target plans are retained unchanged.

Delivery retries use that active plan and the same signed event. The current
merger preserves the migrated plan and its stronger receipts across stale
snapshots. Older binaries can discard unfamiliar bookkeeping; a current client
reconstructs the plan and rechecks delivery rather than assuming success.
Account replacement
during the transaction rolls it back. New target proof is required by the
existing readiness owner; historical membership evidence remains available for
the existing recovery/removal checks.

Optional wallet-name and address-request journals migrate in their own strict
store validators. Their original events, intent tokens and target history are
preserved. Damaged optional metadata cannot invalidate the independent recovery
journal. No browser-state reset, new signature, recovery payload rewrite or
change to wallet creation/name-request gating is part of this transition.
Ordinary retries use persisted operation targets (or the separately retained
authorized transition); constructor defaults cannot widen a staged write.
Brainstorm is not a new storage destination, so storage policy version 1 remains
valid. A future destination change requires a new version and separate pending
supplemental evidence while retaining validation of version-1 records.

Already-staged order wraps use the centrally retained historical compatibility
registry for validation only. New plans use current policy. A retired target
does not authorize another send; its original in-flight ACK can still be
retained. This does not widen the existing
[validated-order migration exception](nip17-inbox-bootstrap-migration.md).

## Ownership ledger

Audit refreshed against main `f8ed7c452966d2622ade7e113810d0573e260d2d`.
The executable inventory covers apps, packages, functions, scripts, tests, E2E
and Playwright/build entry points.

| Concern                                              | Owner and disposition                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| URLs, roles, operator bindings, retired registries   | Central config; feature-owned recovery defaults deleted                                                                          |
| Configured target/grant construction                 | Account Network policy; commerce, search, shipping, shopper presets, listing/deletion delivery and settings callers migrated     |
| Final read/write admission                           | Existing relay executor/publisher and Account Network filters; account-storage app grants replace unqualified hint/source grants |
| NIP-65, NIP-17, discovery and compatibility planning | Existing relay planner, private-message routing, owner evidence and Network mutation/publication owners retained                 |
| Recovery and optional journals                       | Existing wallet stores own transactions; no additional database or generic migration framework                                   |
| Reachability, NIP-11 and observed capability         | Existing relay settings/scanning and Network views retained; observations do not grant authority                                 |
| Raw Nostr transports                                 | Existing shared reader/writer/executor and offline NDK adapter retained                                                          |
| Operator scripts                                     | Seed and NIP-89 publisher use explicit operator input; protected-read smoke remains an explicit adapter                          |
| Worker receipt relays                                | Anonymous-zap worker/operator configuration and zap receipt policy retained; neither selects private wallet storage              |
| Other WebSockets                                     | Presence is a separate protocol with exact named endpoint declarations and its own adapter                                       |
| Controlled fixtures                                  | Tests, E2E and app test-fixtures retain explicit fixture authority; the offline Merchant census blocks network access            |
| Presentation                                         | Relay input placeholders grant no authority; settings identity annotations derive from central definitions                       |

`bun run relay:check` scans executable sources in CI. It rejects feature-local
endpoint literals, representative aliased configured-grant bypasses and new raw
WebSocket/NDK transports outside the audited adapters. Negative tests also prove
that presentation/non-Nostr exceptions do not exempt executable defaults in the
same file. This is an ownership regression guard, not a substitute for authority
review or runtime admission.

Before rollout, validate the exact candidate with installed NIP-07/NIP-46
signers and the hosted relays, including authenticated ACK/readback, outage,
reload and pending installed records. Synthetic crypto/loopback tests and
production builds establish separate evidence; neither proves hosted durability.
