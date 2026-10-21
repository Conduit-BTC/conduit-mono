import { getOrderMessagingReadiness } from "@conduit/core/protocol/order-messaging-readiness"
import type { InboxDeclarationStatus } from "@conduit/core"
import { Button } from "./Button"

/** Network owns repair. A separate tab keeps checkout inputs, unsent drafts,
 * and exact staged retries in their original mounted surface. */
export function OrderMessagingReadinessNotice({
  status,
  checking = false,
  context = "reply",
  onRetry,
}: {
  status: InboxDeclarationStatus
  checking?: boolean
  context?: "checkout" | "reply"
  onRetry: () => void
}) {
  const readiness = getOrderMessagingReadiness(
    status,
    context === "checkout" ? "initial_order" : "direct_reply"
  )
  if (readiness.ready) return null
  return (
    <div role="status" aria-live="polite" className="space-y-2 text-sm">
      <p className="font-medium text-[var(--text-primary)]">
        {readiness.title}
      </p>
      <p className="text-[var(--text-secondary)]">{readiness.detail}</p>
      {readiness.action === "setup" ? (
        <>
          <Button asChild variant="outline" size="sm">
            <a href="/network" target="_blank" rel="noopener noreferrer">
              Open Network settings in a new tab
            </a>
          </Button>
          <p className="text-[var(--text-secondary)]">
            {context === "checkout"
              ? "Your checkout stays here."
              : "Your draft stays here."}{" "}
            Return here after saving your inbox settings.
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRetry}
            disabled={checking}
          >
            Check again
          </Button>
        </>
      ) : readiness.action === "retry" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={checking}
        >
          Retry inbox check
        </Button>
      ) : null}
    </div>
  )
}
