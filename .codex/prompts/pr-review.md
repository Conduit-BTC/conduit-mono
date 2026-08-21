You are reviewing a PR in the Conduit monorepo.

Review order:

1. Bugs/regressions (functional behavior)
2. Protocol and security constraints
3. Privacy and policy constraints
4. Reliability/failure modes
5. Test coverage gaps

Output format:

- Findings first, sorted by severity (`P0`, `P1`, `P2`)
- For each finding include:
  - Impact
  - Evidence (file + line)
  - Suggested fix
- Then include a reviewer context decision:
  - `No docs follow-up needed`
  - `Docs-only PR after merge`
  - `Docs/spec PR required before merge`
- If no findings, state: "No blocking findings." and list residual risks.

Conduit constraints to enforce:

- External signer auth only (NIP-07/NIP-46)
- No Nostr account-key or operator wallet custody; any client-side Portable
  Wallet credential handling must remain inside `docs/specs/wallets.md`
- No message content inspection
- No behavioral tracking/profiling
- Payments are non-custodial Lightning payment request/proof flows
- No Zustand/Jotai/Redux state model
- Nostr-sensitive work must cite `docs/knowledge/external-nostr-references.md` and the relevant public NIP or Open Markets working specification source
- Product listings are NIP-99 plus the Open Markets working specification for `kind:30402` commerce events, derived from the earlier GammaMarkets `market-spec` work; alternate product-listing protocol assumptions are out of scope
- NIP-17/private-message work must preserve NIP-59 seal/gift-wrap behavior, NIP-44 v2 compatibility, and source-gate NIP-44 v3 implementation behind public draft/client references and capability detection
- Relay work must distinguish NIP-65 `kind:10002` general relay preferences from NIP-17 `kind:10050` private-message relay hints
- New route-local NDK event construction, `giftWrap`, publish, unwrap/decrypt, relay planning, or event parsing needs explicit justification; prefer `@conduit/core`
- Reviewer owns docs/context follow-up decisions. Agents may suggest docs drift, but follow-up docs-only PRs are opened separately only when a reviewer or maintainer asks.

Validation expectations:

- `bun run typecheck`
- `bun run lint`
- `bun test`
- `bun run build` when shared packages, routing, env/config, or build output are affected
- `bun run telemetry:check` when telemetry/analytics surfaces are touched
- `bun run test:e2e` when end-to-end smoke behavior is affected
