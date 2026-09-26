# Mobile signer connection UI

Market and Merchant share the sign-in panel in `@conduit/ui`. It presents browser
signers and app choices before protocol terminology while preserving standard
NIP-07 and NIP-46 connections.

## Platform choices

- iPhone and iPad: "Connect with Clave" preserves the established one-tap
  Universal Link setup. Conduit prepares a standard `nostrconnect://` request,
  including its client metadata and requested permissions, then percent-encodes
  that request once in `https://clave.casa/connect/?uri=...`. The Universal Link
  gives Clave the app context needed for its connection approval UI. It does not
  extend Safari's background WebSocket lifetime, so a signer-issued `bunker://`
  connection remains the explicit same-device fallback when the direct handoff
  misses its acknowledgement. QR and copy remain cross-device fallbacks.
- NIP-07 is the first visible mobile action. A detected signer appears as
  "Continue with browser signer"; Clave or Amber is the second visible action.
  On iOS, browser signers include Safari extensions such as Nostash;
  Conduit checks `window.nostr` capabilities rather than identifying a brand.
  If passive detection misses a late or newly enabled extension, "Use a Safari
  extension" remains available and checks again when tapped. Choosing it cancels
  an owned NIP-46 pairing before starting NIP-07. A remembered NIP-07 session
  uses its reconnect action as the first choice, without a duplicate browser
  signer button. Clave or Amber stays visible as the other choice.
- Android: Amber uses a Chrome-compatible NIP-46 intent with the explicit package
  `com.greenart7c3.nostrsigner`. The request query is preserved byte-for-byte and
  the install link goes to F-Droid. No connection data is placed in an install
  fallback. NIP-55 is not exposed by this web UI; a native Android wrapper is a
  prerequisite for a meaningful same-device NIP-55 integration.
- Desktop: browser extension access and manual remote connections remain available.
  Unknown mobile environments retain manual connections without guessing an app.
- A remembered remote session offers only reconnect or forget. Starting a fresh
  pair requires intentionally forgetting the remembered session first.

"Other ways to connect" keeps QR, copy, and bunker entry collapsed on mobile.
The app choice handles preparation until its link is ready, with no extra setup
button or repeated key-custody text. When preparation starts from the app button,
the ready link says "Open Clave" or "Open Amber" and receives focus; its status
is announced to assistive technology. A pending reconnect label appears only
while restoration is active.
QR and copied links carry the same client-initiated request; a bunker link starts
from the signer.
The named Clave action uses Clave's HTTPS Universal Link rather than the shared
`nostrconnect:` scheme. Intentional manual connections remain interoperable with
any compatible signer; the protocol does not attest app brands.

## Preparation and cancellation

The iOS and Android panels prepare one request on their initial eligible mount.
Preparation is suppressed during restoration or another operation, for a remembered
session, or while an error or existing request is present. The Clave Universal Link
and Amber intent remain native anchors so the user's tap can open the app without
an asynchronous redirect. Preparing a URI does not prove the signer is installed
or the relay is ready.

The panel owns its generated and pasted-bunker attempts. Closing it, canceling,
or changing to bunker entry cancels owned work.
StrictMode cleanup and late promise settlement cannot cancel a replacement
attempt. Authentication state confirms success: a canceled core promise may
resolve and must not close a reopened dialog.

"Open again" reuses the current pending connection. Within its original two-minute
deadline, `@conduit/core` restores a closed listener after a short delay and renews
listening on foreground return, retaining the same client key, secret, and URI.
Superseded listeners and their sockets close before replacement. Cancellation,
expiration, and successful pairing remove the return listener; cancellation and
expiration require an explicit new attempt. Pending credentials remain in memory
only. Existing identity checks, encrypted established-session storage,
authentication locks, and revocation rules remain unchanged.

NIP-46 approvals are ephemeral events, so recovery does not query relay history or
assume a missed approval can be replayed. "Open Clave again" or "Open Amber again"
reuses only the same bounded in-memory pairing attempt. The client validates the
matching secret and requests the user's public key before accepting the session.
This does not cover a discarded tab, page reload, or expired connection. Once the
session is established, pairing-path UI no longer controls transport: the shared
NIP-46 session health, relay negotiation, foreground recovery, and explicit
reconnect model apply.

The UI never asks users to transfer private keys. Browser app-opening settings and
missing apps have copy/manual/install recovery; there is no install detection.

## Evidence and required QA

Automated coverage checks platform selection, handoff construction, touch targets,
manual options, cancellation, StrictMode, and delayed settlement. App launches are
intercepted. These checks cannot prove actual signer approval, universal-link
association, Android intent resolution, or OS suspension/return behavior.
Transport regression tests exercise the installed NIP-46 implementation with
in-memory sockets and real synthetic signatures/encryption, including a lost
approval followed by same-attempt reapproval. They do not prove physical-device
handoff or public-relay delivery.

Run the signer cases in [the mobile QA baseline](mobile-safari-qa-baseline.md) on
physical iPhone/Safari with Clave and Android/Chrome with Amber. Include missing
apps, rejection, timeout, reopening, relay switching, and refresh after success.
Keep connection values and QR codes out of screenshots, traces, logs, and
telemetry.

## Public references

- [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [Clave NIP-46 compatibility guidance](https://github.com/DocNR/clave/blob/master/docs/nip46-compatibility.md)
- [Android browser intents](https://developer.chrome.com/docs/android/intents)
- [Amber Android manifest](https://github.com/greenart7c3/Amber/blob/master/app/src/main/AndroidManifest.xml)
