# Runtime dependency cycle guard

Run `bun run cycles:check` before and after moving first-party modules. CI runs
the same command before the retained test suite.

The guard uses pinned dependency-cruiser with the supported TypeScript compiler
to inspect all workspace packages under `packages/` and `apps/`, discovered from their package manifests. Each project is resolved with its
own tsconfig and `@/` source alias. The workspace `@conduit/core` and
`@conduit/ui` names resolve to their source directories, matching application
builds rather than requiring existing package `dist` output. Unresolved internal
code imports fail the check instead of silently disappearing from the graph.
External dependencies are not traversed. Known CSS/image assets are not treated
as unresolved code. Literal dynamic imports participate conservatively; computed
dynamic imports cannot be enumerated by this static graph.

TypeScript-erased edges do not form runtime cycles. A separate source check still
rejects Core importing its own package name, including type-only imports. The
root TypeScript override keeps dependency-cruiser's parser on supported 6.0.3;
the native typecheck compiler remains independently pinned through
`@typescript/native`. The guard refuses to run without a supported TypeScript
transpiler, because loose JavaScript parsing can misclassify type-only edges.

`scripts/ci/dependency_cycle_baseline.json` records temporary existing cycles and
self-imports while the cleanup is delivered. Every runtime strongly connected
component includes its exact members and internal edges. A new edge inside an
existing component is therefore a regression, not an allowed extension. Removed
or changed components also require an explicit baseline reduction in the same
reviewed change. The completed cleanup should leave both baseline arrays empty.

For a private graph report, run `bun run cycles:check --report <output-path>`.
This writes the current graph without updating or accepting the baseline. Do not
automatically regenerate exceptions to make CI green. Tests cover alias and
dynamic runtime cycles, type-only cycles, unresolved internal imports, cycle
growth, obsolete exceptions and static/dynamic/type Core self-imports.

This guard addresses module loading dependencies. It does not establish package
publishability, independently deployable application releases, runtime relay
behavior or payment settlement.
