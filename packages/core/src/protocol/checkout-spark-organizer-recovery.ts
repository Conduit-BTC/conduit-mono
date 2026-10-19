import { z } from "zod"
import { getEventHash } from "nostr-tools"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { orderSchema, type OrderSchema } from "../schemas"
import { matchesCheckoutSparkCommerceOrderLine } from "./checkout-spark-commerce-pricing"
import {
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  type CheckoutSparkSettledRecoveryProgressPayload,
  type CheckoutSparkSettledRecoveryPayload,
  type CheckoutSparkRecoveryTransportOptions,
} from "./checkout-spark-recovery"
import { canonicalizeCheckoutSparkPlanSourceEvents } from "./checkout-spark-plan-sources"
import { appendConduitClientTag } from "./nip89"
import { EVENT_KINDS } from "./kinds"
import {
  publishPrivateMessage,
  unwrapPrivateMessageEnvelope,
  type PrivateMessageEvent,
  type PrivateMessageRumor,
} from "./messaging"
import { retryPrivateMessageWraps } from "./private-message-delivery"
import type { NostrKeySigner } from "./nostr-event-signer"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import type { ResolveInboxDeclarationOptions } from "./private-message-routing"
import type { publishWithPlanner } from "./relay-publish"
import { getOrganizerStockOrderBindings } from "./merchant-order-acceptance-bindings"
import { matchesCheckoutSparkOrderEventMarketSnapshot } from "./checkout-spark-event-market"
import { hasExactMachineRumorBindings } from "./machine-rumor-binding"

const DOMAIN = "conduit:checkout-spark-organizer-recovery:v1"
const HEX_64 = /^[0-9a-f]{64}$/
const hashSchema = z.string().regex(HEX_64)
const timestamp = z.number().int().safe().nonnegative()
const orderBindingSchema = z
  .object({
    identityHash: hashSchema,
    termsHash: hashSchema,
    createdAt: timestamp,
  })
  .strict()
const payloadSchema = z
  .object({
    schemaVersion: z.literal(4),
    type: z.literal("checkout_spark_organizer_recovery"),
    handoffId: hashSchema,
    merchantHandoffId: hashSchema,
    senderPubkey: hashSchema,
    merchantPubkey: hashSchema,
    organizerPubkey: hashSchema,
    preparedAt: timestamp,
    plan: z.unknown(),
    state: z.unknown(),
    wallet: z.unknown(),
    sourceEvents: z.array(z.unknown()).min(1),
    orderBinding: orderBindingSchema,
  })
  .strict()

export type CheckoutSparkOrganizerOrderBinding = z.infer<
  typeof orderBindingSchema
>
export interface CheckoutSparkOrganizerRecoveryPayload extends Omit<
  CheckoutSparkSettledRecoveryPayload,
  "schemaVersion" | "type"
> {
  schemaVersion: 4
  type: "checkout_spark_organizer_recovery"
  merchantHandoffId: string
  organizerPubkey: string
  orderBinding: CheckoutSparkOrganizerOrderBinding
}

export interface CheckoutSparkOrganizerRecoveryProgressPayload extends Omit<
  CheckoutSparkSettledRecoveryProgressPayload,
  "schemaVersion" | "type" | "initialHandoffId"
> {
  schemaVersion: 5
  type: "checkout_spark_organizer_recovery_progress"
  initialHandoffId: string
  initialMerchantHandoffId: string
  merchantProgressHandoffId: string
  organizerPubkey: string
}
export type CheckoutSparkOrganizerRecoveryMessage =
  | CheckoutSparkOrganizerRecoveryPayload
  | CheckoutSparkOrganizerRecoveryProgressPayload
const progressSchema = z
  .object({
    schemaVersion: z.literal(5),
    type: z.literal("checkout_spark_organizer_recovery_progress"),
    handoffId: hashSchema,
    initialHandoffId: hashSchema,
    initialMerchantHandoffId: hashSchema,
    merchantProgressHandoffId: hashSchema,
    senderPubkey: hashSchema,
    merchantPubkey: hashSchema,
    organizerPubkey: hashSchema,
    preparedAt: timestamp,
    plan: z.unknown(),
    state: z.unknown(),
  })
  .strict()

