import {
  commerceRelayExecutor,
  type CommerceRelayExecutor,
} from "../protocol/relay-executor"
import { filterEligibleAccountRelayUrls } from "../protocol/account-network-local-state"
import {
  SparkRecoveryError,
  SPARK_RECOVERY_KIND,
} from "./spark-recovery-contract"
import {
  SPARK_RECOVERY_RENDEZVOUS,
  type SparkRecoveryTransport,
} from "./spark-recovery-service"

/** Uses the existing bounded reader. Relay auth failures stay unavailable, never absence. */
export function createSparkRecoveryReader(
  executor: CommerceRelayExecutor = commerceRelayExecutor
): SparkRecoveryTransport["read"] {
  return async (url, owner, eventId, shouldContinue) => {
    if (!shouldContinue()) throw new SparkRecoveryError("transport_unavailable")
    const rendezvous = SPARK_RECOVERY_RENDEZVOUS.some((r) => r.url === url)
    const eligible = await filterEligibleAccountRelayUrls({
      accountPubkey: owner,
      authenticatedPubkey: owner,
      candidateRelayUrls: [url],
      independentRelayUrls: rendezvous ? [url] : [],
      personalRelayUrls: rendezvous ? [] : [url],
    })
    if (!shouldContinue() || !eligible.includes(url))
      return { status: "unavailable", events: [] }
    const result = await executor.query(
      {
        operation: "public_read",
        relayUrls: [url],
        filters: [
          {
            authors: [owner],
            kinds: [SPARK_RECOVERY_KIND],
            ...(eventId ? { ids: [eventId] } : {}),
            limit: 128,
          },
        ],
      },
      {
        connectTimeoutMs: 4000,
        queryTimeoutMs: 6000,
        maxEventsPerRelay: 128,
        maxBytesPerRelay: 1024 * 1024,
      }
    )
    if (!shouldContinue()) throw new SparkRecoveryError("transport_unavailable")
    const source = result.relays[0]
    const complete =
      result.status === "success" &&
      source?.status === "success" &&
      source.malformedCount === 0 &&
      source.unusableCount === 0 &&
      result.events.length < 128
    return {
      status: complete
        ? "complete"
        : result.events.length || result.status === "partial"
          ? "partial"
          : "unavailable",
      events: result.events,
    }
  }
}
