import { useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { Button } from "./Button"
import { Textarea } from "./Textarea"

/** Session-local presentation for the request created by the selected wallet. */
export function WalletReceiveRequest({
  request,
  kind,
  current,
}: {
  request: string
  kind: "lightning" | "spark"
  current: () => boolean
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  )
  const lightning = kind === "lightning"
  const copy = async () => {
    if (!current()) return
    setCopyStatus("idle")
    try {
      await navigator.clipboard.writeText(request)
      if (current()) setCopyStatus("copied")
    } catch {
      if (current()) setCopyStatus("error")
    }
  }
  return (
    <div className="grid min-w-0 gap-3">
      <div
        role="img"
        aria-label={
          lightning ? "Lightning invoice QR code" : "Spark address QR code"
        }
        className="mx-auto size-56 max-w-full"
      >
        <QRCodeSVG
          value={request}
          size={224}
          marginSize={4}
          className="!size-full"
        />
      </div>
      <p className="text-center text-sm text-[var(--text-secondary)]">
        {lightning
          ? "Scan with a Lightning wallet."
          : "Scan with a Spark wallet."}
      </p>
      <Button
        variant="outline"
        onClick={() => void copy()}
        aria-label={
          copyStatus === "copied"
            ? "Payment request copied"
            : "Copy payment request"
        }
      >
        {copyStatus === "copied"
          ? "Copied"
          : lightning
            ? "Copy invoice"
            : "Copy Spark address"}
      </Button>
      <details className="min-w-0 text-sm text-[var(--text-secondary)]">
        <summary className="cursor-pointer py-2">Payment request</summary>
        <Textarea
          aria-label="Payment request"
          value={request}
          readOnly
          className="mt-2 font-mono text-sm"
        />
      </details>
      <p aria-live="polite" className="sr-only">
        {copyStatus === "copied"
          ? "Payment request copied."
          : "Payment request ready."}
      </p>
      {copyStatus === "error" && (
        <p role="alert" className="text-sm">
          Copy was blocked. Open Payment request to copy it manually.
        </p>
      )}
    </div>
  )
}
