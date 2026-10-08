import type { AccountInboxSendResult } from "@conduit/core"

/** Recipient acceptance, device history and cross-device sync are distinct. */
export function PrivateSendNotice({
  outcome,
  label,
}: {
  outcome: AccountInboxSendResult | null
  label: "Attachment" | "Reply"
}) {
  if (!outcome) return null
  if (outcome.localHistory === "unavailable")
    return (
      <p role="alert" className="w-full text-sm">
        {label} sent, but it could not be saved on this device. Do not send it
        again.
      </p>
    )
  if (outcome.checkpointFailure)
    return (
      <p role="alert" className="w-full text-sm">
        {label} sent and saved on this device, but its delivery status could not
        be saved. Do not send it again.
      </p>
    )
  if (outcome.selfCopy === "complete") return null
  return (
    <p role="status" className="w-full text-sm">
      {label} sent and saved on this device. Sync to your other devices is
      incomplete.
    </p>
  )
}
