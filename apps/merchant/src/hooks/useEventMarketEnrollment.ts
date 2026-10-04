import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  getAccountSigner,
  PrivateMessageRelayReadinessError,
  loadEventMarketEnrollmentDelivery,
  publishEventMarketEnrollment,
  readEventMarketEnrollment,
  retryEventMarketEnrollmentDelivery,
  useAuth,
  type EventMarketEnrollmentPayload,
  type EventMarketEnrollmentDelivery,
} from "@conduit/core"

export function useEventMarketEnrollment(
  marketCoordinate: string,
  authenticatedPubkey: string | null
) {
  const { authGeneration, isAuthGenerationCurrent } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [networkRepair, setNetworkRepair] = useState(false)
  const [revision, setRevision] = useState(0)
  const query = useQuery({
    queryKey: [
      "event-enrollment",
      marketCoordinate,
      authenticatedPubkey,
      authGeneration,
      revision,
    ],
    queryFn: () =>
      readEventMarketEnrollment({
        accountPubkey: authenticatedPubkey!,
        marketCoordinate,
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
      }),
    enabled: !!authenticatedPubkey && !!marketCoordinate,
    retry: false,
  })
  let pending: EventMarketEnrollmentDelivery | null = null
  let storageError = ""
  try {
    pending =
      authenticatedPubkey && marketCoordinate
        ? loadEventMarketEnrollmentDelivery(
            authenticatedPubkey,
            marketCoordinate
          )
        : null
  } catch (cause) {
    storageError =
      cause instanceof Error
        ? cause.message
        : "Participation recovery is unavailable."
  }
  async function send(
    action: EventMarketEnrollmentPayload["action"],
    merchantPubkey: string
  ) {
    if (!authenticatedPubkey || busy) return
    setBusy(true)
    setError("")
    setNetworkRepair(false)
    try {
      const signer = getAccountSigner()
      if (!signer)
        throw new Error("Connect your signer before sending participation.")
      await publishEventMarketEnrollment({
        payload: {
          version: 1,
          action,
          marketCoordinate,
          organizerPubkey: marketCoordinate.split(":")[1]!,
          merchantPubkey,
          createdAt: Math.max(
            Math.floor(Date.now() / 1000),
            (query.data?.states.find(
              (state) => state.merchantPubkey === merchantPubkey
            )?.latest.createdAt ?? 0) + 1
          ),
        },
        authenticatedPubkey,
        signer,
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
      })
      await query.refetch()
    } catch (cause) {
      setNetworkRepair(
        cause instanceof PrivateMessageRelayReadinessError &&
          (cause.reason === "sender_not_ready" ||
            cause.reason === "recipient_relays_excluded")
      )
      setError(
        cause instanceof PrivateMessageRelayReadinessError
          ? cause.reason === "sender_not_ready"
            ? "Configure your private inbox in Network settings before sending participation."
            : cause.reason === "recipient_relays_excluded"
              ? "The recipient’s inbox relays are excluded by your Network settings. Review the settings, then retry."
              : cause.reason === "recipient_lookup_failed"
                ? "The recipient’s private inbox could not be checked. Refresh and retry; this does not prove their setup is missing."
                : action === "request" || action === "withdraw"
                  ? "The host has not configured a private inbox for participation messages."
                  : "This merchant has not configured a private inbox for participation messages."
          : cause instanceof Error
            ? cause.message
            : "Participation could not be sent."
      )
    } finally {
      setRevision((value) => value + 1)
      setBusy(false)
    }
  }
  async function retry() {
    if (!pending || !authenticatedPubkey || busy) return
    setBusy(true)
    setError("")
    setNetworkRepair(false)
    try {
      await retryEventMarketEnrollmentDelivery({
        record: pending,
        authenticatedPubkey,
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
      })
      await query.refetch()
    } catch (cause) {
      setNetworkRepair(
        cause instanceof PrivateMessageRelayReadinessError &&
          (cause.reason === "sender_not_ready" ||
            cause.reason === "recipient_relays_excluded")
      )
      setError(
        cause instanceof Error
          ? cause.message
          : "Saved participation still needs delivery."
      )
    } finally {
      setRevision((value) => value + 1)
      setBusy(false)
    }
  }
  return {
    query,
    pending,
    busy,
    error: error || storageError,
    networkRepair,
    storageError,
    send,
    retry,
  }
}
