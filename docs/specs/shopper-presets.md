# Shopper Presets Specification

## Purpose

Conduit shoppers may opt in to synchronize checkout presets across Conduit
clients with NIP-78 application data. The preset reduces repeated checkout setup
without publishing the shopper's address or giving address plaintext to an
external signer.

The feature is an optimization. Browsing, cart review, checkout, and manual
payment remain usable when the preset is locked or relay sync is unavailable.

## Public Protocol Sources

- NIP-01: event validation, addressable replacement, and same-timestamp
  lowest-event-id selection
- NIP-78: kind `30078` application-specific addressable data

NIP-44 is not the encryption boundary for this document. The Market client
encrypts the document before it asks the active signer to sign the event.

## Event Contract

The event address is stable across document revisions:

```text
30078:<shopper_pubkey>:conduit/shopper-presets
```

The event has only this application tag in addition to optional client
provenance:

```json
[["d", "conduit/shopper-presets"]]
```

No preset value may appear in a public tag. The event `content` is a bounded,
password-encrypted envelope. The outer event must pass Nostr event validation
before the client parses or decrypts its content.

The signer receives only:

- an identity query used to confirm the active pubkey
- the final kind `30078` event whose `content` is already ciphertext

The signer must not receive the password, derived key, address plaintext, or
decrypted preset document. The client must not call signer encryption or
decryption methods for shopper presets.

## Encryption Envelope

V1 uses fixed Argon2id parameters and XChaCha20-Poly1305:

```json
{
  "format": "nostr-shopper-presets",
  "version": 1,
  "encryption": {
    "kdf": "argon2id",
    "parameters": {
      "memoryKiB": 19456,
      "iterations": 2,
      "parallelism": 1,
      "keyLength": 32
    },
    "salt": "<16-byte base64url value>",
    "cipher": "xchacha20-poly1305",
    "nonce": "<24-byte base64url value>"
  },
  "ciphertext": "<base64url value>"
}
```

Envelope serialization uses the field order shown above. Parsers require the
exact V1 parameters and canonical unpadded base64url values. Plaintext is limited
to 8192 bytes. The serialized envelope is limited to 16384 bytes.

Each save or clear operation generates a new random 16-byte salt and 24-byte
nonce. The client derives a 32-byte key from the user's password, encrypts or
decrypts locally, and overwrites the derived key bytes after use. A password must
contain 16 or more characters and at least one ASCII digit. It must not exceed
1024 UTF-8 bytes.

Wrong passwords, modified ciphertext, unsupported parameters, malformed
envelopes, and invalid document schemas must fail closed.

## Encrypted V1 Document

```json
{
  "format": "nostr-shopper-presets",
  "version": 1,
  "updatedAt": 1770000000,
  "enabled": true,
  "shipping": {
    "recipientName": "Ada Example",
    "addressLine1": "123 Market Street",
    "addressLine2": "Suite 4",
    "city": "Chicago",
    "stateOrRegion": "IL",
    "postalCode": "60601",
    "country": "US",
    "email": "ada@example.com",
    "phone": "+1 312 555 0100"
  },
  "payment": {
    "preferredRail": "automatic"
  },
  "display": {
    "currency": "BITCOIN",
    "bitcoinUnit": "sats"
  }
}
```

V1 fields:

- `updatedAt` is an informational Unix timestamp in seconds. Signed NIP-01
  fields determine event ordering.
- `enabled=false` is the encrypted clear state. A cleared document contains no
  shipping, payment, or display section.
- `shipping.recipientName`, `addressLine1`, `city`, `postalCode`, and `country`
  are required. `country` is an accepted ISO-3166-1 alpha-2 code.
- `shipping.addressLine2`, `stateOrRegion`, `email`, and `phone` are optional.
- `payment.preferredRail` is `automatic`, `nwc`, `webln`, or `manual`. It is a
  routing preference only. Local capability and payment safety remain
  authoritative.
- `display.currency` uses the Market display-currency vocabulary.
  `display.bitcoinUnit` is `sats` or `bitcoin`. Display settings never alter a
  listing, order, invoice, or payment amount.

V1 is strict. Unknown document fields and unsupported versions are rejected.
Clients must not overwrite an unsupported future version.

No NWC URI, wallet secret, wallet pubkey, relay authorization, balance, budget,
spend limit, signer connection string, private key, cart, order, invoice, or
message content is permitted in the document.

