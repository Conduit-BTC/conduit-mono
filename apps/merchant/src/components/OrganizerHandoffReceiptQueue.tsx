import { Check, Loader2, RefreshCw } from "lucide-react"
import {
  formatEventMarketPickupClaimCode,
  formatNpub,
  isVerifiedEventMarketReceiptMerchandiseResolution,
  type EventMarketHandoffAckGate,
  type EventMarketOrganizerClaim,
  type EventMarketReceiptMerchandiseResolution,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusPill,
} from "@conduit/ui"
import {
  eventMarketHandoffDeliveryNeedsRetry,
  eventMarketHandoffRecipientAcknowledged,
  type StoredEventMarketHandoffDelivery,
} from "../lib/event-market-handoff"

function stateLabel(state: EventMarketOrganizerClaim["state"]): string {
  switch (state) {
    case "ready_for_pickup":
      return "Ready for pickup"
    case "handed_out":
      return "Handed out"
    case "revoked":
      return "Revoked"
    case "conflicting":
      return "Conflicting evidence"
  }
}

export function safePickupClaimCode(value: unknown): string {
  if (typeof value !== "string") return "Unavailable"
  try {
    return formatEventMarketPickupClaimCode(value)
  } catch {
    return "Unavailable"
  }
}

export interface OrganizerHandoffMerchandiseRead {
  resolution?: EventMarketReceiptMerchandiseResolution
  error: boolean
}

function merchandiseBlocker(
  read: OrganizerHandoffMerchandiseRead | undefined,
  loading: boolean
): string | null {
  if (!read) {
    return loading
      ? "Resolving the exact signed product evidence before handoff."
      : "Exact signed product evidence is unavailable. Handoff is blocked."
  }
  if (read.error || !read.resolution) {
    return "Exact signed product evidence could not be resolved. Handoff is blocked."
  }
  if (isVerifiedEventMarketReceiptMerchandiseResolution(read.resolution)) {
    return null
  }
  switch (read.resolution.state) {
    case "missing":
      return "The exact signed product revision is missing. Handoff is blocked."
    case "unavailable":
      return "The exact signed product revision is unavailable from the current relay read. Handoff is blocked."
    case "malformed":
      return "The signed product evidence is malformed or forged. Handoff is blocked."
    case "deleted":
      return "The exact signed product revision was deleted. Handoff is blocked."
    case "conflicting":
      return "Conflicting signed product evidence was found. Handoff is blocked."
    case "verified":
      return "Exact signed product evidence could not be authenticated. Handoff is blocked."
  }
}

function publicGraphBlocker(
  gate: EventMarketHandoffAckGate | undefined
): string | null {
  if (!gate || gate.state === "ready") return null
  switch (gate.reason) {
    case "public_graph_not_current":
      return "The current signed event graph is stale, deleted, or no longer matches this receipt."
    case "product_not_accepted":
      return "This exact product revision is no longer accepted by the event organizer."
    case "handoff_changed":
      return "The signed pickup handler changed after this receipt was issued."
    case "merchandise_not_verified":
      return null
    default:
      return null
  }
}

