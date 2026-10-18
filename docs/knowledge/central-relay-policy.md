# Central relay policy and installed delivery plans

The versioned registry in `packages/core/src/config.ts` owns app relay URLs,
roles and curated operator identities. General reads, publishing, inbox
discovery and account storage use Conduit and Ditto. Commerce discovery retains
Plebeian's explicit specialist role; public zap visibility and Clave wake-up
routing retain their separate roles. These are configured candidates, not
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

## Installed state

Recovery journal migration is local, transactional and idempotent. Only the
recognized legacy default prefix is eligible. Original signed events, original
targets/receipts, export acknowledgements, uncertainty and removal decisions
remain retained. An additive, versioned active delivery plan selects the current
storage targets and preserves explicit suffix targets. A shared URL can retain
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

Already-staged order wraps use the centrally retained historical compatibility
registry for validation only. New plans use current policy. A retired target
does not authorize another send; its original in-flight ACK can still be
retained. This does not widen the existing
[validated-order migration exception](nip17-inbox-bootstrap-migration.md).

## Ownership ledger

Audit baseline: main `80de0e227d523dd09a6885db520a8bcb0b9e7297`.
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
