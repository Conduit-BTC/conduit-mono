import type { ConduitDB } from "../db"
import type { AccountSigner } from "./nostr-event-signer"
import { unwrapPrivateMessageEnvelope } from "./private-message-primitives"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  parseEventMarketFreePurchaseRumor,
  type EventMarketFreePurchasePayload,
} from "./event-market-free-purchase"
import {
  assertCheckoutSparkOrganizerRecoveryAuthority,
  assertEventMarketOrganizerStockWriters,
  type CheckoutSparkOrganizerRecoveryAuthority,
  type CheckoutSparkOrganizerPurchase,
} from "./checkout-spark-organizer-execution"
import { getFutureMarketClaimRef } from "./future-market-handoff"
import type { CheckoutSparkEventMarketBinding } from "./checkout-spark-event-market"
import type { CheckoutSparkOrganizerOrderBinding } from "./checkout-spark-organizer-recovery"

declare const freePurchaseBrand: unique symbol
export interface EventMarketFreePurchaseAuthority {
  readonly [freePurchaseBrand]: true
}
export type EventMarketOrganizerPurchaseAuthority =
  CheckoutSparkOrganizerRecoveryAuthority | EventMarketFreePurchaseAuthority

/** Minimal common stock/claim context; a free order has no financial plan. */
export interface EventMarketOrganizerPurchase {
  kind: "routed" | "free"
  handoffId: string
  orderId: string
  merchantPubkey: string
  organizerPubkey: string
  eventMarket: CheckoutSparkEventMarketBinding
  orderBinding: CheckoutSparkOrganizerOrderBinding
  claimRef: string
  writerBindings: CheckoutSparkOrganizerPurchase["writerBindings"]
  /** Opaque original financial-plan or free-purchase digest, never a payment flag. */
  recoveryBinding: { planDigest: string } | { freePurchaseId: string }
}
type FreeContext = {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  writerId: string
  shouldContinue(): boolean
  assertCurrent(): void
  purchase: EventMarketOrganizerPurchase
  payload: EventMarketFreePurchasePayload
}
const freeContexts = new WeakMap<
  EventMarketFreePurchaseAuthority,
  FreeContext
>()
function invalid(): never {
  throw new Error("Exact organizer purchase authority is unavailable.")
}

export async function openEventMarketFreePurchaseAuthority(input: {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  writerId: string
  signedRecipientWrap: SignedPublicNostrEvent
  shouldContinue(): boolean
  now?: () => number
}): Promise<EventMarketFreePurchaseAuthority> {
  input = {
    ...input,
    signedRecipientWrap: structuredClone(input.signedRecipientWrap),
  }
  const { revision, authMethod } = input.signer
  const now = input.now ?? Date.now
  const openedAt = now()
  const check = () => {
    if (
      !input.shouldContinue() ||
      !revision ||
      !authMethod ||
      input.signer.revision !== revision ||
      input.signer.authMethod !== authMethod ||
      input.signer.pubkey !== input.authenticatedPubkey ||
      !input.signer.capabilities.nip44 ||
      !Number.isSafeInteger(now()) ||
      now() < openedAt ||
      now() >= openedAt + 5 * 60_000
    )
      invalid()
  }
  check()
  if ((await input.signer.getPublicKey()) !== input.authenticatedPubkey)
    invalid()
  check()
  const wrap = input.signedRecipientWrap
  if (
    !isValidSignedPublicNostrEvent(wrap) ||
    wrap.kind !== 1059 ||
    JSON.stringify(wrap.tags.filter((tag) => tag[0] === "p")) !==
      JSON.stringify([["p", input.authenticatedPubkey]])
  )
    invalid()
  const rumor = await unwrapPrivateMessageEnvelope(wrap, input.signer)
  check()
  const payload = parseEventMarketFreePurchaseRumor(rumor)
  if (
    payload.organizerPubkey !== input.authenticatedPubkey ||
    payload.createdAt > openedAt
  )
    invalid()
  const writerBindings = payload.eventMarket.lines
    .map((line) => ({
      poolId: line.stockPoolId!,
      writerId: input.writerId,
      quantity: line.quantity,
    }))
    .sort((a, b) => a.poolId.localeCompare(b.poolId))
  if (
    new Set(writerBindings.map((row) => row.poolId)).size !==
    writerBindings.length
  )
    invalid()
  const purchase: EventMarketOrganizerPurchase = {
    kind: "free",
    handoffId: payload.handoffId,
    orderId: payload.orderId,
    merchantPubkey: payload.merchantPubkey,
    organizerPubkey: payload.organizerPubkey,
    eventMarket: payload.eventMarket,
    orderBinding: payload.orderBinding,
    writerBindings,
    recoveryBinding: { freePurchaseId: payload.handoffId },
    claimRef: getFutureMarketClaimRef({
      orderId: payload.orderId,
      merchantPubkey: payload.merchantPubkey,
      organizerPubkey: payload.organizerPubkey,
      marketCoordinate: payload.eventMarket.marketCoordinate,
    }),
  }
  const context: FreeContext = {
    ...input,
    assertCurrent: check,
    payload,
    purchase,
  }
  await assertFreeWriters(context)
  check()
  const authority = Object.freeze({}) as EventMarketFreePurchaseAuthority
  freeContexts.set(authority, context)
  return authority
}

async function assertFreeWriters(context: FreeContext) {
  return assertEventMarketOrganizerStockWriters({
    ...context,
    organizerPubkey: context.purchase.organizerPubkey,
    merchantPubkey: context.purchase.merchantPubkey,
    eventMarket: context.purchase.eventMarket,
    writerBindings: context.purchase.writerBindings,
  })
}

export function assertEventMarketOrganizerPurchaseAuthority(
  authority: EventMarketOrganizerPurchaseAuthority
): EventMarketOrganizerPurchase {
  const free = freeContexts.get(authority as EventMarketFreePurchaseAuthority)
  if (free) {
    free.assertCurrent()
    return structuredClone(free.purchase)
  }
  const financial = assertCheckoutSparkOrganizerRecoveryAuthority(
    authority as CheckoutSparkOrganizerRecoveryAuthority
  )
  return {
    kind: "routed",
    handoffId: financial.handoffId,
    orderId: financial.plan.orderId,
    merchantPubkey: financial.plan.merchantPubkey,
    organizerPubkey: financial.plan.eventMarket!.organizerPubkey,
    eventMarket: financial.plan.eventMarket!,
    orderBinding: financial.orderBinding,
    writerBindings: financial.writerBindings,
    claimRef: financial.claimRef,
    recoveryBinding: { planDigest: financial.plan.planDigest },
  }
}

/** Fresh zero-cost authority only; never a substitute for financial settlement. */
export async function assertEventMarketFreePurchaseAuthority(
  authority: EventMarketFreePurchaseAuthority
): Promise<EventMarketOrganizerPurchase> {
  const context = freeContexts.get(authority)
  if (!context) invalid()
  context.assertCurrent()
  await assertFreeWriters(context)
  context.assertCurrent()
  return structuredClone(context.purchase)
}
