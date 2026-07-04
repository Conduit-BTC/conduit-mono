## Preview Settings

<!-- preview:show-commit-links-cloudflare -->

- [ ] Show commit-level mainnet preview links (Cloudflare creates deployments automatically)

## Summary

<!-- What changed and why? Include user/business impact. -->

## Tracking

- Tracker issue:
- Workstream:
- Planning context checked: <!-- Check the relevant tracker/Linear context for current workstream or phase; do not copy private planning details into this public PR. -->
- Source docs/specs:
- Docs/spec PR:

## PR Checks

- [ ] PR title uses Conventional Commits (`type(scope): description`)
- [ ] Relevant docs/spec PR is already merged to `main`, or this PR is the docs/spec PR

## Scope

- App/Package:
- Layer: `UX` | `Protocol/App Logic` | `Infra/Relay` | `Docs/Policy` | `Support`

## Risk Review

- [ ] User auth remains external signer only (NIP-07/NIP-46)
- [ ] No key custody introduced outside approved, documented service-signer exceptions
- [ ] No message content inspection introduced
- [ ] No behavioral tracking/profiling introduced
- [ ] Payment flow remains non-custodial
- [ ] Shared package dependency boundaries preserved

## Nostr-Sensitive Preflight

Complete this section when the PR touches protocol/app logic, infra/relay behavior, signer auth, messaging, payments, local cache/outbox, product event parsing/emission, or NDK/relay code.

- [ ] `docs/knowledge/external-nostr-references.md` and the relevant public NIP/GammaMarkets source were checked before implementation
- [ ] `Source docs/specs` lists the relevant repo spec and public protocol source
- [ ] Product listings remain NIP-99 + GammaMarkets `kind:30402`; no alternate product-listing protocol terminology, schemas, or assumptions introduced
- [ ] Relay/source assumptions are stated, including NIP-65 `kind:10002`, NIP-17 `kind:10050`, cache, fallback, stale, or degraded-state behavior when relevant
- [ ] NIP-44 v3 work cites public draft/client references, keeps v2 fallback, and gates behavior on explicit signer/recipient capability detection
- [ ] New protocol construction, `giftWrap`, publish, unwrap/decrypt, relay planning, or event parsing lives in `@conduit/core`, or the PR explains why route-local code is unavoidable
- [ ] Diagnostics/logs/telemetry remain content-free: no plaintext, ciphertext, invoices, order contents, addresses, signer secrets, NWC URIs, or message bodies

## Context Follow-Up

Author notes:

- Potential docs/context follow-up:

Reviewer decision:

- [ ] No docs follow-up needed
- [ ] Docs-only PR after merge
- [ ] Docs/spec PR required before merge

Reviewer note:

<!-- Reviewers own this decision. Agents may suggest possible drift, but docs-only follow-up PRs should be opened separately and reviewed separately. -->

## Changes

-

## Test Plan

- [ ] `bun run format:check` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] `bun run build` passes, or build is not required for this change
- [ ] `bun run telemetry:check` passes, or telemetry is not affected
- [ ] `bun run test:e2e` passes, or E2E smoke coverage is not affected
- [ ] Tested locally with mock Lightning
- [ ] Verified on preview deploy (if applicable)

## Review Focus

<!-- Optional: areas where reviewers should focus first -->

## Screenshots / Logs

<!-- Include before/after screenshots for UI changes and logs for protocol/reliability fixes -->