export function OrganizerHandoffReceiptQueue({
  claims,
  ackDeliveries,
  merchandiseReads,
  merchandiseLoading,
  ackReadinessByReceiptId,
  loading,
  stale,
  decryptFailureCount,
  discoveryEvidenceComplete,
  error,
  actionError,
  pendingReceiptId,
  onAcknowledge,
  onRefresh,
}: {
  claims: readonly EventMarketOrganizerClaim[]
  ackDeliveries: readonly StoredEventMarketHandoffDelivery[]
  merchandiseReads: Readonly<Record<string, OrganizerHandoffMerchandiseRead>>
  merchandiseLoading: boolean
  ackReadinessByReceiptId: Readonly<
    Record<string, EventMarketHandoffAckGate | undefined>
  >
  loading: boolean
  stale: boolean
  decryptFailureCount: number
  discoveryEvidenceComplete: boolean
  error: boolean
  actionError?: string
  pendingReceiptId: string | null
  onAcknowledge: (claim: EventMarketOrganizerClaim) => void
  onRefresh: () => void
}) {
  const discoveryDegraded =
    stale || decryptFailureCount > 0 || error || !discoveryEvidenceComplete
  return (
    <Card data-testid="organizer-handoff-receipt-queue">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Organizer handoff queue</CardTitle>
            <CardDescription className="mt-1 max-w-2xl leading-6">
              Only minimal merchant-authorized pickup receipts appear here.
              Buyer contact, addresses, notes, invoices, payment details, and
              the full order are never shown.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && claims.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking private receipt evidence...
          </div>
        )}

        {discoveryDegraded && (!loading || claims.length > 0) && (
          <p
            className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm leading-6 text-[var(--text-primary)]"
            role="alert"
          >
            Receipt discovery is incomplete. Refreshing may find additional
            authorizations or revocations, but it does not invalidate a valid
            merchant authorization already shown here.
          </p>
        )}

        {actionError && (
          <p
            className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm leading-6 text-error"
            role="alert"
          >
            {actionError} Retry uses the exact saved encrypted update.
          </p>
        )}

        {!loading && !error && claims.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-sm text-[var(--text-muted)]">
            No current organizer-handoff receipts for this event.
          </p>
        )}

        {claims.map((claim) => {
          const receipt = claim.receipt.payload
          const pending = pendingReceiptId === claim.receipt.id
          const ackDelivery = ackDeliveries.find(
            (delivery) =>
              delivery.record.readyReceiptId === claim.receipt.id.toLowerCase()
          )
          const ackNeedsRetry = ackDelivery
            ? eventMarketHandoffDeliveryNeedsRetry(ackDelivery)
            : false
          const ackRecipientAcknowledged = ackDelivery
            ? eventMarketHandoffRecipientAcknowledged(ackDelivery)
            : false
          const merchandiseRead = merchandiseReads[claim.receipt.id]
          const merchandise = merchandiseRead?.resolution
          const merchandiseWarning = merchandiseBlocker(
            merchandiseRead,
            merchandiseLoading
          )
          const ackReadiness = ackReadinessByReceiptId[claim.receipt.id]
          const graphWarning = publicGraphBlocker(ackReadiness)
          return (
            <article
              key={claim.receipt.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    Merchant {formatNpub(receipt.merchantPubkey, 8)}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    Pickup code {safePickupClaimCode(receipt.claimRef)}
                  </div>
                </div>
                <StatusPill
                  variant={
                    claim.state === "handed_out"
                      ? "success"
                      : claim.state === "ready_for_pickup"
                        ? "warning"
                        : "error"
                  }
                >
                  {stateLabel(claim.state)}
                </StatusPill>
              </div>

              <div className="mt-3 space-y-2">
                {receipt.items.map((item) => (
                  <div
                    key={item.product.coordinate}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[var(--text-primary)]">
                        {merchandise?.items.find(
                          (resolved) =>
                            resolved.product.eventId.toLowerCase() ===
                            item.product.eventId.toLowerCase()
                        )?.title ?? "Product details unavailable"}
                      </div>
                    </div>
                    <span className="shrink-0 text-[var(--text-secondary)]">
                      Qty {item.quantity}
                    </span>
                  </div>
                ))}
              </div>

              {(merchandiseWarning || graphWarning) && (
                <p
                  className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-5 text-[var(--text-primary)]"
                  role="alert"
                >
                  {merchandiseWarning ?? graphWarning} Refresh current event and
                  product evidence before handing anything out.
                </p>
              )}

              {ackDelivery && ackNeedsRetry && (
                <p
                  className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-5 text-[var(--text-primary)]"
                  role="status"
                >
                  {!ackRecipientAcknowledged
                    ? "No merchant inbox relay acknowledged the encrypted handed-out update. Retry reuses the exact saved wraps."
                    : ackDelivery.recipient.status === "partial_success"
                      ? "Some merchant inbox relays accepted the handed-out update, but exact delivery is still partial."
                      : ackDelivery.selfCopy.status === "failed"
                        ? "The merchant leg was accepted, but your encrypted recovery copy failed. Exact retry remains available."
                        : "The encrypted handed-out update still needs an exact delivery retry."}
                </p>
              )}

              {claim.state === "ready_for_pickup" && (
                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      ackReadiness?.state !== "ready" ||
                      pending ||
                      (!!ackDelivery && !ackNeedsRetry)
                    }
                    onClick={() => onAcknowledge(claim)}
                  >
                    {pending ? <Loader2 className="animate-spin" /> : <Check />}
                    {pending
                      ? "Sending exact update..."
                      : ackDelivery
                        ? ackNeedsRetry
                          ? "Retry exact update"
                          : "Update sent"
                        : "Mark handed out"}
                  </Button>
                </div>
              )}
            </article>
          )
        })}
      </CardContent>
    </Card>
  )
}
