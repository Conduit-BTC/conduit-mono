import { useState } from "react"
import { verifyEventGuestReceipt, type OrderSchema } from "@conduit/core"
import { Input } from "./Input"
import { Label } from "./Label"

export function EventGuestReceiptVerifier({
  order,
  merchantPubkey,
}: {
  order: OrderSchema
  merchantPubkey: string
}) {
  const [result, setResult] = useState<string | null>(null)
  async function verify(file: File | undefined) {
    setResult(null)
    if (!file) return
    try {
      if (file.size > 4096) throw new Error("Invalid receipt")
      const value: unknown = JSON.parse(await file.text())
      setResult(
        verifyEventGuestReceipt(value, order, merchantPubkey)
          ? "Receipt matches this order. Confirm payment and any prior refund before arranging a manual refund or rebate. Ask the customer for a payment destination in person."
          : "This receipt does not match this order and merchant."
      )
    } catch {
      setResult(
        "Could not read this receipt. Choose the original receipt file."
      )
    }
  }
  if (!order.contactFreePickup) return null
  return (
    <section className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-4">
      <h3 className="font-semibold">Contact-free event order</h3>
      <p className="text-sm">Handoff name: {order.contactFreePickup.label}</p>
      <p className="text-xs text-[var(--text-muted)]">
        This guest has no reply inbox or contact details. Receipt verification
        does not prove payment or issue money.
      </p>
      <Label htmlFor="event-guest-receipt-file">Verify customer receipt</Label>
      <Input
        id="event-guest-receipt-file"
        type="file"
        accept=".json,application/json"
        onChange={(event) => {
          void verify(event.target.files?.[0])
        }}
      />
      {result ? (
        <p role="status" className="text-sm">
          {result}
        </p>
      ) : null}
    </section>
  )
}
