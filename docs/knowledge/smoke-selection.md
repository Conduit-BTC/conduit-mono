# Bounded smoke selection

Required smoke keeps explicit area tags, isolated single-worker runners, zero
retries and exact source/base/tested SHA verification. Pushes to `main`, shared
runtime, helpers and infrastructure retain full coverage. The required
`e2e-smoke` context does not change.

The selector discovers a full Playwright inventory without starting services
only when ownership can narrow coverage. No-op, main pushes and already-full
changes skip dependency installation and discovery in the selection job. Area
tags remain authoritative; titles and an AI classification never select or omit
tests. Every bounded job includes the owning app's not-found and
route/theme/browser surface audits. Browser projects and device settings stay
unchanged. Each requested file must contain tests in the selected area, and
bounded discovery must exactly match that subset of the full project-aware
manifest before execution.

## Ownership exceptions

| Changed source                           | Selected regression group | Areas      |
| ---------------------------------------- | ------------------------- | ---------- |
| Market About route                       | About                     | Market     |
| Merchant About route                     | About                     | Merchant   |
| Contributor snapshot, shared About panel | About                     | Both apps  |
| App Terms or Privacy route               | Product legal             | Owning app |
| Any Playwright test or helper file       | Full existing partitions  | All areas  |

Exact source paths live in `boundedSmokeOwners` in
`scripts/ci/select_smoke_shards.ts`. This small map covers leaf presentation and
content composition; it is not a general dependency graph. Changes to imported
helpers, shared shells, theme owners, auth, protocol, payments or persistence
keep the existing broad affected-area floor. Full selection overrides a bounded
group when a PR mixes both kinds of changes. Renames include both paths;
all test and helper edits use full coverage. Current tags cannot establish a
changed test's former owning areas, runtime or dependencies between files. Even
small test-only edits therefore keep all areas and their existing parallelism.
Commerce remains complete, including isolated router and receiver setup profiles.

Do not extend the map merely because a filename looks app-local. Check callers,
protected behavior and existing browser coverage first, then add a composed
manifest test. The other app server is omitted only for the known app-local
About, Product legal, not-found and surface-audit files; unqualified files retain
both services because some app-tagged wallet tests cross app boundaries.

## Scheduling and evidence

Measured About and legal source scopes run unsharded. Scopes above 150 project
cases fall back to full-area partitions as the inventory grows. This count is a
size guard, not a runtime bound. General test-file edits always keep full-area
partitions in all areas, regardless of case count. Full areas retain the existing
three Market, two Merchant and one Commerce jobs. Build runs independently of
quality checks;
preview verification still requires the validated build and configuration digest.
Every required check must pass independently.

Report selected case counts, setup-inclusive wall time and runner-minutes by
change cohort. A faster selective run is not a full-coverage run or proof of
sustained reliability. Keep first-attempt failures and canceled work visible.
Broad changes may remain slower; do not add runner fanout, weaken coverage or
introduce a dependency framework solely to reach a timing goal. Unit execution
and broader preview scheduling remain independent performance limits.

To roll back narrower selection, omit `--inventory` from the selector invocation.
The existing area selector then restores its full-area floor; required checks,
main coverage and evidence verification remain intact.
