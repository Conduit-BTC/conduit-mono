# Security Policy

## Supported Versions And Scope

Security fixes are developed against the current `main` branch and current
Conduit-hosted deployments. When reporting a deployed issue, include the app URL
and the build commit shown on its About page when available. Older commits,
third-party forks, and modified deployments are not guaranteed to receive
security updates.

This repository contains Conduit's public client applications, API functions,
shared packages, repository automation, and build configuration. Reports are in
scope when they affect this public codebase or deployed behavior attributable to
it, including:

- Nostr event, relay, signer, and identity handling.
- Lightning and payment-adjacent client flows.
- Privacy-sensitive data handling in Market, Merchant, and Store Builder.
- Deployable code in `apps/`, including `@conduit/anon-zap-signer` and
  `@conduit/posthog-proxy`.
- `functions/api`, `@conduit/core`, and `@conduit/ui`.
- Dependency integrity, GitHub Actions, build provenance, and release inputs.

Private infrastructure, credentials, customer data, operational runbooks, and
non-public services are outside this repository. Do not include information
about them in public issues or pull requests.

## Reporting A Vulnerability

Use one of these private channels:

1. [Open a private GitHub vulnerability report](https://github.com/Conduit-BTC/conduit-mono/security/advisories/new).
2. If GitHub private reporting is unavailable, email
   `contact@conduitbtc.com` with a subject beginning `Security report:`.

Do not open a public issue or pull request containing vulnerability details. If
neither private channel works, open a minimal public issue asking maintainers to
establish contact, without including technical details.

Please include:

- The affected app, package, function, route, workflow, or deployment.
- A concise impact statement and the attacker's required preconditions.
- Reproduction steps or a minimal proof of concept using public-safe test data.
- The affected commit SHA, build commit, or version when known.
- Whether the issue is already being exploited, if known.
- Whether you want public credit if an advisory is published.

Automated and model-assisted reports are welcome, but raw scanner or model
output is not sufficient by itself. Include the relevant code path, explain why
existing checks do not prevent the issue, and reproduce the behavior when it is
safe to do so.

Do not include:

- Nostr private keys, nsecs, signer pairing codes, NWC URIs, wallet credentials,
  API tokens, cookies, or session material.
- Real order, payment, shipping, address, or message contents.
- Private infrastructure URLs, dashboards, logs, or internal runbooks.

## Safe Testing

- Use local relays, mock Lightning flows, test networks, and accounts or data you
  control whenever possible.
- Do not move mainnet funds, publish harmful events to public relays, access
  another person's account or data, degrade availability, send spam, or use
  social engineering.
- Stop testing and report immediately if you encounter credentials, private
  messages, personal data, wallet connection material, or the ability to sign or
  pay without the user's informed approval.
- Coordinate public disclosure with the maintainers so users have a reasonable
  opportunity to receive a fix. Severity and disclosure timing are determined
  after validation.

Submitting a report does not create an entitlement to payment unless Conduit
has agreed to a reward in writing.

## Dependency And Supply-Chain Reports

Reports about compromised, malicious, typosquatted, or vulnerable dependencies
are in scope. Include the package name, version, advisory or evidence link, and
the lockfile or manifest path involved.

Routine dependency version bumps should use normal pull requests and remain
narrowly scoped so CI and review can evaluate each risk class.
