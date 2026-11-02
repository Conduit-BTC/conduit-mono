import type { OrderSchema } from "@conduit/core"

export function MerchantOrderContactNotice({
  buyerInboxKnown,
  isGuestOrder,
  order,
}: {
  buyerInboxKnown: boolean
  isGuestOrder: boolean
  order: OrderSchema | null
}) {
  if (buyerInboxKnown) return null
  // The order parser already validates this explicit guest Event-pickup lane.
  // Having a receipt identifies a claim; it never proves payment or handout.
  const contactFree = isGuestOrder && !!order?.contactFreePickup
  const detail = contactFree
    ? "This guest chose name-only pickup. Use their private receipt to identify the order, then verify payment and pickup authority before handing over goods. No phone, email or Nostr reply inbox was shared."
    : isGuestOrder
      ? order?.guestContact
        ? "This guest has no Nostr reply inbox. Contact them by phone or email; fulfillment actions below are recorded to your encrypted order history."
        : "This guest has no Nostr reply inbox and the order is missing required contact details. Fulfillment actions below are recorded only to your encrypted order history."
      : "This partial order history does not prove the buyer has a Nostr reply inbox. Actions are recorded to your encrypted order history until the order identity is recovered."
  return (
    <p
      role="status"
      className={
        contactFree
          ? "mt-4 text-sm leading-6 text-[var(--text-secondary)]"
          : "mt-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm leading-6 text-[var(--warning-text)]"
      }
    >
      {detail}
    </p>
  )
}
