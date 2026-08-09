# NIP-42 Protected Read Contract and Rollout

Status: implementation contract for the first protected-read executor slice.
This note is public implementation context, not evidence that a relay deployment
has been changed.

## Scope and boundary

The first authenticated relay operation is a signed-in principal reading their
own NIP-17 gift wraps. The request is eligible only when every filter is limited
to `kind:1059` and has exactly one recipient constraint,
`#p: [<signed-in account pubkey>]`. A mixed-kind, missing-recipient, or
cross-recipient filter is rejected before opening a protected connection or
asking a signer to sign.

All other relay reads remain anonymous. Product, profile, relay-list,
declaration, public metadata, and other public reads must not cause NIP-07 or
NIP-46 prompts merely because a relay advertises NIP-42 or sends an unsolicited
challenge.

The executor boundary is NDK-neutral:

- request filters and returned events are plain clone-safe Nostr objects;
- the relay executor owns WebSocket connections, subscriptions, NIP-42 state,
  timeouts, reconnects, validation, and typed per-relay outcomes;
- the signer boundary accepts a plain unsigned event and returns a plain signed
  event;
- NDK remains only at explicitly named edges that still need its signer and
  gift-wrap/unwrap adapters; it does not own protected-read connections,
  subscriptions, retries, or observations;
- this slice does not migrate unrelated public reads or gift-wrap cryptography.

## Transport inventory and substrate decision

The repository-wide transport scan produced this migration inventory. Test and
development fixtures are grouped because they do not own production traffic.

