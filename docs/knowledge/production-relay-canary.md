# Production Relay Canary

The production relay canary is an operational check for
`relay.conduit.market`. It is intentionally separate from deterministic
Playwright and local-relay tests.

The two signals answer different questions:

- Hermetic E2E proves that Conduit behaves correctly against the controlled
  local relay fixture. It remains the pull-request and merge gate.
- The production canary proves that one GitHub-hosted runner can currently use
  the deployed relay for the critical behaviors listed below. It is a
  post-merge production-health signal, not a merge gate.

## Trigger and failure policy

`.github/workflows/production-relay-canary.yml` runs:

- after every push to `main`;
- hourly at minute 17;
- on manual dispatch from `main`.

The workflow does not run on pull requests. Candidate code must not write to
production, and a public-network outage must not fail an unrelated dependency
or product PR. Pull requests still run the canary's deterministic unit and
workflow-contract tests through normal CI.

The live workflow fails normally when a stage is unhealthy. Its check is not
part of the required CI aggregate and must not be added to branch protection.
GitHub records the recurring signal, but this public repository does not own a
private paging destination or responder rota. Connecting the failed workflow
to an operator-owned alert route remains an operational dependency.

## Checked behavior

The stage ladder is:

```text
NIP-11 -> WS -> signed event -> basic publish/ACK -> basic readback ->
kind:10050 publish/ACK -> kind:10050 discovery ->
NIP-17 wrap/publish/ACK -> recipient auth/fetch -> unwrap/decrypt ->
unauthenticated denied -> unrelated denied -> recipient re-fetch -> cleanup
```

The canary uses the shared Conduit boundaries for inbox declaration,
declaration discovery, direct-message rumor construction, NIP-44/NIP-59
wrapping and publishing, protected inbox reads, and unwrapping. A narrow raw
WebSocket probe is used only for adversarial reads that the safe product
executor correctly refuses before connecting.

NIP-11 metadata is advertised evidence only. The canary does not turn a
`supported_nips` claim into behavioral success; every material relay behavior
is checked directly.

For privacy, success requires all of the following:

1. Recipient B authenticates and retrieves the exact published gift wrap.
2. A fresh unauthenticated connection receives an NIP-42 challenge and an
   explicit `auth-required` close, with no event, for the product-shaped
   recipient-scoped exact query. An ID-only exact query must receive an
   `auth-required`, `restricted`, `invalid`, or `blocked` close and no event.
   `invalid` and `blocked` prove that the relay rejects the bypass-shaped
   filter; their rejection can occur before an authentication challenge because
   it omits the protected query shape. Generic errors and rate limits do not
   count as privacy proof.
3. Sender A authenticates as the wrong principal for Recipient B, retrieves
   Sender A's exact self-copy on that same connection as a positive control,
   then receives an explicit policy close and no Recipient B event for the same
   two cross-recipient query shapes. The recipient-scoped query accepts only
   `restricted` or `blocked`; the ID-only bypass query may also be rejected as
   `invalid`. Generic errors and rate limits do not count.
4. Recipient B retrieves the exact gift wrap again after the adversarial reads.

An empty result, timeout, or connection failure is not accepted as privacy
proof.

## Synthetic identities and data

Every run generates distinct Sender A and Recipient B identities in runner
memory. The keys are never persisted, placed in GitHub secrets,
printed, uploaded, or used as Conduit user accounts. The protected-read signer
is a runtime-local adapter used to exercise Conduit's NIP-42 state machine; it
does not prove browser NIP-07 or remote NIP-46 interoperability.

The encrypted kind-14 payload contains only a fixed canary marker and a random
in-memory token. It contains no order, customer, merchant, payment, address,
contact, wallet, or production-user data. Diagnostics contain only stage names,
pass/fail state, coarse failure codes, and latency buckets. They never include
keys, pubkeys, event IDs, signatures, challenges, filters, relay frames,
ciphertext, or plaintext.

## State lifetime and concurrency

The basic event and outer gift wraps carry one-hour NIP-40 expiration tags.
The canary also publishes bounded, expiring kind-5 cleanup events for the basic
event and Sender A / Recipient B declarations, which those identities authored.
The randomly authored recipient wrap and sender self-copy rely on their outer
expiration tags; the canary does not assume the relay accepts recipient deletion
of a gift wrap. A cleanup ACK proves relay acceptance of the cleanup request; it
does not prove immediate physical deletion from relay storage.

A runner killed after declaration publication can skip cleanup. Because
kind-10050 declarations do not currently carry expiration tags and each run
uses new identities, that can orphan up to two declarations per killed run.
Normal hourly runs delete both declarations; this residual retention risk and
any relay-side retention budget must be monitored. Adding expiration to the
shared declaration publisher requires separate protocol review.

One static workflow concurrency group serializes runs and never cancels an
in-progress canary. Per-run identities and payload tokens prevent one run from
mistaking another run's data for its own.

## What the canary proves

For the tested runner, relay, and instant in time, a passing run proves:

- the NIP-11 endpoint and WebSocket endpoint are reachable;
- a valid signed event is accepted with an `OK` acknowledgement and can be
  read back exactly;
- Sender A and Recipient B declarations are accepted and Recipient B's exact
  kind-10050 declaration is discoverable;
- Conduit's current NIP-44 v2 and NIP-59 gift-wrap path can publish a harmless
  kind-14 message to Recipient B's declared inbox;
- Recipient B can authenticate, retrieve, unwrap, and verify that exact
  message;
- unauthenticated and wrong-principal clients are explicitly denied the exact
  protected event;
- the authorized event remains available after the negative privacy probes.

## What it does not prove

A passing run does not prove:

- global relay availability, every user network path, or long-term durability;
- browser NIP-07, remote NIP-46, or signer approval UX;
- full kind-16 order schema, cache projection, checkout, payment, or merchant
  processing behavior;
- multi-relay routing, fallback, fanout, or recipient behavior on other relays;
- NIP-44 versions beyond the current public v2 path;
- immediate or physical removal of expired/deleted relay records;
- hermetic application correctness, which remains owned by the local-relay E2E
  suite.

## Public protocol references

- [NIP-11 Relay Information Document](https://github.com/nostr-protocol/nips/blob/master/11.md)
- [NIP-17 Private Direct Messages](https://github.com/nostr-protocol/nips/blob/master/17.md)
- [NIP-40 Expiration Timestamp](https://github.com/nostr-protocol/nips/blob/master/40.md)
- [NIP-42 Authentication of Clients to Relays](https://github.com/nostr-protocol/nips/blob/master/42.md)
- [NIP-44 Encrypted Payloads](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [NIP-59 Gift Wrap](https://github.com/nostr-protocol/nips/blob/master/59.md)
