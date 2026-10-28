import { z } from "zod"
import { getEventHash } from "nostr-tools"
import { hasExactMachineRumorBindings } from "./machine-rumor-binding"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  createCheckoutSparkMerchantProgress,
  parseCheckoutSparkMerchantProgress,
  type CheckoutSparkMerchantProgressPayload,
} from "./checkout-spark-merchant-progress"
import {
  deriveCheckoutSparkOrganizerRecoveryHandoffId,
  type CheckoutSparkOrganizerOrderBinding,
} from "./checkout-spark-organizer-recovery"
import {
  isCheckoutSparkEventMarketPlan,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  unwrapPrivateMessageEnvelope,
  type PrivateMessageEvent,
  type PrivateMessageRumor,
} from "./messaging"
import type { NostrKeySigner } from "./nostr-event-signer"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const time = z.number().int().safe().nonnegative()
const bindingSchema = z
  .object({ identityHash: hash, termsHash: hash, createdAt: time })
  .strict()
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("checkout_spark_merchant_event_progress"),
    snapshotId: hash,
    initialHandoffId: hash,
    initialOrganizerHandoffId: hash,
    merchantPubkey: hash,
    organizerPubkey: hash,
    recordedAt: time,
    orderBinding: bindingSchema,
    state: z.unknown(),
  })
  .strict()

/** Merchant-authored execution evidence, never stock, fulfillment or payment proof. */
export interface CheckoutSparkMerchantEventProgress {
  schemaVersion: 1
  type: "checkout_spark_merchant_event_progress"
  snapshotId: string
  initialHandoffId: string
  initialOrganizerHandoffId: string
  merchantPubkey: string
  organizerPubkey: string
  recordedAt: number
  orderBinding: CheckoutSparkOrganizerOrderBinding
  state: CheckoutSparkSettledReconciliation
}

function invalid(): never {
  throw new Error("Merchant Event checkout progress requires reconciliation.")
}

export function createCheckoutSparkMerchantEventProgress(input: {
  merchantProgress: CheckoutSparkMerchantProgressPayload
  orderBinding: CheckoutSparkOrganizerOrderBinding
}): CheckoutSparkMerchantEventProgress {
  const progress = parseCheckoutSparkMerchantProgress(input.merchantProgress)
  const { state } = progress
  const binding = state.plan.eventMarket
  const orderBinding = bindingSchema.parse(input.orderBinding)
  if (
    !isCheckoutSparkEventMarketPlan(state.plan) ||
    binding?.mode !== "organizer_handoff" ||
    orderBinding.createdAt < state.plan.createdAt ||
    orderBinding.createdAt >=
      (state.plan.schemaVersion === 6
        ? state.plan.funding.expiresAt
        : state.plan.takeoverAt)
  )
    invalid()
  const base = {
    schemaVersion: 1 as const,
    type: "checkout_spark_merchant_event_progress" as const,
    initialHandoffId: progress.initialHandoffId,
    initialOrganizerHandoffId: deriveCheckoutSparkOrganizerRecoveryHandoffId({
      merchantHandoffId: progress.initialHandoffId,
      organizerPubkey: binding.organizerPubkey,
      orderBinding,
    }),
    merchantPubkey: progress.merchantPubkey,
    organizerPubkey: binding.organizerPubkey,
    recordedAt: progress.recordedAt,
    orderBinding,
    state,
  }
  return {
    ...base,
    snapshotId: bytesToHex(
      sha256(
        new TextEncoder().encode(
          JSON.stringify([
            "conduit:checkout-spark-merchant-event-progress:v1",
            base,
          ])
        )
      )
    ),
  }
}

export function parseCheckoutSparkMerchantEventProgress(
  value: unknown
): CheckoutSparkMerchantEventProgress {
  const parsed = payloadSchema.safeParse(value)
  if (!parsed.success) invalid()
  const canonical = createCheckoutSparkMerchantEventProgress({
    merchantProgress: createCheckoutSparkMerchantProgress({
      initialHandoffId: parsed.data.initialHandoffId,
      state: parsed.data.state as CheckoutSparkSettledReconciliation,
    }),
    orderBinding: parsed.data.orderBinding,
  })
  // Parsing the nested state separately rejects private/unknown fields as well.
  parseCheckoutSparkMerchantProgress({
    ...createCheckoutSparkMerchantProgress({
      initialHandoffId: parsed.data.initialHandoffId,
      state: canonical.state,
    }),
    state: parsed.data.state,
  })
  if (
    JSON.stringify({ ...parsed.data, state: canonical.state }) !==
    JSON.stringify(payloadSchema.parse(canonical))
  )
    invalid()
  return canonical
}

export function buildCheckoutSparkMerchantEventProgressRumor(
  input: CheckoutSparkMerchantEventProgress
): PrivateMessageRumor {
  const payload = parseCheckoutSparkMerchantEventProgress(input)
  const rumor = {
    kind: 16,
    pubkey: payload.merchantPubkey,
    created_at: Math.floor(payload.recordedAt / 1000),
    tags: [
      ["p", payload.organizerPubkey],
      ["type", payload.type],
      ["order", payload.state.plan.orderId],
    ],
    content: JSON.stringify(payload),
  }
  return { ...rumor, id: getEventHash(rumor) }
}

export function parseCheckoutSparkMerchantEventProgressRumor(
  rumor: PrivateMessageEvent
): CheckoutSparkMerchantEventProgress {
  const payload = parseCheckoutSparkMerchantEventProgress(
    JSON.parse(rumor.content)
  )
  const expected = buildCheckoutSparkMerchantEventProgressRumor(payload)
  if (!hasExactMachineRumorBindings(rumor, expected)) invalid()
  return payload
}

export async function openCheckoutSparkMerchantEventProgress(input: {
  signedRecipientWrap: SignedPublicNostrEvent
  signer: NostrKeySigner
  shouldContinue(): boolean
}): Promise<CheckoutSparkMerchantEventProgress> {
  const wrap = structuredClone(input.signedRecipientWrap)
  if (!input.shouldContinue()) invalid()
  const principal = await input.signer.getPublicKey()
  if (
    !input.shouldContinue() ||
    !isValidSignedPublicNostrEvent(wrap) ||
    wrap.kind !== 1059 ||
    JSON.stringify(wrap.tags.filter((tag) => tag[0] === "p")) !==
      JSON.stringify([["p", principal]]) ||
    wrap.tags.some((tag) => tag[0] === "expiration")
  )
    invalid()
  const rumor = await unwrapPrivateMessageEnvelope(wrap, input.signer)
  if (
    !input.shouldContinue() ||
    (await input.signer.getPublicKey()) !== principal ||
    !input.shouldContinue()
  )
    invalid()
  const payload = parseCheckoutSparkMerchantEventProgressRumor(rumor)
  if (payload.organizerPubkey !== principal) invalid()
  return payload
}