export function createCheckoutSparkOrganizerRecoveryProgressPayload(input: {
  merchantProgress: CheckoutSparkSettledRecoveryProgressPayload
  initialOrganizerHandoffId: string
}): CheckoutSparkOrganizerRecoveryProgressPayload {
  const source = input.merchantProgress
  const merchant = createCheckoutSparkSettledRecoveryProgressPayload({
    initialHandoffId: source.initialHandoffId,
    state: source.state,
    senderPubkey: source.senderPubkey,
    preparedAt: source.preparedAt,
  })
  const binding = merchant.plan.eventMarket
  if (
    merchant.plan.schemaVersion !== 5 ||
    binding?.mode !== "organizer_handoff" ||
    !HEX_64.test(input.initialOrganizerHandoffId) ||
    JSON.stringify(source) !== JSON.stringify(merchant)
  )
    invalid()
  return Object.freeze({
    ...merchant,
    schemaVersion: 5,
    type: "checkout_spark_organizer_recovery_progress",
    handoffId: hash([
      DOMAIN,
      "progress",
      merchant.handoffId,
      binding.organizerPubkey,
      input.initialOrganizerHandoffId,
    ]),
    initialHandoffId: input.initialOrganizerHandoffId,
    initialMerchantHandoffId: merchant.initialHandoffId,
    merchantProgressHandoffId: merchant.handoffId,
    organizerPubkey: binding.organizerPubkey,
  })
}

export function restoreCheckoutSparkOrganizerRecoveryProgressPayload(
  value: unknown
): CheckoutSparkOrganizerRecoveryProgressPayload {
  const parsed = progressSchema.safeParse(value)
  if (!parsed.success) invalid()
  const raw =
    parsed.data as unknown as CheckoutSparkOrganizerRecoveryProgressPayload
  const merchant = createCheckoutSparkSettledRecoveryProgressPayload({
    initialHandoffId: raw.initialMerchantHandoffId,
    state: raw.state,
    senderPubkey: raw.senderPubkey,
    preparedAt: raw.preparedAt,
  })
  const canonical = createCheckoutSparkOrganizerRecoveryProgressPayload({
    merchantProgress: merchant,
    initialOrganizerHandoffId: raw.initialHandoffId,
  })
  if (JSON.stringify(canonical) !== JSON.stringify(value)) invalid()
  return canonical
}

function hash(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
}
function invalid(): never {
  throw new Error("Checkout Spark organizer recovery is invalid.")
}

/** Same canonical order bindings used by the stock journal, without retaining PII. */
export function createCheckoutSparkOrganizerOrderBinding(
  orderInput: OrderSchema
): CheckoutSparkOrganizerOrderBinding {
  const order = orderSchema.parse(orderInput)
  const bindings = getOrganizerStockOrderBindings(order)
  return Object.freeze({
    identityHash: bindings.identityHash,
    termsHash: bindings.termsHash,
    createdAt: order.createdAt,
  })
}

/** Deterministic role-bound identity, not a separate payment or wallet. */
export function deriveCheckoutSparkOrganizerRecoveryHandoffId(input: {
  merchantHandoffId: string
  organizerPubkey: string
  orderBinding: CheckoutSparkOrganizerOrderBinding
}): string {
  return hash([
    DOMAIN,
    input.merchantHandoffId,
    input.organizerPubkey,
    orderBindingSchema.parse(input.orderBinding),
  ])
}

export function checkoutSparkOrganizerRecoveryPayloadDigest(
  payload: CheckoutSparkOrganizerRecoveryMessage
): string {
  return hash(
    payload.schemaVersion === 5
      ? restoreCheckoutSparkOrganizerRecoveryProgressPayload(payload)
      : restoreCheckoutSparkOrganizerRecoveryPayload(payload)
  )
}

