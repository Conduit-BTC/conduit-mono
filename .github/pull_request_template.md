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

## Acceptance Criteria and Evidence

<!--
Use stable IDs. Include success, failure, and regression-sensitive outcomes.
Every criterion needs evidence or an explicit gap. Generic CI checkboxes are
not behavioral evidence.
-->

| ID   | Observable criterion | Evidence / test | Environment and signer fidelity | Current-head result | Gap / owner |
| ---- | -------------------- | --------------- | ------------------------------- | ------------------- | ----------- |
| AC-1 |                      |                 |                                 |                     |             |

## Smoke and Playwright Coverage

- Critical flows changed:
- Playwright or smoke tests added or updated:
- Existing coverage relied on:
- Manual-only criteria:
- If no browser smoke changed, why:

## PR Checks

- [ ] PR title uses Conventional Commits (`type(scope): description`)
- [ ] Non-trivial work has a concise implementation and validation plan
- [ ] Public implementation context is listed above; useful public-safe knowledge notes are included when needed

## Scope

- App/Package:
- Layer: `UX` | `Protocol/App Logic` | `Infra/Relay` | `Docs/Policy` | `Support`

## Review and QA Disposition

Author proposal. Select one:

- [ ] Evidence sign-off: human code review is required; no separate product QA
- [ ] Targeted human QA: complete the named manual checks on this candidate
- [ ] Maintainer-owned validation: protocol, auth, payment, privacy, security,
      migration, secret, destructive-state, or release validation is required

- Human code review: Required
- Required manual routes, devices, or signers:
- State-changing actions and cleanup:
- Residual gaps:
- Evidence head SHA:
- Reviewer-confirmed disposition:

## Risk Review

- [ ] User auth remains external signer only (NIP-07/NIP-46)
- [ ] No user Nostr account-key custody introduced; approved application signers
      remain within `docs/specs/protocol.md`, and any Portable Wallet credential
      handling stays inside `docs/specs/wallets.md`
- [ ] No plaintext message content added to telemetry, logs, or Conduit-operated servers
- [ ] No behavioral tracking/profiling introduced
- [ ] Payment flow remains non-custodial
- [ ] Wallet credentials, recovery material, payment content, selected wallet
      instance IDs, and balances remain out of logs and telemetry
- [ ] Portable Wallet sends require explicit fee approval and ambiguous outcomes
      cannot silently retry through another wallet or rail
- [ ] The selected wallet instance remains fixed after a payment attempt starts
- [ ] Shared package dependency boundaries preserved

## Nostr-Sensitive Preflight

Complete this section when the PR touches protocol/app logic, infra/relay behavior, signer auth, messaging, payments, local cache/outbox, product event parsing/emission, or NDK/relay code.

- [ ] `docs/knowledge/external-nostr-references.md` and the relevant public NIP/Open Markets source were checked before implementation
- [ ] Relevant existing repo context and public protocol sources are listed above
- [ ] Product listings remain NIP-99 plus the Open Markets working specification for `kind:30402` commerce events; no alternate product-listing protocol terminology, schemas, or assumptions introduced
- [ ] Relay/source assumptions are stated, including NIP-65 `kind:10002`, NIP-17 `kind:10050`, cache, fallback, stale, or degraded-state behavior when relevant
- [ ] NIP-44 v3 work cites public draft/client references, keeps v2 fallback, and gates behavior on explicit signer/recipient capability detection
- [ ] New protocol construction, `giftWrap`, publish, unwrap/decrypt, relay planning, or event parsing lives in `@conduit/core`, or the PR explains why route-local code is unavoidable
- [ ] Diagnostics/logs/telemetry remain content-free: no plaintext, ciphertext,
      invoices, order contents, addresses, signer secrets, NWC URIs, wallet
      seeds/mnemonics/derived keys, provider credentials, wallet balances, or
      payment/message bodies

## Decentralized Network Product Review

Complete when relay, cache, discovery, capability, interoperability, or
convergence state can block, degrade, retry, or change a user action.

- [ ] `docs/knowledge/decentralized-network-product-posture.md` was checked
- [ ] Requirements are classified as safety/payment, data integrity, discovery/capability, or ecosystem migration
- [ ] Required positive evidence and stronger negative/revocation evidence are stated separately
- [ ] Empty, partial, unavailable, stale, conflicting, malformed, and absent-within-scope states remain distinguishable where the decision depends on them
- [ ] The PR identifies any previously working cohort that becomes blocked and explains why the gate is necessary
- [ ] Partial-network counterexamples cover the user outcome, not only helper return values
- [ ] Any compatibility exception is named, bounded, rollout-controlled, privacy-safe, measurable, repairable, and linked from the active-exception index with an explicit removal gate

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
- [ ] Spark wallet changes were exercised end-to-end on the configured network:
      create, fund, pay, close/reopen, and restore; mainnet QA used deliberately
      small amounts, or Portable Wallet behavior is not affected
- [ ] Tested locally with mock Lightning
- [ ] Verified on preview deploy (if applicable)

## Review Focus

<!-- Optional: areas where reviewers should focus first -->

## Screenshots / Logs

<!-- Include before/after screenshots for UI changes and logs for protocol/reliability fixes -->
