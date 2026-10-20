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
Commerce remains complete, including isolated ordinary native-router, Event
native-router and receiver setup profiles. The Event native profile runs in its
own required parallel job; the existing Commerce job retains ordinary Commerce,
ordinary native routing and receiver setup. Both use independent test state.
The native discovery guard compares their project-aware manifests with the full
native selection and rejects missing or repeated cases before execution. These
are execution partitions within `@commerce`, not new area ownership tags.

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
five Market, four Merchant, one Commerce and one Event-router jobs. Build runs independently of
quality checks;
preview verification still requires the validated build and configuration digest.
Every required check must pass independently.

Report selected case counts, setup-inclusive wall time and runner-minutes by
change cohort. A faster selective run is not a full-coverage run or proof of
sustained reliability. Keep first-attempt failures and canceled work visible.
The Merchant inventory grew to 414 project cases. A three-way partition reached
the existing 20-minute job deadline after 132 of its 138 cases passed, with six
unfinished and no assertion failure. Four Merchant partitions preserve the full
project-aware case multiset while reducing work per job; actual discovery tests
reject missing, repeated or empty partitions. Assertions, retries, browser
projects, worker counts and deadlines remain unchanged.
Broad changes may remain slower; do not weaken coverage or introduce arbitrary
runner fanout or a dependency framework solely to reach a timing goal. The
Market inventory grew to 607 project cases. A four-way partition repeatedly
reached the existing 20-minute job deadline without retaining a complete
execution artifact. Five Market partitions distribute the same full
project-aware case multiset across smaller jobs; actual discovery rejects
missing, repeated or empty partitions. Assertions, retries, browser projects,
worker counts and deadlines remain unchanged. This scheduling change does not
establish the cause of a timeout or replace fresh required runtime evidence. The
bounded Event-router split preserves all native cases while keeping the existing
Commerce job's serial lanes within their unchanged deadline; it does not increase
test deadlines or make a failed lane optional. Unit execution
and broader preview scheduling remain independent performance limits.

To roll back narrower selection, omit `--inventory` from the selector invocation.
The existing area selector then restores its full-area floor; required checks,
main coverage and evidence verification remain intact.
