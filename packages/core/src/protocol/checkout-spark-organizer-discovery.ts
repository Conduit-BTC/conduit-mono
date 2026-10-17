import type { CommerceInbox } from "./commerce-inbox"
import type { CheckoutRecoveryDescriptor } from "./checkout-spark-recovery"
import type { SignedPublicNostrEvent } from "./signed-event"
import type { EventMarketFreePurchaseDescriptor } from "./event-market-free-purchase"

export interface CheckoutSparkOrganizerRecoverySelection {
  checkoutId: string
  orderId: string
  planDigest: string
  marketCoordinate: string
  takeoverAt: number
  initialWrap: SignedPublicNostrEvent
  buyerProgressWraps: SignedPublicNostrEvent[]
  organizerProgressWraps: SignedPublicNostrEvent[]
}
/** A zero-cost pickup has no financial checkout, plan or wallet to restore. */
export interface EventMarketFreePurchaseSelection {
  orderId: string
  merchantPubkey: string
  organizerPubkey: string
  marketCoordinate: string
  handoffId: string
  signedRecipientWrap: SignedPublicNostrEvent
}

/**
 * Dedicated machine-only view over the existing shared inbox owner. No new
 * network reader, signer or plaintext credential cache is created. Callers may
 * request more history through that owner's bounded existing paging controls.
 */
export async function readRetainedCheckoutSparkOrganizerRecoveries(input: {
  inbox: CommerceInbox
  marketCoordinate?: string
  shouldContinue(): boolean
}): Promise<{
  selections: CheckoutSparkOrganizerRecoverySelection[]
  freeSelections: EventMarketFreePurchaseSelection[]
  conflictingCheckouts: number
  capped: boolean
}> {
  const check = () => {
    input.inbox.assertCurrent()
    if (!input.shouldContinue())
      throw new Error("Organizer checkout discovery session changed.")
  }
  check()
  await input.inbox.initialize()
  await input.inbox.waitForDecode()
  check()
  const [projections, wrappers] = await Promise.all([
    input.inbox.store.projections(),
    input.inbox.store.wrappers(),
  ])
  check()
  const byWrap = new Map(wrappers.map((row) => [row.event.id, row.event]))
  const groups = new Map<string, CheckoutRecoveryDescriptor[]>()
  const freeGroups = new Map<string, EventMarketFreePurchaseDescriptor[]>()
  let capped = false
  for (const { projection } of projections) {
    if (projection.kind === "event_free_purchase") {
      const descriptor = projection.message
      if (
        input.marketCoordinate !== undefined &&
        descriptor.marketCoordinate !== input.marketCoordinate
      )
        continue
      const key = JSON.stringify([
        descriptor.orderId,
        descriptor.merchantPubkey,
        descriptor.organizerPubkey,
      ])
      if (!freeGroups.has(key) && freeGroups.size + groups.size >= 128) {
        capped = true
        continue
      }
      const group = freeGroups.get(key) ?? []
      if (group.length >= 512) {
        capped = true
        continue
      }
      group.push(descriptor)
      freeGroups.set(key, group)
      continue
    }
    if (projection.kind !== "checkout_recovery") continue
    const descriptor = projection.message
    if (
      descriptor.recipientRole !== "organizer" ||
      !descriptor.organizerMessage ||
      !descriptor.marketCoordinate ||
      (input.marketCoordinate !== undefined &&
        descriptor.marketCoordinate !== input.marketCoordinate)
    )
      continue
    const key = JSON.stringify([descriptor.checkoutId, descriptor.planDigest])
    if (!groups.has(key) && groups.size + freeGroups.size >= 128) {
      capped = true
      continue
    }
    const group = groups.get(key) ?? []
    if (group.length >= 512) {
      capped = true
      continue
    }
    group.push(descriptor)
    groups.set(key, group)
  }
  let conflictingCheckouts = 0
  const selections: CheckoutSparkOrganizerRecoverySelection[] = []
  const freeSelections: EventMarketFreePurchaseSelection[] = []
  let bytes = 0
  for (const group of groups.values()) {
    const initial = group.filter((row) => row.organizerMessage === "initial")
    if (!initial.length) continue
    if (
      new Set(initial.map((row) => row.payloadDigest)).size !== 1 ||
      new Set(
        group.map((row) =>
          JSON.stringify([row.orderId, row.marketCoordinate, row.takeoverAt])
        )
      ).size !== 1
    ) {
      conflictingCheckouts++
      continue
    }
    initial.sort((a, b) => a.wrapId.localeCompare(b.wrapId))
    const first = initial[0]!
    const initialWrap = byWrap.get(first.wrapId)
    if (!initialWrap) continue
    const collect = (kind: "buyer_progress" | "execution") =>
      [
        ...new Map(
          group
            .filter((row) => row.organizerMessage === kind)
            .map((row) => [row.payloadDigest, row])
        ).values(),
      ]
        .map((row) => byWrap.get(row.wrapId))
        .filter((wrap): wrap is SignedPublicNostrEvent => wrap !== undefined)
    const selection = {
      checkoutId: first.checkoutId,
      orderId: first.orderId,
      planDigest: first.planDigest,
      marketCoordinate: first.marketCoordinate!,
      takeoverAt: first.takeoverAt,
      initialWrap,
      buyerProgressWraps: collect("buyer_progress"),
      organizerProgressWraps: collect("execution"),
    }
    const size = new TextEncoder().encode(JSON.stringify(selection)).length
    if (bytes + size > 4 * 1024 * 1024) {
      capped = true
      continue
    }
    bytes += size
    selections.push(structuredClone(selection))
  }
  for (const group of freeGroups.values()) {
    if (
      new Set(
        group.map((row) =>
          JSON.stringify([
            row.id,
            row.senderPubkey,
            row.createdAt,
            row.orderId,
            row.merchantPubkey,
            row.organizerPubkey,
            row.marketCoordinate,
            row.handoffId,
          ])
        )
      ).size !== 1
    ) {
      conflictingCheckouts++
      continue
    }
    group.sort((a, b) => a.wrapId.localeCompare(b.wrapId))
    const first = group[0]!
    const signedRecipientWrap = byWrap.get(first.wrapId)
    if (!signedRecipientWrap) continue
    const selection: EventMarketFreePurchaseSelection = {
      orderId: first.orderId,
      merchantPubkey: first.merchantPubkey,
      organizerPubkey: first.organizerPubkey,
      marketCoordinate: first.marketCoordinate,
      handoffId: first.handoffId,
      signedRecipientWrap,
    }
    const size = new TextEncoder().encode(JSON.stringify(selection)).length
    if (bytes + size > 4 * 1024 * 1024) {
      capped = true
      continue
    }
    bytes += size
    freeSelections.push(structuredClone(selection))
  }
  check()
  return { selections, freeSelections, conflictingCheckouts, capped }
}