/** Validate local draft terms before separately sealing the checkout credential. */
export function createCheckoutSparkOrganizerRecoveryPayload(input: {
  merchantRecovery: CheckoutSparkSettledRecoveryPayload
  order: OrderSchema
}): CheckoutSparkOrganizerRecoveryPayload {
  const merchant = input.merchantRecovery
  const order = orderSchema.parse(input.order)
  const plan = merchant.plan
  const binding = plan.eventMarket
  if (
    plan.schemaVersion !== 5 ||
    !binding ||
    binding.mode !== "organizer_handoff" ||
    order.id !== plan.orderId ||
    order.buyerPubkey !== merchant.senderPubkey ||
    order.merchantPubkey !== plan.merchantPubkey ||
    order.currency !== "SATS" ||
    order.subtotal !== plan.commerceQuote.commerceTotalSats ||
    order.createdAt < plan.createdAt ||
    order.createdAt > merchant.preparedAt ||
    order.items.length !== binding.lines.length ||
    JSON.stringify(order.checkoutSparkPricing) !==
      JSON.stringify(plan.commerceQuote.pricing) ||
    JSON.stringify(order.checkoutSparkPricingAuthority) !==
      JSON.stringify(plan.commerceQuote.pricingAuthority)
  )
    invalid()
  const seen = new Set<string>()
  for (const item of order.items) {
    if (seen.has(item.productId)) invalid()
    seen.add(item.productId)
    const line = plan.commerceQuote.lines.find(
      (candidate) => candidate.productCoordinate === item.productId
    )
    if (
      !line ||
      !matchesCheckoutSparkCommerceOrderLine(item, line) ||
      !matchesCheckoutSparkOrderEventMarketSnapshot(
        item.fulfillment,
        binding,
        item.productId
      )
    )
      invalid()
  }
  const { handoffId: merchantHandoffId, ...initial } = merchant
  return restoreCheckoutSparkOrganizerRecoveryPayload({
    ...initial,
    schemaVersion: 4,
    type: "checkout_spark_organizer_recovery",
    handoffId: deriveCheckoutSparkOrganizerRecoveryHandoffId({
      merchantHandoffId,
      organizerPubkey: binding.organizerPubkey,
      orderBinding: createCheckoutSparkOrganizerOrderBinding(order),
    }),
    merchantHandoffId,
    organizerPubkey: binding.organizerPubkey,
    orderBinding: createCheckoutSparkOrganizerOrderBinding(order),
  })
}

/** Historical decoding verifies original signed sources, not today's clock. */
export function restoreCheckoutSparkOrganizerRecoveryPayload(
  value: unknown
): CheckoutSparkOrganizerRecoveryPayload {
  const parsed = payloadSchema.safeParse(value)
  if (!parsed.success) invalid()
  const candidate = parsed.data
  // Canonicalize through the existing initial-recovery owner; do not introduce
  // another wallet/state decoder or weaken its original preparation bounds.
  const raw = candidate as unknown as CheckoutSparkOrganizerRecoveryPayload
  const merchant = createCheckoutSparkSettledRecoveryPayload({
    state: raw.state,
    senderPubkey: raw.senderPubkey,
    mnemonic: raw.wallet?.mnemonic,
    accountNumber: raw.wallet?.accountNumber,
    preparedAt: raw.preparedAt,
    sourceEvents: raw.sourceEvents,
  })
  const plan = merchant.plan
  const binding = plan.eventMarket
  const orderBinding = Object.freeze({ ...candidate.orderBinding })
  if (
    plan.schemaVersion !== 5 ||
    !binding ||
    binding.mode !== "organizer_handoff" ||
    JSON.stringify(raw.plan) !== JSON.stringify(plan) ||
    JSON.stringify(raw.wallet) !== JSON.stringify(merchant.wallet) ||
    raw.merchantPubkey !== plan.merchantPubkey ||
    raw.organizerPubkey !== binding.organizerPubkey ||
    raw.merchantHandoffId !== merchant.handoffId ||
    raw.organizerPubkey === raw.merchantPubkey ||
    orderBinding.createdAt < plan.createdAt ||
    orderBinding.createdAt > raw.preparedAt ||
    orderBinding.identityHash !==
      hash([plan.orderId, raw.senderPubkey, plan.merchantPubkey]) ||
    raw.handoffId !==
      deriveCheckoutSparkOrganizerRecoveryHandoffId({
        merchantHandoffId: merchant.handoffId,
        organizerPubkey: binding.organizerPubkey,
        orderBinding,
      })
  )
    invalid()
  const sources = canonicalizeCheckoutSparkPlanSourceEvents(
    plan,
    raw.sourceEvents ?? []
  )
  const payload = Object.freeze({
    ...merchant,
    schemaVersion: 4 as const,
    type: "checkout_spark_organizer_recovery" as const,
    handoffId: raw.handoffId,
    merchantHandoffId: merchant.handoffId,
    organizerPubkey: binding.organizerPubkey,
    sourceEvents: sources,
    orderBinding,
  })
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 30 * 1024)
    invalid()
  return payload
}

