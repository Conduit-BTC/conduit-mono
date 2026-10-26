import type {
  AccountSigner,
  SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { getAccountSigner } from "../protocol/session-signer"
import { getProtectedReadAuthorization } from "../protocol/protected-read-authorization"
import { accountStorageRelayTargets } from "../protocol/account-storage-relay-policy"
import {
  publishWithPlanner,
  getRelayPublishTargetStatus,
  RelayPublishDiagnosticsError,
} from "../protocol/relay-publish"
import { createPortableWalletReader } from "./portable-wallet-read"
export interface WalletRecordTransport {
  read(
    url: string,
    owner: string,
    eventId: string | undefined,
    shouldContinue: () => boolean
  ): Promise<{
    status: "complete" | "partial" | "unavailable"
    events: SignedNostrEvent[]
  }>
  publish(
    url: string,
    event: SignedNostrEvent,
    shouldContinue: () => boolean
  ): Promise<string>
}
export function createAccountWalletTransport(
  signer: AccountSigner
): WalletRecordTransport {
  return {
    read: createPortableWalletReader(),
    async publish(url, event, shouldContinue) {
      if (!shouldContinue()) return "cancelled"
      if (
        !getProtectedReadAuthorization(signer.pubkey) ||
        getAccountSigner() !== signer
      )
        return "auth_required"
      try {
        const result = await publishWithPlanner(event, {
          intent: "author_event",
          authorPubkey: signer.pubkey,
          authenticatedPubkey: signer.pubkey,
          accountPubkey: signer.pubkey,
          exclusiveRelayUrls: [url],
          relayTargets: accountStorageRelayTargets("write").filter(
            (target) => target.url === url
          ),
          deliveryMode: "critical",
          shouldContinue,
          relayAuthentication: {
            expectedPubkey: signer.pubkey,
            signer,
            sessionScope: signer,
          },
        })
        return getRelayPublishTargetStatus(result, url) === "acked"
          ? "acked"
          : "error"
      } catch (error) {
        if (!shouldContinue()) return "cancelled"
        if (error instanceof RelayPublishDiagnosticsError) {
          const status = getRelayPublishTargetStatus(error.diagnostics, url)
          if (
            status === "rejected" ||
            status === "timed_out" ||
            status === "auth_required" ||
            status === "policy_blocked"
          )
            return status
        }
        return "error"
      }
    },
  }
}
