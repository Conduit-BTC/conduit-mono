# Runtime dependency cycle guard

Run `bun run cycles:check` before and after moving first-party modules. CI runs
the same command before the retained test suite.

The guard uses pinned dependency-cruiser with the supported TypeScript compiler
to inspect all workspace packages under `packages/` and `apps/`, discovered from their package manifests. Each project is resolved with its
own tsconfig and `@/` source alias. The workspace `@conduit/core` and
`@conduit/ui` names resolve to their source directories, matching application
builds rather than requiring existing package `dist` output. Unresolved internal
code imports fail the check instead of silently disappearing from the graph.
Workspace package names are resolved from their manifests. Unknown unresolved
specifiers fail unless they name a declared external package, builtin, known Vite
virtual module or asset. Each project must contribute source modules, and the
Core entrypoint must be present. External dependencies are not traversed. Known CSS/image assets are not treated
as unresolved code. Literal dynamic imports participate conservatively; computed
dynamic imports cannot be enumerated by this static graph. TypeScript import
assignments erased by ES module compilation are not runtime edges. Worker URL
entrypoints run in a separate module realm and are not loading-cycle edges.

TypeScript-erased edges do not form runtime cycles. A separate source check still
rejects Core importing its own package name, including type-only imports. The
root TypeScript override keeps dependency-cruiser's parser on supported 6.0.3.
The existing isolated install layout is retained; disabling its phantom fallback
hoist keeps the optional compiler on that root pin instead of the aliased native
compiler. The native typecheck compiler remains independently pinned through
`@typescript/native`. The guard refuses to run without a supported TypeScript
transpiler, because loose JavaScript parsing can misclassify type-only edges.

`scripts/ci/dependency_cycle_baseline.json` has no exceptions: both arrays are
empty after the runtime cleanup. Any runtime cycle or Core self-import fails CI.
During a staged cleanup, exceptions identify exact strongly connected component
members and internal edges; adding an edge is not an allowed extension. Removed
or changed components require an explicit baseline reduction in the same reviewed
change.

For a private graph report, run `bun run cycles:check --report <output-path>`.
This writes the current graph without updating or accepting the baseline; a report
path resolving to the baseline is rejected before graph collection. Do not
automatically regenerate exceptions to make CI green. Tests cover alias and
dynamic runtime cycles, type-only cycles, unresolved internal imports, cycle
growth, obsolete exceptions and static/dynamic/type Core self-imports.

This guard addresses module loading dependencies. It does not establish package
publishability, independently deployable application releases, runtime relay
behavior or payment settlement.

The cleanup keeps implementation ownership below compatibility facades:

- Core modules use direct owner imports, and UI components import sibling
  components directly instead of their package barrel.
- `profile-cache.ts` owns the admitted profile parser; `profiles.ts` retains its
  existing public binding.
- Relay-read provenance has one WeakMap in `relay-read-provenance.ts`. Retained
  owner-list and inbox declaration evidence live in
  `owner-relay-list-evidence-store.ts` and
  `private-message-retained-evidence.ts`; transport and publishing stay in their
  original modules, with compatibility reexports for existing callers. These
  moves preserve the same caches, authorization checks and persistence behavior.
- [Commerce planning](commerce-relay-planning.md),
  [shipping schemas](shipping-schema-ownership.md) and
  [settlement models](checkout-spark-settlement-module-ownership.md) document the
  remaining dependency boundaries and their offline characterization checks.
