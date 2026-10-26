import {
  commerceRelayExecutor,
  type CommerceRelayExecutor,
} from "../protocol/relay-executor"
import {
  filterEligibleAccountRelayTargets,
  type AccountNetworkLocalStateRepository,
} from "../protocol/account-network-local-state"
import { getProtectedReadAuthorization } from "../protocol/protected-read-authorization"
import {
  PORTABLE_WALLET_KIND,
  PORTABLE_WALLET_TAG,
} from "./portable-wallet-record"
import type { WalletRecordTransport } from "./portable-wallet-transport"
import { accountStorageRelayTargets } from "../protocol/account-storage-relay-policy"

/** Uses the existing bounded reader. Relay auth failures stay unavailable, never absence. */
export function createPortableWalletReader(
  executor: CommerceRelayExecutor = commerceRelayExecutor,
  accountNetworkRepository?: Pick<AccountNetworkLocalStateRepository, "get">
): WalletRecordTransport["read"] {
  return async (url, owner, eventId, shouldContinue) => {
    if (!shouldContinue()) throw new Error("Wallet connection changed.")
    const targets = accountStorageRelayTargets("read").filter(
      (target) => target.url === url
    )
    const admit = async () =>
      shouldContinue() &&
      (
        await filterEligibleAccountRelayTargets({
          accountPubkey: owner,
          authenticatedPubkey: owner,
          targets,
          operation: "read",
          repository: accountNetworkRepository,
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
            kinds: [PORTABLE_WALLET_KIND],
            ...(eventId ? { ids: [eventId] } : {}),
            "#t": [PORTABLE_WALLET_TAG],
            limit: eventId ? 1 : 128,
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
    if (!shouldContinue()) throw new Error("Wallet connection changed.")
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
