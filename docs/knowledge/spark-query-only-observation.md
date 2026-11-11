# Query-only Spark observation compatibility

Merchant's observation adapter permits exactly SDK `0.14.0`, matching the managed
application dependency. A package upgrade must not silently bypass this audit:
unsupported versions remain unavailable before SDK loading. The ordinary recovery
wallet and its initialization are not fallbacks for observation.

The installed SDK source audit covers `SparkWallet`'s constructor, public-method
wrappers, identity getter, the exact transfer/Lightning request getters, and
cleanup. The constructor assembles configuration and service objects; it does not
invoke `initialize`, `initWallet`, leaf initialization, transfer claiming, or the
optimization loops. Connection, leaf, token-output and time-sync constructors
likewise construct local state. Initialization is a separate entry point.
The selected history methods query existing transfer/request identifiers; they
do not prepare or send another payment. Cleanup closes resources.

The adapter retains its restricted authentication signer, expected-identity check,
disabled logging/automatic optimization, bounded caller authority, closed-session
guard and narrow frozen query capability. It exposes neither initialization nor
payment methods. Do not replace it with a general wallet instance.

`tests/checkout-spark-observation-compatibility.test.ts` exercises the actual
installed browser SDK constructor, identity lookup and cleanup using a synthetic
identity with HTTP/WebSocket attempts blocked and `initialize` forbidden. It also
checks closed-session refusal and unsupported-version rejection before SDK loading.
These offline checks do not exercise live SSP/operator responses or establish
settlement. They supplement the source audit, not replace it.

An unavailable or empty exact-history result never proves that an uncertain
submitted payment was not sent. Restoring observation compatibility grants no
authority to retry payouts, claim funds, or initialize a recovery wallet.
