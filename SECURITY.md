# Security Policy

## Supported Scope

This repository contains the public client applications and shared packages for
Conduit: Market, Merchant, Store Builder, `@conduit/core`, and `@conduit/ui`.

Security reports should focus on vulnerabilities in this public codebase,
including protocol handling, signer interactions, payment-adjacent client flows,
privacy-sensitive data handling, dependency integrity, and build provenance.

Private infrastructure, credentials, customer data, operational runbooks, and
non-public services are outside this repository and must not be included in
public issues or pull requests.

## Reporting A Vulnerability

Use GitHub's private vulnerability reporting flow for this repository when it is
available. If private reporting is not available, open a minimal public issue
requesting a private disclosure channel and do not include exploit details,
secrets, private keys, NWC connection strings, invoices, order contents,
messages, addresses, or customer data.

Please include:

- The affected app, package, route, or workflow.
- A concise impact statement.
- Reproduction steps using public-safe test data.
- Affected versions or commit SHAs when known.
- Whether the issue is already being exploited, if known.

Do not include:

- Nostr private keys, nsecs, signer pairing codes, NWC URIs, wallet credentials,
  API tokens, cookies, or session material.
- Real order, payment, shipping, address, or message contents.
- Private infrastructure URLs, dashboards, logs, or internal runbooks.

## Dependency And Supply-Chain Reports

Reports about compromised, malicious, typosquatted, or vulnerable dependencies
are in scope. Include the package name, version, advisory or evidence link, and
the lockfile or manifest path involved.

Routine dependency version bumps should use normal pull requests and keep
updates narrowly scoped so CI and review can evaluate each risk class.