export function buildCheckoutSparkOrganizerRecoveryRumor(
  value: CheckoutSparkOrganizerRecoveryMessage
): PrivateMessageRumor {
  const payload =
    value.schemaVersion === 5
      ? restoreCheckoutSparkOrganizerRecoveryProgressPayload(value)
      : restoreCheckoutSparkOrganizerRecoveryPayload(value)
  const rumor = {
    pubkey: payload.senderPubkey,
    kind: EVENT_KINDS.ORDER,
    created_at: Math.floor(payload.preparedAt / 1000),
    tags: appendConduitClientTag(
      [
        ["p", payload.organizerPubkey],
        ["type", payload.type],
        ["order", payload.plan.orderId],
        ["checkout", payload.plan.checkoutId],
        ["handoff", payload.handoffId],
      ],
      "market"
    ),
    content: JSON.stringify(payload),
  }
  return { ...rumor, id: getEventHash(rumor) }
}

export function parseCheckoutSparkOrganizerRecoveryRumor(
  rumor: PrivateMessageEvent
): CheckoutSparkOrganizerRecoveryPayload {
  try {
    const payload = restoreCheckoutSparkOrganizerRecoveryPayload(
      JSON.parse(rumor.content)
    )
    const expected = buildCheckoutSparkOrganizerRecoveryRumor(payload)
    if (!hasExactMachineRumorBindings(rumor, expected)) invalid()
    return payload
  } catch {
    return invalid()
  }
}

export function parseCheckoutSparkOrganizerRecoveryProgressRumor(
  rumor: PrivateMessageEvent
): CheckoutSparkOrganizerRecoveryProgressPayload {
  try {
    const payload = restoreCheckoutSparkOrganizerRecoveryProgressPayload(
      JSON.parse(rumor.content)
    )
    const expected = buildCheckoutSparkOrganizerRecoveryRumor(payload)
    if (!hasExactMachineRumorBindings(rumor, expected)) invalid()
    return payload
  } catch {
    return invalid()
  }
}

/** Ciphertext-only retry metadata; this is not an authenticated payment fact. */
export interface CheckoutSparkOrganizerRecoveryDelivery {
  schemaVersion: 1
  handoffId: string
  merchantHandoffId: string
  rumorId: string
  checkoutId: string
  orderId: string
  planDigest: string
  senderPubkey: string
  merchantPubkey: string
  organizerPubkey: string
  preparedAt: number
  signedRecipientWrap: SignedPublicNostrEvent
  acknowledgedRelayRefs: readonly string[]
}

const deliverySchema = z
  .object({
    schemaVersion: z.literal(1),
    handoffId: hashSchema,
    merchantHandoffId: hashSchema,
    rumorId: hashSchema,
    checkoutId: z.string().trim().min(1).max(256),
    orderId: z.string().trim().min(1).max(256),
    planDigest: hashSchema,
    senderPubkey: hashSchema,
    merchantPubkey: hashSchema,
    organizerPubkey: hashSchema,
    preparedAt: timestamp,
    signedRecipientWrap: z.unknown(),
    acknowledgedRelayRefs: z.array(hashSchema).max(64),
  })
  .strict()

function exactWrap(value: unknown, recipient: string): SignedPublicNostrEvent {
  if (!value || typeof value !== "object") invalid()
  const event = value as SignedPublicNostrEvent
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.kind !== EVENT_KINDS.GIFT_WRAP
  )
    invalid()
  const recipients = event.tags.filter((tag) => tag[0] === "p")
  if (
    recipients.length !== 1 ||
    recipients[0]?.length !== 2 ||
    recipients[0]?.[1] !== recipient
  )
    invalid()
  return Object.freeze({
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    sig: event.sig,
    tags: Object.freeze(
      event.tags.map((tag) => Object.freeze([...tag]))
    ) as unknown as string[][],
  })
}

