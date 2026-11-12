# Checkout Spark settlement module ownership

Settlement records and execution have separate runtime dependencies. The original
module paths retain direct reexports of moved public functions and types, so
callers receive the same function bindings through either path.

| Owner                                         | Responsibility                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `checkout-spark-settled-validation.ts`        | Internal plan/router validation primitives, with their original limits and errors.                           |
| `checkout-spark-treasury-model.ts`            | Native invoice identity, immutable treasury records, exact-state accounting and finalization validation.     |
| `checkout-spark-settled-plan.ts`              | Frozen v3/v4/v5 terms, full plan restoration and generation-specific transfer identities.                    |
| `checkout-spark-settled-outgoing-history.ts`  | Exact outgoing request validation, provider observations and paid/preimage classification.                   |
| `checkout-spark-merchant-settlement-model.ts` | Merchant record creation, restoration, native collection facts and settlement projection.                    |
| Existing router and execution modules         | State progression, provider workflows, cancellation authority, recipient attribution and merchant mutations. |

Internal consumers import the owning module directly. Model modules use type-only
imports for reconciliation shapes; they do not import the runtime execution
modules. Validation primitives are not reexported through the existing public
facades or protocol barrel.

Transfer identity derivation still restores the complete plan before deriving an
ID. Native budget derivation in the execution module still restores both the
reconciliation and merchant record and verifies paid recipient attribution. The
router validates credit, legs, historical and current debits, and timestamps
before restoring treasury finalization, then checks the native mirror.

Returned-proof WeakMaps and outgoing/native cancellation registries remain in
their original owners. Copies and serialized forms do not acquire authority.
The extraction does not change persistence versions, invoice formats, provider
retry rules, signature admission or protocol emission.

`tests/checkout-spark-settlement-model-characterization.test.ts` covers fixed
v3/v4/v5 identity vectors, historical v3 restoration, signed invoice validation,
returned proof identity and renewal ancestry, paid/preimage classification, native
accounting, recipient attribution and organizer-only v5 records. Its funding
invoice fixture retains a signed test invoice, never the disposable signing key.

`tests/checkout-spark-settlement-cold-import.test.ts` starts a fresh Bun process
for each original entrypoint and each new owner. Each process blocks network
initialization, verifies same-binding compatibility exports, and exercises
constructors, restoration, accounting and returned proofs. These tests supplement
the retained outgoing, completion, native-provider and preparation-recovery
suites. All evidence is offline; it does not establish funded provider settlement.
