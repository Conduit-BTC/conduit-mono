import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { orderSchema, type OrderSchema } from "../schemas"

type OrderIdentity = Pick<OrderSchema, "id" | "buyerPubkey" | "merchantPubkey">
const hash = (text: string) =>
  bytesToHex(sha256(new TextEncoder().encode(text)))
const identityBinding = (order: OrderIdentity) =>
  JSON.stringify([order.id, order.buyerPubkey, order.merchantPubkey])

export function merchantOccurrenceAcceptanceBindings(order: OrderSchema) {
  return {
    identityBinding: identityBinding(order),
    termsBinding: JSON.stringify(order),
  }
}

/** Same canonical identity commitment when the private full order is not retained. */
export function getOrganizerStockOrderIdentityHash(order: OrderIdentity) {
  return hash(identityBinding(order))
}

/** Opaque journal commitments over the existing canonical acceptance bytes. */
export function getOrganizerStockOrderBindings(candidate: OrderSchema) {
  const bindings = merchantOccurrenceAcceptanceBindings(
    orderSchema.parse(candidate)
  )
  return {
    ...bindings,
    identityHash: hash(bindings.identityBinding),
    termsHash: hash(bindings.termsBinding),
  }
}
