import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { orderSchema, type OrderSchema } from "../schemas"

export function merchantOccurrenceAcceptanceBindings(order: OrderSchema) {
  return {
    identityBinding: JSON.stringify([
      order.id,
      order.buyerPubkey,
      order.merchantPubkey,
    ]),
    termsBinding: JSON.stringify(order),
  }
}

/** Opaque journal commitments over the existing canonical acceptance bytes. */
export function getOrganizerStockOrderBindings(candidate: OrderSchema) {
  const bindings = merchantOccurrenceAcceptanceBindings(
    orderSchema.parse(candidate)
  )
  const hash = (text: string) =>
    bytesToHex(sha256(new TextEncoder().encode(text)))
  return {
    ...bindings,
    identityHash: hash(bindings.identityBinding),
    termsHash: hash(bindings.termsBinding),
  }
}
