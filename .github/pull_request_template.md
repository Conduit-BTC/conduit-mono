## Preview Settings

<!-- preview:show-commit-links-cloudflare -->

- [ ] Show commit preview links (Cloudflare creates deployments automatically)

## Summary

<!-- What changed and why? Include user/business impact. -->

## Tracking

- Linear issue:
- Phase 2 Track: `A` | `B` | `C` | `D` | `E` | `F` | `G` | `H` | `Support`
- Source docs/specs:
- Docs/spec PR:

## PR Checks

- [ ] PR title uses Conventional Commits (`type(scope): description`)
- [ ] Relevant docs/spec PR is already merged to `main`, or this PR is the docs/spec PR

## Scope

- App/Package:
- Layer: `UX` | `Protocol/App Logic` | `Infra/Relay` | `Business/Policy`
- Phase: `P0 Launch Readiness` | `P1 Follow-through` | `Support`

## Risk Review

- [ ] Auth remains external signer only (NIP-07/NIP-46)
- [ ] No key custody introduced
- [ ] No message content inspection introduced
- [ ] No behavioral tracking/profiling introduced
- [ ] Payment flow remains non-custodial
- [ ] Shared package dependency boundaries preserved

## Changes

-

## Test Plan

- [ ] `bun run format:check` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] Tested locally with mock Lightning
- [ ] Verified on preview deploy (if applicable)

## Review Focus

<!-- Optional: areas where reviewers should focus first -->

## Screenshots / Logs

<!-- Include before/after screenshots for UI changes and logs for protocol/reliability fixes -->
