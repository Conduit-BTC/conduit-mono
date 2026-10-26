import { requestEvidence } from "./address-request-record"
import type { PortableWalletRecord } from "./portable-wallet-record"

/** Selection evidence, not live provider approval or receiving availability. */
export function savedWalletAddress(
  record: Pick<
    PortableWalletRecord,
    "lightningAddress" | "addressRequest" | "lifecycle"
  >
): string | null {
  if (record.lifecycle !== "active") return null
  const request = record.addressRequest
  if (request && ["registered", "complete"].includes(request.phase))
    return `${requestEvidence(request).desiredName}@conduit.cash`
  return record.lightningAddress
}
