## Preview Settings

<!-- preview:show-commit-links-cloudflare -->

- [ ] Show commit-level mainnet preview links (Cloudflare creates deployments automatically)

## Summary

<!-- What changed and why? Include user/business impact. -->

## Planning and Public Context

- Implementation plan prepared: <!-- Internal agents post the plan to Linear, but do not link or copy private tracker context here. -->
- Existing public context checked:
- Public context delta: <!-- `None` or list public-safe docs changed with the implementation. A new spec is not required by default. -->

## Implementation

-

## PR Checks

- [ ] PR title uses Conventional Commits (`type(scope): description`)
- [ ] Non-trivial work has a concise implementation and validation plan
- [ ] Public implementation context is listed above; useful public-safe knowledge notes are included when needed

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
- [ ] Relevant existing repo context and public protocol sources are listed above
- [ ] Product listings remain NIP-99 + GammaMarkets `kind:30402`; no alternate product-listing protocol terminology, schemas, or assumptions introduced
- [ ] Relay/source assumptions are stated, including NIP-65 `kind:10002`, NIP-17 `kind:10050`, cache, fallback, stale, or degraded-state behavior when relevant
- [ ] NIP-44 v3 work cites public draft/client references, keeps v2 fallback, and gates behavior on explicit signer/recipient capability detection
- [ ] New protocol construction, `giftWrap`, publish, unwrap/decrypt, relay planning, or event parsing lives in `@conduit/core`, or the PR explains why route-local code is unavoidable
- [ ] Diagnostics/logs/telemetry remain content-free: no plaintext, ciphertext, invoices, order contents, addresses, signer secrets, NWC URIs, or message bodies

## Public Context Review

Reviewer decision:

- [ ] Public context updated in this PR
- [ ] No public context update needed
- [ ] Durable contract or external decision needed

Reviewer note:

<!-- Do not require spec churn by default. Request durable contract work only when the behavior genuinely needs stable public agreement. -->

## Test Plan

- [ ] `bun run format:check` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] `bun run build` passes, or build is not required for this change
- [ ] `bun run telemetry:check` passes, or telemetry is not affected
- [ ] Selected Market/Merchant E2E smoke shards pass, or browser smoke coverage is not affected
- [ ] Tested locally with mock Lightning
- [ ] Verified on preview deploy (if applicable)

## Review Focus

<!-- Optional: areas where reviewers should focus first -->

## Screenshots / Logs

<!-- Include before/after screenshots for UI changes and logs for protocol/reliability fixes -->
