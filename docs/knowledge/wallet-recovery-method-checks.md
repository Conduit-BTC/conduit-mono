# Wallet recovery-method checks

The shared Wallets surface checks local encrypted recovery metadata before
opening a Spark wallet or displaying its recovery controls. A metadata check
does not decrypt a recovery phrase, contact a signer, open a provider session,
or prove that a relay backup is available.

## Read outcomes

Each metadata observation has a five-second deadline:

- A successful method read enables the existing signer or password controls.
- A successful read returning no method is confirmed local absence. It does not
  prove the absence of an independent recovery bundle or encrypted relay backup.
- A rejected or timed-out read is temporarily unavailable, not missing. Saved
  wallet data remains unchanged.

Unlock and Recovery details offer **Retry recovery check** after unavailable or
missing results. Retry reads metadata again; it never unlocks a wallet or reveals
a phrase automatically. An unavailable Open wallet preflight returns control to
the wallet card so its explicit Open action can be tried again. Its method and
retained-password-fallback reads share one five-second budget.

Each dialog observation belongs to its wallet and read attempt. Retry, close,
wallet replacement and account/session replacement retire previous observations.
Late storage results cannot replace a newer result. Retirement stops observing
the read; it does not claim to cancel an IndexedDB operation.

Wallet-card and removal controls still require their own positive method read.
Retry in Recovery details does not authorize removal or share its result with
those controls; reload the wallet page if a card-level read remains unavailable.

## Authority boundary

The deadline applies only to read-only metadata. Signer approval, password
verification, phrase export, provider opening and payments retain their existing
authority and completion rules. In particular, timing out provider opening would
require separate late-completion/cancellation coordination and is not done here.
Signer-backed recovery, the retained previous-password path, and independent
phrase/account/network backups remain unchanged.

## Regression coverage

`e2e/wallet-recovery-read.playwright.ts` exercises the real shared dialogs and route
controllers with controlled local metadata reads and an unfunded SDK boundary:
stalled reads, rejection versus absence, successful Retry, late results, dialog
and account replacement, ordinary password access, and signer-backed opening
that takes longer than the metadata deadline. These checks do not qualify a live
provider, external signer extension, physical device, relay durability or funds.
