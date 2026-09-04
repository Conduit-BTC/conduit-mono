# Mobile signer connection UI

Market and Merchant share the sign-in panel in `@conduit/ui`. It presents app
choices before protocol terminology while preserving standard NIP-46 connections.

## Platform choices

- iPhone and iPad: "Connect with Clave" uses a real, same-tab Universal Link:
  `https://clave.casa/connect/?uri=` followed by the standard connection URI,
  percent-encoded once. The installation link opens the App Store.
- Android: equal Amber and Primal choices use Chrome-compatible Android intents
  with explicit packages `com.greenart7c3.nostrsigner` and `net.primal.android`.
  The request query is preserved byte-for-byte. Install links go to F-Droid and
  Google Play, respectively. No connection data is placed in an install fallback.
- Desktop: browser extension access and manual remote connections remain available.
  Unknown mobile environments retain manual connections without guessing an app.
- A remembered session offers reconnect before starting another connection.

"Other ways to connect" exposes QR, copy, and bunker entry. QR and copied links
carry the same client-initiated request; a bunker link starts from the signer.
There is no generic same-phone `nostrconnect:` launch button on iPhone and no
named Primal recommendation there. Intentional manual connections remain
interoperable with any compatible signer; the protocol does not attest app brands.

## Preparation and cancellation

The visible mobile panel prepares one request on its initial eligible mount.
Preparation is suppressed during restoration or another operation, for a remembered
session, or while an error or existing request is present. The ready link remains
a native anchor so the user's tap can open the app without an asynchronous redirect.
Preparing a URI does not prove the signer is installed or the relay is ready.

The panel owns its generated and pasted-bunker attempts. Closing it, canceling,
changing to bunker entry, or choosing another Android app cancels owned work.
StrictMode cleanup and late promise settlement cannot cancel a replacement
attempt. Authentication state confirms success: a canceled core promise may
resolve and must not close a reopened dialog.

"Open again" reuses the current pending connection. Expiration or cancellation
requires an explicit new attempt; no automatic retry loop or persisted pending
credentials are introduced. Existing timeout, identity checks, encrypted session
storage, authentication locks, and revocation rules remain in `@conduit/core`.
The installed NIP-46 implementation listens for live responses; background
suspension can still miss an approval. Do not describe reopening alone as proven
recovery from a lost response.

Primal Android's connection screen requires an account whose key it holds.
Watch-only and external-signer accounts should use the app that holds their keys.
The UI never asks users to transfer private keys. Browser app-opening settings
and missing apps have copy/manual/install recovery; there is no install detection.

## Evidence and required QA

Automated coverage checks platform selection, handoff construction, touch targets,
manual options, cancellation, StrictMode, and delayed settlement. App launches are
intercepted. These checks cannot prove actual signer approval, universal-link
association, Android intent resolution, or OS suspension/return behavior.

Run the signer cases in [the mobile QA baseline](mobile-safari-qa-baseline.md) on
physical iPhone/Safari with Clave and Android/Chrome with Amber and Primal.
Include both Android apps installed, missing apps, rejection, timeout, reopening,
account eligibility, and refresh after success. Keep connection values and QR
codes out of screenshots, traces, logs, and telemetry.

## Public references

- [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [Clave integration guidance](https://github.com/DocNR/clave-casa/blob/main/docs/integrations.md)
- [Android browser intents](https://developer.chrome.com/docs/android/intents)
- [Amber Android manifest](https://github.com/greenart7c3/Amber/blob/cb065a3c2210e914d352c6a0f041c6db1e93145d/app/src/free/AndroidManifest.xml)
- [Primal account eligibility](https://github.com/PrimalHQ/primal-android-app/blob/3.5.27/app/src/main/kotlin/net/primal/android/nostrconnect/connect/NostrConnectViewModel.kt)
