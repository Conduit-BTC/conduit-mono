import { useLayoutEffect, useRef, useState } from "react"
import {
  archiveFutureMarketPrivateDelivery,
  formatEventMarketPickupClaimCode,
  loadFutureMarketPrivateDeliveries,
  retryFutureMarketPrivateDelivery,
  useAuth,
} from "@conduit/core"
import { Button } from "@conduit/ui"

type SavedDelivery = ReturnType<
  typeof loadFutureMarketPrivateDeliveries
>[number]

export function SavedFutureHandoffUpdate({
  record,
  organizerPubkey,
  blocked,
  onUpdated,
}: {
  record: SavedDelivery
  organizerPubkey: string
  blocked: boolean
  onUpdated: () => void
}) {
  const { accountPubkey, authGeneration, isExactDeliveryRetryCurrent } =
    useAuth()
  const authority = useRef<{
    owner: string | null
    generation: number
    blocked: boolean
  } | null>(null)
  useLayoutEffect(() => {
    authority.current = {
      owner: accountPubkey,
      generation: authGeneration,
      blocked,
    }
    return () => {
      authority.current = null
    }
  }, [accountPubkey, authGeneration, blocked])
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")

  async function retry(): Promise<void> {
    if (
      pending ||
      blocked ||
      accountPubkey !== organizerPubkey ||
      !isExactDeliveryRetryCurrent(authGeneration, organizerPubkey)
    )
      return
    const shouldContinue = () =>
      authority.current?.owner === organizerPubkey &&
      authority.current.generation === authGeneration &&
      !authority.current.blocked &&
      isExactDeliveryRetryCurrent(authGeneration, organizerPubkey)
    setPending(true)
    setStatus("")
    setError("")
    try {
      // Revalidate storage at the action boundary; replay only the saved bytes.
      const saved = loadFutureMarketPrivateDeliveries(
        organizerPubkey,
        undefined,
        {
          pendingOnly: true,
        }
      ).find((candidate) => candidate.rumorId === record.rumorId)
      if (!saved || JSON.stringify(saved) !== JSON.stringify(record))
        throw new Error("Saved handoff update changed. Reload before retrying.")
      const result = await retryFutureMarketPrivateDelivery({
        record: saved,
        authenticatedOwnerPubkey: organizerPubkey,
        shouldContinue,
      })
      if (!shouldContinue()) return
      if (result.recipientDelivered && result.selfCopyDelivered)
        archiveFutureMarketPrivateDelivery(organizerPubkey, saved.rumorId)
      setStatus(
        result.recipientDelivered && result.selfCopyDelivered
          ? "Exact handed-out update delivered."
          : "Exact update remains saved for retry."
      )
      onUpdated()
    } catch (cause) {
      if (shouldContinue())
        setError(
          cause instanceof Error ? cause.message : "Exact handoff retry failed."
        )
    } finally {
      setPending(false)
    }
  }

  return (
    <article className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-4">
      <p className="text-sm font-medium">
        Saved handoff update ·{" "}
        {formatEventMarketPickupClaimCode(record.claimRef)}
      </p>
      <p className="text-sm text-[var(--text-secondary)]">
        Retry delivery of a handoff already confirmed on this device. This does
        not authorize another physical release. Saved updates may be from other
        markets managed by this organizer.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={
          pending ||
          blocked ||
          accountPubkey !== organizerPubkey ||
          !isExactDeliveryRetryCurrent(authGeneration, organizerPubkey)
        }
        onClick={() => void retry()}
      >
        Retry saved handoff update
      </Button>
      {blocked ? (
        <p role="alert">
          Conflicting or revoked release evidence needs merchant review.
        </p>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {error ? (
        <p role="alert" className="text-[var(--error-text)]">
          {error}
        </p>
      ) : null}
    </article>
  )
}
