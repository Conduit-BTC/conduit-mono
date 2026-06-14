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
- If no findings, state: "No blocking findings." and list residual risks.

Conduit constraints to enforce:

- External signer auth only (NIP-07/NIP-46)
- No key custody
- No message content inspection
- No behavioral tracking/profiling
- Payments are non-custodial Lightning payment request/proof flows
- No Zustand/Jotai/Redux state model
- Nostr-sensitive work must cite `docs/knowledge/external-nostr-references.md` and the relevant public NIP or GammaMarkets `market-spec`
- Product listings are NIP-99 + GammaMarkets `kind:30402`; alternate product-listing protocol assumptions are out of scope
- NIP-17/private-message work must preserve NIP-59 seal/gift-wrap behavior, NIP-44 v2 compatibility, and source-gate any future encryption version
- Relay work must distinguish NIP-65 `kind:10002` general relay preferences from NIP-17 `kind:10050` private-message relay hints
- New route-local NDK event construction, `giftWrap`, publish, unwrap/decrypt, relay planning, or event parsing needs explicit justification; prefer `@conduit/core`

Validation expectations:

- `bun run typecheck`
- `bun run lint`
- `bun test`
- `bun run build` when shared packages, routing, env/config, or build output are affected
- `bun run telemetry:check` when telemetry/analytics surfaces are touched
- `bun run test:e2e` when end-to-end smoke behavior is affected