| Path                                                                                        | Transport                                    | Direction            | Protected data                             | NDK ownership                             | Auth before this slice                                                           | Migration action                                                      |
| ------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------- | ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/core/src/protocol/relay-executor.ts`                                              | Conduit WebSocket                            | read                 | recipient-scoped kind `1059`               | none                                      | new full NIP-42 state machine                                                    | owned protected-read substrate                                        |
| `packages/core/src/protocol/ndk.ts`                                                         | NDK client plus legacy raw WebSocket fanout  | mostly read          | historically included inbox wraps          | mixed                                     | no shared auth policy; raw fanout ignored `AUTH`/`OK`                            | kind `1059` removed; retain as named legacy public adapter debt       |
| `packages/core/src/protocol/commerce.ts` and `private-message-routing.ts`                   | read-service composition over both executors | read                 | inbox wraps, decrypted cache, declarations | NDK envelope types remain                 | declaration/public reads anonymous; protected path previously used legacy fanout | protected wraps use the new executor; declarations stay legacy/public |
| `packages/core/src/protocol/messaging.ts`                                                   | NDK gift wrap/unwrap and publish edges       | read/write envelope  | encrypted orders and messages              | allowed temporary envelope edge           | signer/session checks, not relay-read auth                                       | retain; migrate only with a separate plain cryptography contract      |
| `nip07-signer.ts`, `remote-signer.ts`, `session-signer.ts`, and `ndk-nostr-event-signer.ts` | external signer adapters                     | sign/encrypt/decrypt | account-authorized operations              | allowed temporary signer edge             | account/revision fencing                                                         | adapt to the plain signer contract; no relay ownership                |
| `relay-publish.ts`, `merchant-order-publish.ts`, and declaration repair writes              | NDK relay publish/set                        | write                | encrypted/public commerce events           | prohibited long-term core relay ownership | publish ACK/reject handling, no protected-read auth                              | explicit residual write-adapter debt; unchanged here                  |
| `follows.ts` and Market merchant-trust hydration                                            | direct NDK public fetches                    | read                 | no                                         | legacy adapter debt                       | anonymous                                                                        | leave anonymous; later executor slice                                 |
| `scripts/dev`, `scripts/smoke`, `tests`, and `e2e` relay fixtures                           | local/mock WebSockets and NDK test objects   | test/dev             | synthetic only                             | fixture-specific                          | mixed                                                                            | deterministic NIP-42 fixture added; no production authority           |

Nostrify was evaluated as the preferred replaceable substrate. The current
public `NRelay1.req()` stream exposes `EVENT`, `EOSE`, and `CLOSED` and accepts an
abort signal, while its raw `receive()` and `send()` hooks are protected. This
slice also needs direct, connection-scoped observation and control of the
incoming challenge, matching auth `OK`, exact `CLOSED` reason, retired and
retried subscription ids, and per-relay outcomes. The evaluated API did not
expose that complete state machine cleanly as one replaceable observation
boundary. Nostrify is also not a current dependency, so adding it would require
a separately approved dependency change. The existing raw WebSocket behavior
was therefore extracted and hardened behind the stable plain executor contract.
A later substrate swap must not change callers.

## Signer and session rules

Only the active NIP-07 or NIP-46 account signer may authorize a protected read.
The signed event pubkey must equal the expected active account. Guest-order
ephemeral keys, anonymous sessions, wallet keys, service signers, and
caller-supplied arbitrary keys are ineligible. There is no guest fallback.

Authenticated connections are isolated by both normalized relay URL and a
random, process-local account-session scope. The scope must not be derived from
or persisted as a pubkey. An authenticated connection must never be reused by a
different account or an anonymous request.

Close and discard the authenticated connection, its challenge, pending auth,
and subscriptions when any of these occurs:

- logout or account switch;
- signer removal or signer-authority failure;
- relay removal/read disable, settings-scope change, or read-lease replacement;
- auth rejection, auth timeout, invalid auth response, or terminal connection
  failure;
- reconnect. A reconnected socket is a new connection and must authenticate
  against its own current challenge.

Signer work is serialized per account session so a bounded multi-relay read
cannot create an unbounded extension or remote-signer prompt storm. Concurrent
requests on the same eligible connection may share one in-flight successful
authentication, but never across session scopes.

The caller's filters are cloned before connection or signer work. Authority is
checked before each protected request and terminal frame, again before the
aggregate result is returned, and around transactional cache writes. Losing
authority fails the whole protected result closed: no old-account events,
decrypted messages, or cache writes may escape after logout or account switch.

## Client state machine

For an explicitly protected request, the client follows this bounded sequence:

1. Open the session-isolated relay connection and remember the most recent
   `AUTH` challenge received on that connection. A challenge may arrive before
   any `REQ` or immediately before a relay closes a subscription.
2. If a challenge is already available, authenticate before the protected
   `REQ`. Otherwise send the initial protected `REQ` with a fresh subscription
   id. This client-first mode allows relays that have not enabled enforcement to
   continue serving the encrypted events without prompting.
3. When authentication is required, cancel or abandon the pre-auth
   subscription. Create an unsigned event with `kind:22242`, `content:""`, a
   current `created_at`, and exactly these tags:
   `[["relay", "<normalized relay URL>"], ["challenge", "<current challenge>"]]`.
4. Ask the active eligible signer to sign. Reject an altered kind, content,
   relay tag, challenge tag, timestamp outside the bounded freshness window,
   unexpected pubkey, invalid id, or invalid signature.
5. Send `AUTH` with that signed event and wait for the `OK` whose event id
   matches the auth event. Unrelated `OK` frames do not advance the state. A
   negative matching `OK`, timeout, signer failure, malformed response, or
   connection loss is a typed auth failure.
6. After a positive matching `OK`, issue the protected filters again with a new
   subscription id. The pre-auth id must not be reused.
7. Treat `CLOSED` with `auth-required:` as a request to authenticate only when a
   current challenge exists. A challenge received after `REQ` followed by that
   close uses the same sequence. `restricted:` after successful auth is a typed
   subscription rejection, not an empty result.
8. Bound challenge replacements, auth attempts, request retries, reconnects,
   frames, accepted events, bytes, and wall-clock time. Reject oversized raw
   frames before parsing. A new challenge supersedes the previous one.
   Exceeding any bound fails the relay attempt and closes the authenticated
   connection. Ending a streaming consumer aborts its remaining relay work.

Authentication proves control of a key to one relay connection. It does not
prove relay trustworthiness, message authorship, confidentiality of metadata,
or eventual delivery.

## Results, observations, and empty-state semantics

The executor preserves relay source and represents `EVENT`, `EOSE`, `CLOSED`,
`AUTH`, matching and non-matching `OK`, `NOTICE`, malformed frames, timeouts,
and connection loss as typed observations or outcomes. Consumer-facing
diagnostics use coarse codes such as `complete`, `partial`, `auth_rejected`,
`auth_timeout`, `signer_rejected`, `signer_unavailable`,
`session_identity_mismatch`, `subscription_restricted`, `connection_failed`,
and `protocol_invalid`.

Diagnostic and telemetry records must not contain challenges, auth events,
signatures, pubkeys, full filters, event contents, ciphertext, invoices,
addresses, message bodies, signer connection strings, or NWC URIs. Challenges,
auth events, and authenticated sockets are process-local and never persisted.

Multi-relay results follow these rules:

- valid events from successful relays remain usable when another relay fails;
- any mixture of usable relay results and failed/incomplete relays is
  `partial`, with source provenance retained;
- all auth failures or all unavailable relays are `unavailable`, never empty;
- zero events is an authoritative empty read only after every required relay
  attempt for that bounded plan completes successfully with `EOSE` and no
  unresolved protocol/auth failure;
- cached messages remain visible as `stale` or `degraded` during partial or
  unavailable refreshes. A failed authenticated refresh must not render an
  empty inbox or erase stronger cached evidence.

Relay settings copy distinguishes evidence states:

- **Untested:** no runtime NIP-42 evidence;
- **Advertised:** NIP-11 reports NIP-42 or an auth limitation;
- **Challenge observed:** the current runtime saw a relay challenge;
- **Succeeded:** a matching positive `OK` was observed for a valid auth event
  on the current connection;
- **Rejected:** the relay returned a matching negative auth `OK`;
- **Unavailable:** the bounded auth attempt could not establish current
  connection success for another reason.

NIP-11 is advertised evidence only. It is not proof that auth succeeded, that a
specific filter is authorized, or that protected reads are correctly enforced.

## Relay operator contract

A Conduit-operated protected inbox relay should:

1. Send a connection-bound NIP-42 challenge before, or in direct response to,
   a protected `REQ`.
2. Validate auth event kind `22242`, signature and id, empty content, freshness,
   exact current challenge, and normalized relay URL.
3. Return a matching positive or negative `OK` for the auth event.
4. Serve a `kind:1059` request only when every `#p` recipient equals the
   authenticated pubkey. Reject mixed, missing, malformed, or cross-recipient
   filters with a stable `CLOSED` reason such as `restricted:`.
