import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  getNdk,
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
    try {
      const signer = getNdk().signer
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
      setError(
        cause instanceof PrivateMessageRelayReadinessError
          ? cause.reason === "sender_not_ready"
            ? "Set up your event messages before sending participation."
            : cause.reason === "recipient_relays_excluded"
              ? "The recipient’s inbox relays are excluded by your Network settings. Review event messages, then retry."
              : cause.reason === "recipient_lookup_failed"
                ? "The recipient’s private inbox could not be checked. Refresh and retry; this does not prove their setup is missing."
                : action === "request" || action === "withdraw"
                  ? "The host’s private inbox is not ready to receive participation. The host must set up event messages; then refresh and retry."
                  : "This merchant’s private inbox is not ready. They must set up event messages; then refresh and retry."
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
    try {
      await retryEventMarketEnrollmentDelivery({
        record: pending,
        authenticatedPubkey,
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
      })
      await query.refetch()
    } catch (cause) {
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
    storageError,
    send,
    retry,
  }
}
