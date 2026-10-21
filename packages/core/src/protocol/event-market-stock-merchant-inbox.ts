import { hasCompleteOrderTerms, getOrderProtocolPayload } from "./orders"
import type { CommerceInbox } from "./commerce-inbox"
import type { AuthenticatedEventMarketStockPacket } from "./event-market-stock-workflow"
import { getOrganizerStockOrderBindings } from "./merchant-order-acceptance-bindings"
import type { SignedPublicNostrEvent } from "./signed-event"

export interface MerchantOrganizerStockImportSelection {
  orderId: string
  originalOrderEnvelope: SignedPublicNostrEvent
  acceptedEnvelopes: SignedPublicNostrEvent[]
}

/**
 * Compose retained original Buyer orders with private organizer decisions.
 * This is discovery, not stock or settlement authority: import independently
 * authenticates every seal and the complete immutable order before writing.
 */
export async function readRetainedMerchantOrganizerStockImports(input: {
  inbox: CommerceInbox
  marketCoordinate: string
  packets: readonly AuthenticatedEventMarketStockPacket[]
  shouldContinue(): boolean
}): Promise<{
  selections: MerchantOrganizerStockImportSelection[]
  conflictingOrders: number
  capped: boolean
}> {
  const check = () => {
    input.inbox.assertCurrent()
    if (!input.shouldContinue())
      throw new Error("Merchant stock discovery session changed.")
  }
  check()
  await input.inbox.initialize()
  await input.inbox.waitForDecode()
  check()
  const projections = await input.inbox.store.projections()
  const wrappers = new Map(
    (await input.inbox.store.wrappers()).map((row) => [row.event.id, row.event])
  )
  check()
  const groups = new Map<
    string,
    Map<
      string,
      {
        envelope: SignedPublicNostrEvent
        identityHash: string
        termsHash: string
      }
    >
  >()
  let capped = false
  for (const { row, projection } of projections) {
    if (projection.kind !== "order" || projection.message.type !== "order")
      continue
    const message = projection.message
    if (!hasCompleteOrderTerms(message)) continue
    const order = getOrderProtocolPayload(message)
    if (
      message.recipientPubkey !== input.inbox.store.principal ||
      order.merchantPubkey !== input.inbox.store.principal ||
      !order.items.length ||
      order.items.some(
        (item) =>
          item.fulfillment?.type !== "event_market_pickup" ||
          item.fulfillment.mode !== "organizer_handoff" ||
          item.fulfillment.market.coordinate !== input.marketCoordinate
      )
    )
      continue
    const envelope = row.wrapId ? wrappers.get(row.wrapId) : undefined
    if (!envelope) continue
    if (!groups.has(order.id) && groups.size >= 128) {
      capped = true
      continue
    }
    const binding = getOrganizerStockOrderBindings(order)
    const group = groups.get(order.id) ?? new Map()
    group.set(JSON.stringify([binding.identityHash, binding.termsHash]), {
      envelope,
      identityHash: binding.identityHash,
      termsHash: binding.termsHash,
    })
    groups.set(order.id, group)
  }
  const selections: MerchantOrganizerStockImportSelection[] = []
  let conflictingOrders = 0,
    bytes = 0
  for (const [orderId, originals] of groups) {
    if (originals.size !== 1) {
      conflictingOrders++
      continue
    }
    const original = [...originals.values()][0]!
    const accepted = new Map<string, AuthenticatedEventMarketStockPacket>()
    const pools = new Map<string, string>()
    let conflict = false
    for (const packet of input.packets) {
      const payload = packet.payload
      if (
        payload.type !== "accepted" ||
        payload.merchantPubkey !== input.inbox.store.principal ||
        payload.orderId !== orderId
      )
        continue
      if (
        payload.identityBinding !== original.identityHash ||
        payload.termsBinding !== original.termsHash ||
        (pools.has(payload.poolId) &&
          pools.get(payload.poolId) !== packet.rumor.id)
      ) {
        conflict = true
        break
      }
      pools.set(payload.poolId, packet.rumor.id)
      accepted.set(packet.rumor.id, packet)
      if (accepted.size > 512) {
        capped = true
        conflict = true
        break
      }
    }
    if (conflict) {
      conflictingOrders++
      continue
    }
    if (!accepted.size) continue
    const selection = {
      orderId,
      originalOrderEnvelope: original.envelope,
      acceptedEnvelopes: [...accepted.values()].map(
        (packet) => packet.envelope
      ),
    }
    const size = new TextEncoder().encode(JSON.stringify(selection)).length
    if (bytes + size > 4 * 1024 * 1024) {
      capped = true
      continue
    }
    bytes += size
    selections.push(structuredClone(selection))
  }
  check()
  return { selections, conflictingOrders, capped }
}