## Read And Conflict Policy

1. Read kind `30078` by exact author and `d` tag through the shared relay
   planner.
2. Prefer configured commerce write relays in the bounded read set.
3. Accept a read when at least one relay succeeds or returns a verified matching
   event. A failed relay must not invalidate useful results from other relays.
4. Distinguish a successful empty read from total relay unavailability.
5. Select the greatest `created_at`; for equal timestamps, select the
   lexicographically lowest event ID as required by NIP-01.
6. If the newest coordinate event has an invalid or unsupported envelope, fail
   closed. Do not use an older replacement.
7. Decrypt only after the user supplies or explicitly remembers the password.

Every write performs a fresh usable read first. An unsupported future version,
unavailable read, or identity mismatch blocks the write. The new event timestamp
is at least one second newer than the selected revision.

After relay acknowledgement, the client reads the exact address from the write
targets. It reports success only when its event is the NIP-01 winning
replacement. This detects a conflicting concurrent writer.

Clearing publishes an encrypted `enabled=false` replacement with a new salt and
nonce. It does not claim that relays erased historical ciphertext and does not
rely on NIP-09 deletion.

## Password And Unlock Policy

The password is independent of the Nostr identity. The identity locates and
signs the event. The password decrypts the preset.

Market supports three explicit unlock policies:

- `device`: remember the password for this identity in local storage on the
  current browser profile
- `session`: remember the password for this identity in session storage
- `always`: do not persist the password and ask on each new load

The settings UI must make this choice explicit. Device access can expose a
remembered password, so the UI must not describe device storage as key custody
or hardware-backed protection.

An explicit lock removes remembered device and session passwords and removes
the decrypted preset from React memory. Identity changes also remove the active
plaintext. The encrypted relay envelope may remain in the query cache.

A forgotten password cannot recover prior ciphertext. The shopper may publish a
new replacement with a new password. This overwrites the current addressable
revision without decrypting it.

## Local Storage And Migration

Market must not persist the decrypted preset or a plaintext address projection.
It stores the decrypted document only in active React memory. It exposes only
the minimum projection required by each workflow.

On identity connection, Market removes the legacy identity-scoped plaintext
preset key. It does not import a checkout draft into the relay preset and does
not publish automatically. The existing bounded checkout session draft remains
available as a separate checkout recovery mechanism.

Relay unavailability can block preset synchronization, but it must not block
browsing or checkout. The shopper can still enter and submit an address through
the normal checkout flow.

## Product Behavior

- The authenticated `/preferences` surface lets a shopper save, unlock, lock,
  replace, refresh, or clear the encrypted preset.
- Checkout receives the complete decrypted shipping address only in the local
  client. It hydrates empty checkout fields and never overwrites an active or
  edited checkout draft. The shopper reviews the address before order
  submission.
- Discovery and cart receive only `{country, postalCode}` derived locally from
  an unlocked preset. They do not receive the full address or contact fields.
- Default discovery may prioritize `eligible`, then `unknown`, then explicitly
  `ineligible` products while preserving Fresh & diverse ordering within each
  group. Explicit price sorts remain literal.
- The merchant receives the address only when the shopper intentionally submits
  the order through the existing encrypted order flow.
- Payment routing may honor the preferred rail only when that rail is locally
  available and safe. Existing fallback and ambiguous-payment rules remain in
  force.

## Privacy And Diagnostics

Preset plaintext, ciphertext, passwords, derived keys, address/contact fields,
signer identities, event IDs, and relay addresses are excluded from telemetry
and support diagnostics. Errors may report only content-free categories such as
relay read unavailable, invalid envelope, decrypt failed, or publish failed.

Encryption does not hide the event author, kind, `d` namespace, timestamp,
relay access, or approximate payload size. The UI must describe relay sync as
encrypted storage, not anonymous or metadata-private storage.

No address/contact value may enter a query key, URL, log, telemetry event, relay
tag, or server request. Local address consistency checks must not make
third-party requests.

## Non-Goals

- multiple saved addresses
- address recovery after password loss
- wallet credential, key, authorization, balance, or budget synchronization
- changing relay selection or adding a preset-specific relay chooser
- server-side encryption, decryption, or key custody
- claiming compatibility with non-Conduit NIP-78 settings schemas
- making preset availability a checkout or payment requirement
