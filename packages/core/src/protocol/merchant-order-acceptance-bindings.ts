import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { orderSchema, type OrderSchema } from "../schemas"
import { merchantAcceptanceBinding } from "./merchant-acceptance-privacy"

type OrderIdentity = Pick<OrderSchema, "id" | "buyerPubkey" | "merchantPubkey">
const hash = (text: string) =>
  bytesToHex(sha256(new TextEncoder().encode(text)))
const identityBinding = (order: OrderIdentity) =>
  JSON.stringify([order.id, order.buyerPubkey, order.merchantPubkey])

export function merchantOccurrenceAcceptanceBindings(order: OrderSchema) {
  return {
    identityBinding: merchantAcceptanceBinding(
      "identity",
      identityBinding(order)
    ),
    termsBinding: merchantAcceptanceBinding("terms", JSON.stringify(order)),
  }
}

/** Same canonical identity commitment when the private full order is not retained. */
export function getOrganizerStockOrderIdentityHash(order: OrderIdentity) {
  return hash(identityBinding(order))
}

/** Opaque journal commitments over the existing canonical acceptance bytes. */
export function getOrganizerStockOrderBindings(candidate: OrderSchema) {
  const order = orderSchema.parse(candidate)
  // These canonical wire commitments predate the device-local storage format.
  const bindings = {
    identityBinding: identityBinding(order),
    termsBinding: JSON.stringify(order),
  }
  return {
    ...bindings,
    identityHash: hash(bindings.identityBinding),
    termsHash: hash(bindings.termsBinding),
  }
}
