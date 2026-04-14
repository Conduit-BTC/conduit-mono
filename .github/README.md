# GitHub Workflows

## NIP-89 Handler Publishing

The `publish-nip89-handlers.yml` workflow is manual on purpose.

Do not run it until both of these are set:

- public repo or environment variables:
  - `VITE_NIP89_MARKET_PUBKEY`
  - `VITE_NIP89_MERCHANT_PUBKEY`
- matching GitHub Actions secrets:
  - `NIP89_MARKET_NSEC`
  - `NIP89_MERCHANT_NSEC`

The public pubkeys are safe to store as GitHub vars or normal runtime config.

The private keys must stay in your secret manager and GitHub Actions secrets only. They should never be committed to the repo or added to frontend runtime env.

If the public keys are not configured yet, the Conduit apps still run normally. They simply skip attaching NIP-89 `client` tags until valid handler metadata is available.
