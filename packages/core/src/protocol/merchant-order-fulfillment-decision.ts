import type { ConduitDB } from "../db"
import type { ParsedOrderMessage, ParsedOrderPayload } from "./orders"
import { CommerceInboxStore } from "./commerce-inbox-store"
import { merchantAcceptanceStore } from "./merchant-acceptance-privacy"
import {
  merchantOccurrenceAcceptanceBindings,
  parseMerchantOccurrenceOrder,
} from "./merchant-order-acceptance-bindings"

type OriginalOrder = Extract<ParsedOrderMessage, { type: "order" }>
export type MerchantFulfillmentChoice = "digital" | "shipping"
export interface MerchantFulfillmentDecisionLine {
  index: number
  productId: string
  quantity: number
  mode: MerchantFulfillmentChoice
}
export interface MerchantFulfillmentDecision {
  version: 1
  originalMessageId: string
  identityBinding: string
  termsBinding: string
  lines: MerchantFulfillmentDecisionLine[]
}

/** Current catalog data cannot fill gaps in the buyer's immutable snapshot. */
export function getUnresolvedMerchantFulfillmentLines(
  order: Pick<ParsedOrderPayload, "items">
) {
  return order.items.flatMap((item, index) =>
    item.format === undefined && item.fulfillment === undefined
      ? [{ index, productId: item.productId, quantity: item.quantity }]
      : []
  )
}

function context(original: OriginalOrder, store: CommerceInboxStore) {
  store.assertCurrent()
  const order = parseMerchantOccurrenceOrder(original.payload)
  if (
    !/^[a-f0-9]{64}$/.test(original.id) ||
    original.orderId !== order.id ||
    original.senderPubkey !== order.buyerPubkey ||
    original.recipientPubkey !== order.merchantPubkey ||
    store.principal !== order.merchantPubkey
  )
    throw new Error("Fulfillment decision does not match the original order.")
  const bindings = merchantOccurrenceAcceptanceBindings(order)
  return {
    ...bindings,
    originalMessageId: original.id,
    unresolved: getUnresolvedMerchantFulfillmentLines(order),
    key: `merchant-fulfillment-decision:${bindings.identityBinding}`,
  }
}

function validateDecision(
  candidate: MerchantFulfillmentDecision,
  scope: ReturnType<typeof context>
): MerchantFulfillmentDecision {
  if (
    candidate?.version !== 1 ||
    candidate.originalMessageId !== scope.originalMessageId ||
    candidate.identityBinding !== scope.identityBinding ||
    candidate.termsBinding !== scope.termsBinding ||
    !Array.isArray(candidate.lines) ||
    !scope.unresolved.length ||
    candidate.lines.length !== scope.unresolved.length ||
    candidate.lines.some((line, index) => {
      const expected = scope.unresolved[index]!
      return (
        line.index !== expected.index ||
        line.productId !== expected.productId ||
        line.quantity !== expected.quantity ||
        (line.mode !== "digital" && line.mode !== "shipping")
      )
    })
  )
    throw new Error("Saved fulfillment decision conflicts with this order.")
  return candidate
}

export async function readMerchantFulfillmentDecision(input: {
  original: OriginalOrder
  database?: ConduitDB
  store?: CommerceInboxStore
}): Promise<MerchantFulfillmentDecision | null> {
  const store =
    input.store ??
    merchantAcceptanceStore(input.original.recipientPubkey, input.database)
  const scope = context(input.original, store)
  const row = await store.database.commerceInboxDeliveries.get(
    store.key(scope.key)
  )
  store.assertCurrent()
  if (!row) return null
  if (
    row.kind !== "merchant_fulfillment_decision" ||
    row.accountPubkey !== store.principal
  )
    throw new Error("Saved fulfillment decision belongs to another operation.")
  return validateDecision(
    await store.open<MerchantFulfillmentDecision>(row.value, scope.key),
    scope
  )
}

/**
 * Supplemental merchant intent, not buyer terms or stock acceptance. Immutable
 * once saved; concurrent same decisions are idempotent and conflicts fail closed.
 */
export async function saveMerchantFulfillmentDecision(input: {
  original: OriginalOrder
  choices: readonly MerchantFulfillmentChoice[]
  shouldContinue?: () => boolean
  database?: ConduitDB
  store?: CommerceInboxStore
}): Promise<MerchantFulfillmentDecision> {
  const store =
    input.store ??
    merchantAcceptanceStore(input.original.recipientPubkey, input.database)
  const assertCurrent = () => {
    store.assertCurrent()
    if (input.shouldContinue?.() === false)
      throw new Error("Selected order or merchant account changed.")
  }
  assertCurrent()
  const scope = context(input.original, store)
  if (input.choices.length !== scope.unresolved.length)
    throw new Error("Choose fulfillment for every unresolved item.")
  const decision = validateDecision(
    {
      version: 1,
      originalMessageId: scope.originalMessageId,
      identityBinding: scope.identityBinding,
      termsBinding: scope.termsBinding,
      lines: scope.unresolved.map((line, index) => ({
        ...line,
        mode: input.choices[index]!,
      })),
    },
    scope
  )
  const value = await store.seal(decision, scope.key)
  assertCurrent()
  await store.database.transaction(
    "rw",
    store.database.commerceInboxDeliveries,
    async () => {
      assertCurrent()
      const id = store.key(scope.key)
      const existing = await store.database.commerceInboxDeliveries.get(id)
      if (!existing)
        await store.database.commerceInboxDeliveries.add({
          id,
          accountPubkey: store.principal,
          kind: "merchant_fulfillment_decision",
          value,
          updatedAt: Date.now(),
        })
      assertCurrent()
    }
  )
  const saved = await readMerchantFulfillmentDecision({ ...input, store })
  assertCurrent()
  if (JSON.stringify(saved) !== JSON.stringify(decision))
    throw new Error("A different fulfillment decision is already saved.")
  return saved!
}