export function restoreCheckoutSparkOrganizerRecoveryDelivery(
  value: unknown
): CheckoutSparkOrganizerRecoveryDelivery {
  const parsed = deliverySchema.safeParse(value)
  if (
    !parsed.success ||
    new Set(parsed.data.acknowledgedRelayRefs).size !==
      parsed.data.acknowledgedRelayRefs.length ||
    parsed.data.organizerPubkey === parsed.data.merchantPubkey
  )
    invalid()
  return Object.freeze({
    ...parsed.data,
    signedRecipientWrap: exactWrap(
      parsed.data.signedRecipientWrap,
      parsed.data.organizerPubkey
    ),
    acknowledgedRelayRefs: Object.freeze(
      [...parsed.data.acknowledgedRelayRefs].sort()
    ),
  })
}

function relayRef(url: string): string {
  const normalized = normalizeSecureOrIsolatedE2eRelayUrls([url])[0]
  if (!normalized) invalid()
  return hash(["conduit:checkout-spark-organizer-relay:v1", normalized])
}

/** Prepare-only recipient record for an atomic multi-recipient outbox commit. */
export function createCheckoutSparkOrganizerRecoveryDelivery(
  input: CheckoutSparkOrganizerRecoveryMessage,
  signedRecipientWrap: SignedPublicNostrEvent
): CheckoutSparkOrganizerRecoveryDelivery {
  const payload =
    input.schemaVersion === 5
      ? restoreCheckoutSparkOrganizerRecoveryProgressPayload(input)
      : restoreCheckoutSparkOrganizerRecoveryPayload(input)
  return restoreCheckoutSparkOrganizerRecoveryDelivery({
    schemaVersion: 1,
    handoffId: payload.handoffId,
    merchantHandoffId:
      payload.schemaVersion === 5
        ? payload.merchantProgressHandoffId
        : payload.merchantHandoffId,
    rumorId: buildCheckoutSparkOrganizerRecoveryRumor(payload).id,
    checkoutId: payload.plan.checkoutId,
    orderId: payload.plan.orderId,
    planDigest: payload.plan.planDigest,
    senderPubkey: payload.senderPubkey,
    merchantPubkey: payload.merchantPubkey,
    organizerPubkey: payload.organizerPubkey,
    preparedAt: payload.preparedAt,
    signedRecipientWrap,
    acknowledgedRelayRefs: [],
  })
}
function acknowledge(
  record: CheckoutSparkOrganizerRecoveryDelivery,
  result: { attemptedRelayUrls: string[]; successfulRelayUrls: string[] }
): CheckoutSparkOrganizerRecoveryDelivery {
  const attempted = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(result.attemptedRelayUrls)
  )
  return restoreCheckoutSparkOrganizerRecoveryDelivery({
    ...record,
    acknowledgedRelayRefs: [
      ...new Set([
        ...record.acknowledgedRelayRefs,
        ...normalizeSecureOrIsolatedE2eRelayUrls(result.successfulRelayUrls)
          .filter((url) => attempted.has(url))
          .map(relayRef),
      ]),
    ],
  })
}

/** Declared-inbox delivery; persist/read back the exact envelope before relay I/O. */
export async function publishCheckoutSparkOrganizerRecovery(input: {
  payload: CheckoutSparkOrganizerRecoveryPayload
  signer: NostrKeySigner
  persistExactWrap: (
    record: CheckoutSparkOrganizerRecoveryDelivery
  ) => Promise<void> | void
  transport?: CheckoutSparkRecoveryTransportOptions
}): Promise<{
  record: CheckoutSparkOrganizerRecoveryDelivery
  canExposeFundingInvoice: true
}> {
  const payload = restoreCheckoutSparkOrganizerRecoveryPayload(input.payload)
  let persisted: CheckoutSparkOrganizerRecoveryDelivery | null = null
  const result = await publishPrivateMessage({
    ...input.transport,
    rumor: buildCheckoutSparkOrganizerRecoveryRumor(payload),
    senderPubkey: payload.senderPubkey,
    recipientPubkey: payload.organizerPubkey,
    signer: input.signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: false,
    signerInteraction: "application_owned",
    onWrapped: async (prepared) => {
      if (prepared.wrappedToSelf) invalid()
      const record = restoreCheckoutSparkOrganizerRecoveryDelivery({
        schemaVersion: 1,
        handoffId: payload.handoffId,
        merchantHandoffId: payload.merchantHandoffId,
        rumorId: prepared.rumorId,
        checkoutId: payload.plan.checkoutId,
        orderId: payload.plan.orderId,
        planDigest: payload.plan.planDigest,
        senderPubkey: payload.senderPubkey,
        merchantPubkey: payload.merchantPubkey,
        organizerPubkey: payload.organizerPubkey,
        preparedAt: payload.preparedAt,
        signedRecipientWrap: prepared.wrappedToRecipient,
        acknowledgedRelayRefs: [],
      })
      await input.persistExactWrap(record)
      persisted = record
    },
  })
  if (!persisted) invalid()
  const record = acknowledge(persisted, result.recipientDelivery)
  // Persist the winning ACK separately; a failed callback never erases the wrap.
  await input.persistExactWrap(record)
  if (record.acknowledgedRelayRefs.length === 0)
    throw new Error("Organizer checkout recovery received no relay ACK.")
  return { record, canExposeFundingInvoice: true }
}

