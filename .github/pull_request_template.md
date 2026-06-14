## Preview Settings

<!-- preview:show-commit-links-cloudflare -->

- [ ] Show commit-level mainnet preview links (Cloudflare creates deployments automatically)

## Summary

<!-- What changed and why? Include user/business impact. -->

## Tracking

- Linear issue:
- Workstream:
- Phase: `Phase 2A` | `Phase 2B` | `Support` | `Future`
- Source docs/specs:
- Docs/spec PR:

## PR Checks

- [ ] PR title uses Conventional Commits (`type(scope): description`)
- [ ] Relevant docs/spec PR is already merged to `main`, or this PR is the docs/spec PR

## Scope

- App/Package:
- Layer: `UX` | `Protocol/App Logic` | `Infra/Relay` | `Docs/Policy` | `Support`

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
- [ ] `bun run build` passes, or build is not required for this change
- [ ] `bun run telemetry:check` passes, or telemetry is not affected
- [ ] `bun run test:e2e` passes, or E2E smoke coverage is not affected
- [ ] Tested locally with mock Lightning
- [ ] Verified on preview deploy (if applicable)

## Review Focus

<!-- Optional: areas where reviewers should focus first -->

## Screenshots / Logs

<!-- Include before/after screenshots for UI changes and logs for protocol/reliability fixes -->