5. Require fresh authentication after reconnect. A prior connection's auth or
   challenge is never transferable.
6. Keep public event reads anonymous unless a separately reviewed policy says
   otherwise.
7. Rate-limit without logging content, ciphertext, auth events, challenges,
   full filters, or stable cross-service behavioral profiles.
8. Continue accepting legitimate encrypted order/message writes from buyers,
   including guest-order ephemeral senders, without requiring the merchant's
   read authorization. Recipient-scoped read enforcement must not become a
   blanket authenticated-write rule.
9. Isolate auth-failure limits from ordinary public reads and legitimate
   commerce writes so a burst of rejected auth attempts cannot create a global
   checkout, order-delivery, or marketplace outage.

NIP-42 reduces unauthorized relay reads; it does not conceal the direct
connection IP address, authenticated pubkey, recipient tag, request timing,
event size, traffic volume, or the fact that an inbox was queried. NIP-44 and
NIP-59 protect message contents but do not remove this relay-visible metadata.

## Client-first rollout and rollback

Rollout order is intentionally client-first:

1. Ship the NDK-neutral client executor and explicit protected inbox-read path
   while all existing public reads remain anonymous.
2. Validate the deterministic client matrix and runtime behavior against a
   local scripted relay before changing hosted relay policy.
3. Enable a challenge-only, non-denying phase on a non-production or canary
   relay. Continue serving anonymous-compatible inbox reads while observing
   only aggregate, content-free outcomes.
4. Confirm the deployed Market and Merchant clients authenticate successfully
   with NIP-07 and NIP-46, retry with a new subscription id, reconnect with a
   fresh challenge, preserve cache during failures, and isolate account
   switches. Do not infer this from NIP-11 advertising.
5. Only after that confirmation, enable recipient-scoped read enforcement on
   the canary. Keep legitimate encrypted buyer and guest-order writes allowed.
6. Expand enforcement one compatibility/inbox relay at a time. Monitor only
   aggregate, content-free outcome counts and latency, with auth-failure limits
   isolated from public reads and writes.
7. Expand only after client adoption and failure-state evidence show that older
   clients and signer paths will not produce false empty inboxes.

Rollback disables relay-side enforcement for the affected relay while leaving
the challenge-capable client executor deployed. Rollback must not broaden
filters, reuse authenticated connections anonymously, clear cached messages, or
restore NDK ownership of protected-read transport. Production relay
configuration and deployment are outside this client change.

## Deterministic validation matrix

