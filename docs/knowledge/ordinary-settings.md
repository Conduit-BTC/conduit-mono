# Ordinary account settings

Shop and Sell share private account preferences and public storefront settings.
This is an experimental implementation of Open Markets proposal #22, not an
accepted Nostr kind allocation. The pinned contract revision is recorded beside
`tests/fixtures/ordinary-settings`; those fixtures are tested with the runtime parsers.

## Ownership and clean start

Private kind 10421 uses `openmarkets.private-settings`; public kind 10420 uses
`openmarkets.public-settings`. Both have wire major 1 and one exact `d` tag.
These are replaceable kinds: their identity is author plus kind. They are not
parameterized collections. Different kinds, parsers and publication methods
prevent visibility changes or private-to-public document conversion.

Private settings own display preferences, personal appearance, saved addresses
and their default pointer, notification preferences, working preferences and
preferred payment interface. Public settings own storefront presentation,
general location, business hours, service languages and notices. An optional
same-author 30406 reference selects a policy without containing its terms.

Complete wallet records, automatic restoration, wallet selections and recovery
material remain in their existing wallet domain. Shipping policies, product
references, calculation terms and order evidence retain their existing authority.
Changing settings never republishes products or policies. The account signer is
external; its NIP-44 v2 capability encrypts private JSON to the same owner. Public
NIP-44 v3 planning remains separate and requires public references and explicit
capability detection before any implementation.

The old password-protected shopper presets, device price overrides, merchant
ordinary settings, device weight preference and device order-sort store are
retired. There are no readers, conversions or dual writes. Existing inert database
tables are left alone to avoid a domain-store migration. Users re-enter only
ordinary preferences. Guest theme preference remains device-local.

## Runtime behavior

`settings/documents.ts` owns bounded schemas and runtime ownership checks.
`settings/events.ts` verifies exact signed payloads, encrypts only private content,
and permits opaque public round-tripping only from an unchanged verified public
baseline. Authored changes may name only known fields. Unknown nested data and
optional namespaced extensions are retained within the original document.

`settings/coordinator.ts` keeps NIP-01 newest-timestamp/lowest-ID evidence, checks
fresh bounded reads before writing and serializes each owner/kind. Web Locks and
IndexedDB compare-and-swap protect concurrent local staging. A separate settings
database stores signed events and encrypted pending baselines, never decrypted
private documents. Local staging precedes network publication. ACK and exact-ID
readback are distinct. Offline delivery retries the same signed bytes.

Disjoint edits rebase onto newer observed state. Overlapping edits keep the draft
and require review; another preference change cannot silently erase a saved
conflicting draft. Unsupported majors and malformed newer signed documents block
downgrade writes while preserving prior usable display. Unseen offline/concurrent
replacement can still lose changes: complete snapshots are not a CRDT.

Private reads use the dedicated, owner-and-kind-constrained `private_settings_read`
operation on eligible account-storage targets. The wallet read filter is unchanged.
Private writes use the existing authenticated exact-target publisher with a
separate exact settings envelope rule. Automatic signer operations use background
priority; refusal pauses automatic prompting until explicit user action or a new
session. Session retirement clears decrypted coordinator state. Public storefront
browsing uses a signer-free reader with bounded NIP-65 discovery and app relays.

Both apps mount the same automatic settings queries inside their account/relay
session. They refresh on focus and periodically. The shared Preferences UI keeps
editing baselines, supports conflict review and separates public publication from
private saves. Settings initialization does not gate wallet restoration.

The current UI applies currency/Bitcoin units, personal theme, default shipping
address, payment-interface preference, weight units and order sorting. The public
storefront renders its theme/layout, location, hours, languages and notice.
Language/locale and notification settings are portable preferences; they do not
install translations, a notification service or browser permission. Extensions,
quiet hours, reduced motion, accent tokens and policy references can round-trip
without the UI exposing an editor for every optional field.

## Validation boundary

Conformance tests exercise real fixture signatures and NIP-44 cryptography,
unknown fields, privacy confusion, competing snapshots, restart/storage failures,
refusal and account replacement. Linux Playwright covers ordinary settings across
separate Shop/Sell origins and public viewing without a signer. Existing wallet
restoration and shipping-policy tests remain separate regression evidence.

Fixture success is not installed NIP-07/NIP-46, real-device, public-relay retention
or funded-payment evidence. Maintainer-owned protocol/privacy validation remains
required. No production relay configuration, merge, release or deployment is part
of this change.
