import { useState } from "react"
import {
  parseEventGuestReceipt,
  verifyEventPickupReceipt,
  type OrderSchema,
} from "@conduit/core"
import { Input } from "./Input"
import { Label } from "./Label"
import { Button } from "./Button"

export function EventGuestReceiptVerifier({
  order,
  merchantPubkey,
}: {
  order: OrderSchema
  merchantPubkey: string
}) {
  const scope = `${order.id}:${merchantPubkey}:${order.pickupReceiptCommitment ?? order.contactFreePickup?.receiptCommitment ?? ""}`
  const [result, setResult] = useState<{
    scope: string
    message: string
  } | null>(null)
  const [code, setCode] = useState("")
  function check(value: unknown) {
    setResult({
      scope,
      message: verifyEventPickupReceipt(value, order, merchantPubkey)
        ? "Receipt matches this order. Confirm payment and any prior refund before arranging a manual refund or rebate. Ask the customer for a payment destination in person."
        : "This receipt does not match this order and merchant.",
    })
  }
  async function verify(file: File | undefined) {
    setResult(null)
    if (!file) return
    try {
      if (file.size > 4096) throw new Error("Invalid receipt")
      const value = parseEventGuestReceipt(await file.text())
      if (!value) throw new Error("Invalid receipt")
      check(value)
    } catch {
      setResult({
        scope,
        message:
          "Could not read this receipt. Choose the original receipt file.",
      })
    }
  }
  if (!order.contactFreePickup && !order.pickupReceiptCommitment) return null
  return (
    <section className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-4">
      <h3 className="font-semibold">
        {order.contactFreePickup
          ? "Contact-free event order"
          : "Event pickup receipt"}
      </h3>
      {order.contactFreePickup ? (
        <p className="text-sm">Handoff name: {order.contactFreePickup.label}</p>
      ) : null}
      <p className="text-xs text-[var(--text-muted)]">
        {order.contactFreePickup
          ? "This guest has no reply inbox or contact details. "
          : ""}
        Receipt verification does not prove payment, authorize handout or issue
        money.
      </p>
      <Label htmlFor="event-guest-receipt-file">Verify customer receipt</Label>
      <Input
        id="event-guest-receipt-file"
        type="file"
        accept=".txt,text/plain,.json,application/json"
        onChange={(event) => {
          void verify(event.target.files?.[0])
        }}
      />
      <Label htmlFor="event-guest-receipt-code">
        Or enter the private receipt code
      </Label>
      <Input
        id="event-guest-receipt-code"
        value={code}
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setCode(event.target.value)
          setResult(null)
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={!/^[0-9a-f]{64}$/.test(code.trim())}
        onClick={() =>
          check({
            format: "conduit-event-receipt",
            version: 1,
            orderId: order.id,
            merchantPubkey,
            claimSecret: code.trim(),
          })
        }
      >
        Verify receipt code
      </Button>
      {result?.scope === scope ? (
        <p role="status" className="text-sm">
          {result.message}
        </p>
      ) : null}
    </section>
  )
}