The implementation is expected to cover these cases with a scripted relay and
fake signer; this list does not claim that validation has already run.

|   # | Case                                                           | Required result                                              |
| --: | -------------------------------------------------------------- | ------------------------------------------------------------ |
|   1 | Public read, no challenge                                      | Anonymous `REQ`; signer is never called                      |
|   2 | Public read receives unsolicited challenge                     | No auth prompt or `AUTH` event                               |
|   3 | Protected read, challenge before `REQ`                         | Authenticate before protected subscription                   |
|   4 | Protected `REQ`, then challenge and `auth-required:` close     | Authenticate and retry with a new id                         |
|   5 | Matching positive auth `OK`                                    | Protected retry proceeds                                     |
|   6 | Matching negative auth `OK`                                    | Typed rejection and connection close                         |
|   7 | Unrelated `OK` before matching `OK`                            | Unrelated frame cannot authorize                             |
|   8 | Auth `OK` timeout                                              | Typed auth timeout, never empty                              |
|   9 | NIP-07 signer rejection                                        | Typed signer rejection, never guest fallback                 |
|  10 | NIP-46 unavailable/timeout                                     | Typed signer unavailable/timeout                             |
|  11 | Signed pubkey differs from active account                      | Fail closed with session identity mismatch                   |
|  12 | Signed auth event mutates required fields                      | Protocol-invalid failure; no send                            |
|  13 | Valid auth draft shape                                         | Kind, empty content, exact tags, and fresh time              |
|  14 | Retry subscription id                                          | Differs from the pre-auth id                                 |
|  15 | Repeated/new challenges exceed bound                           | Typed bounded failure and socket close                       |
|  16 | Reconnect after prior success                                  | New connection authenticates with new challenge              |
|  17 | `restricted:` after auth success                               | Typed subscription rejection, not empty                      |
|  18 | `auth-required:` without a challenge                           | Typed protocol/auth unavailable failure                      |
|  19 | Invalid event id/signature from relay                          | Event rejected with source-aware observation                 |
|  20 | Malformed/unknown relay frames                                 | Bounded protocol observation; no crash or authorization      |
|  21 | One relay succeeds and one auth fails                          | Events preserved; overall coverage is partial                |
|  22 | Every relay auth attempt fails                                 | Overall coverage unavailable, not empty                      |
|  23 | Every required relay reaches EOSE with zero events             | Complete empty result                                        |
|  24 | Cached messages plus degraded refresh                          | Cache remains visible as stale/degraded                      |
|  25 | Two account sessions use the same relay                        | No authenticated socket, challenge, or auth reuse            |
|  26 | Logout, switch, signer removal, relay removal, or lease change | Relevant authenticated sockets close                         |
|  27 | Guest attempts protected read                                  | Rejected before connect/sign; no fallback                    |
|  28 | Diagnostics and evidence persistence                           | Content-free; challenges/auth/session evidence not persisted |
|  29 | Public product/profile/relay-list/declaration reads            | Existing anonymous behavior and fixtures remain unchanged    |
|  30 | Existing NIP-17 order delivery and retry behavior              | #253-sensitive delivery/declaration regressions remain green |
|  31 | Executor contracts and scripted relay fixture                  | Plain objects only; no NDK import or NDK-owned connection    |
|  32 | Protected inbox service import boundary                        | Service depends on executor/plain signer, not NDK transport  |
|  33 | NIP-11-only auth claim in both apps                            | Advertised/untested only; never succeeded or verified        |

## Residual debt

NDK still supplies existing external-signer and gift-wrap/unwrap adapters at
named edges. Unrelated public relay reads also remain on their existing paths.
Later strangler slices may move those responsibilities only when their plain
contracts, protocol validation, cache semantics, and runtime evidence are
ready. This first slice must not add new NDK relay ownership as a shortcut.

## Public references

- NIP-01: https://github.com/nostr-protocol/nips/blob/master/01.md
- NIP-17: https://github.com/nostr-protocol/nips/blob/master/17.md
- NIP-42: https://github.com/nostr-protocol/nips/blob/master/42.md
- NIP-44: https://github.com/nostr-protocol/nips/blob/master/44.md
- NIP-59: https://github.com/nostr-protocol/nips/blob/master/59.md
- NIP-65: https://github.com/nostr-protocol/nips/blob/master/65.md
- Nostrify relay client API: https://jsr.io/@nostrify/nostrify/doc/~/NRelay1
