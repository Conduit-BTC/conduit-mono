import {
  commerceRelayExecutor,
  type CommerceRelayExecutor,
} from "../protocol/relay-executor"
import { filterEligibleAccountRelayTargets } from "../protocol/account-network-local-state"
import { getProtectedReadAuthorization } from "../protocol/protected-read-authorization"
import {
  SparkRecoveryError,
  SPARK_RECOVERY_KIND,
} from "./spark-recovery-contract"
import { type SparkRecoveryTransport } from "./spark-recovery-service"

/** Uses the existing bounded reader. Relay auth failures stay unavailable, never absence. */
export function createSparkRecoveryReader(
  executor: CommerceRelayExecutor = commerceRelayExecutor
): SparkRecoveryTransport["read"] {
  return async (url, owner, eventId, shouldContinue) => {
    if (!shouldContinue()) throw new SparkRecoveryError("transport_unavailable")
    const targets = [
      {
        url,
        grants: [{ kind: "public_hint" as const, operation: "read" as const }],
      },
    ]
    const admit = async () =>
      shouldContinue() &&
      (
        await filterEligibleAccountRelayTargets({
          accountPubkey: owner,
          authenticatedPubkey: owner,
          targets,
          operation: "read",
        })
      ).some((target) => target.url === url)
    const authorization = getProtectedReadAuthorization(owner)
    if (!authorization || !(await admit()))
      return { status: "unavailable", events: [] }
    const result = await executor.query(
      {
        operation: "account_recovery_read",
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
        authorization,
        admitRelay: admit,
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