export async function retryCheckoutSparkOrganizerRecovery(input: {
  record: CheckoutSparkOrganizerRecoveryDelivery
  persistExactWrap: (
    record: CheckoutSparkOrganizerRecoveryDelivery
  ) => Promise<void> | void
  recipientInboxRelays?: readonly string[]
  resolveInboxRelays?: (pubkey: string) => Promise<string[]>
  inboxDeclarationOptions?: ResolveInboxDeclarationOptions
  shouldContinue?: () => boolean
  publishFn?: typeof publishWithPlanner
}): Promise<{
  record: CheckoutSparkOrganizerRecoveryDelivery
  canExposeFundingInvoice: boolean
}> {
  let record = restoreCheckoutSparkOrganizerRecoveryDelivery(input.record)
  const result = await retryPrivateMessageWraps({
    rumorId: record.rumorId,
    senderPubkey: record.senderPubkey,
    recipientPubkey: record.organizerPubkey,
    wrappedToRecipient: record.signedRecipientWrap,
    recipientInboxRelays: input.recipientInboxRelays,
    resolveInboxRelays: input.resolveInboxRelays,
    inboxDeclarationOptions: input.inboxDeclarationOptions,
    shouldContinue: input.shouldContinue,
    publishFn: input.publishFn,
    acknowledged: (url) => record.acknowledgedRelayRefs.includes(relayRef(url)),
  })
  if (result.recipientDelivery)
    record = acknowledge(record, result.recipientDelivery)
  await input.persistExactWrap(record)
  return {
    record,
    canExposeFundingInvoice: record.acknowledgedRelayRefs.length > 0,
  }
}

/** Authenticate the exact envelope and role before returning machine plaintext. */
export async function openCheckoutSparkOrganizerRecovery(input: {
  signedRecipientWrap: SignedPublicNostrEvent
  signer: NostrKeySigner
  shouldContinue: () => boolean
}): Promise<{
  payload: CheckoutSparkOrganizerRecoveryPayload
  wrapId: string
  rumorId: string
}> {
  const result = await openCheckoutSparkOrganizerRecoveryMessage(input)
  if (result.payload.schemaVersion !== 4) invalid()
  return { ...result, payload: result.payload }
}

export async function openCheckoutSparkOrganizerRecoveryMessage(input: {
  signedRecipientWrap: SignedPublicNostrEvent
  signer: NostrKeySigner
  shouldContinue: () => boolean
}): Promise<{
  payload: CheckoutSparkOrganizerRecoveryMessage
  wrapId: string
  rumorId: string
}> {
  if (!input.shouldContinue()) invalid()
  const principal = await input.signer.getPublicKey()
  if (!input.shouldContinue()) invalid()
  const wrap = exactWrap(input.signedRecipientWrap, principal)
  const rumor = await unwrapPrivateMessageEnvelope(wrap, input.signer)
  if (
    !input.shouldContinue() ||
    (await input.signer.getPublicKey()) !== principal ||
    !input.shouldContinue()
  )
    invalid()
  const raw: unknown = JSON.parse(rumor.content)
  const payload =
    !!raw &&
    typeof raw === "object" &&
    "schemaVersion" in raw &&
    raw.schemaVersion === 5
      ? parseCheckoutSparkOrganizerRecoveryProgressRumor(rumor)
      : parseCheckoutSparkOrganizerRecoveryRumor(rumor)
  if (payload.organizerPubkey !== principal) invalid()
  return { payload, wrapId: wrap.id, rumorId: rumor.id }
}
