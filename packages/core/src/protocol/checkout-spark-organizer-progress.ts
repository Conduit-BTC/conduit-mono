import { z } from "zod"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { getEventHash } from "nostr-tools"
import { hasExactMachineRumorBindings } from "./machine-rumor-binding"
import { ConduitDB, db } from "../db"
import { createCheckoutSparkMerchantProgress } from "./checkout-spark-merchant-progress"
import type { CheckoutSparkOrganizerOrderBinding } from "./checkout-spark-organizer-recovery"
import {
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  publishPrivateMessage,
  unwrapPrivateMessageEnvelope,
  type PrivateMessageEvent,
  type PrivateMessageRumor,
  type PublishPrivateMessageInput,
} from "./messaging"
import { retryPrivateMessageWraps } from "./private-message-delivery"
import type { NostrKeySigner } from "./nostr-event-signer"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const time = z.number().int().safe().nonnegative()
const writerSchema = z
  .object({
    poolId: hashSchema,
    writerId: z.string().uuid(),
    quantity: z.number().int().positive().max(2_147_483_647),
  })
  .strict()
const bindingSchema = z
  .object({
    identityHash: hashSchema,
    termsHash: hashSchema,
    createdAt: time,
  })
  .strict()
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal("checkout_spark_organizer_execution"),
    snapshotId: hashSchema,
    initialHandoffId: hashSchema,
    initialMerchantHandoffId: hashSchema,
    organizerPubkey: hashSchema,
    merchantPubkey: hashSchema,
    recordedAt: time,
    orderBinding: bindingSchema,
    writerBindings: z.array(writerSchema).min(1).max(64),
    state: z.unknown(),
  })
  .strict()

export interface CheckoutSparkOrganizerExecutionProgress {
  schemaVersion: 1
  type: "checkout_spark_organizer_execution"
  snapshotId: string
  initialHandoffId: string
  initialMerchantHandoffId: string
  organizerPubkey: string
  merchantPubkey: string
  recordedAt: number
  orderBinding: CheckoutSparkOrganizerOrderBinding
  writerBindings: readonly {
    poolId: string
    writerId: string
    quantity: number
  }[]
  state: CheckoutSparkSettledReconciliation
}
function invalid(): never {
  throw new Error("Organizer checkout progress requires reconciliation.")
}
const hash = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))

/** Machine progress only, never a Merchant-authored receipt or payment proof. */
export function createCheckoutSparkOrganizerExecutionProgress(input: {
  initialHandoffId: string
  initialMerchantHandoffId: string
  organizerPubkey: string
  orderBinding: CheckoutSparkOrganizerOrderBinding
  writerBindings: CheckoutSparkOrganizerExecutionProgress["writerBindings"]
  state: CheckoutSparkSettledReconciliation
}): CheckoutSparkOrganizerExecutionProgress {
  const canonical = createCheckoutSparkMerchantProgress({
    initialHandoffId: input.initialMerchantHandoffId,
    state: input.state,
  })
  const { state } = canonical
  const binding = state.plan.eventMarket
  const writerBindings = [...input.writerBindings]
    .map((row) => writerSchema.parse(row))
    .sort((a, b) => a.poolId.localeCompare(b.poolId))
  if (
    !hashSchema.safeParse(input.initialHandoffId).success ||
    state.plan.schemaVersion !== 5 ||
    binding?.mode !== "organizer_handoff" ||
    binding.organizerPubkey !== input.organizerPubkey ||
    new Set(writerBindings.map((row) => row.poolId)).size !==
      writerBindings.length ||
    writerBindings.length !== binding.lines.length ||
    writerBindings.some(
      (row) =>
        !binding.lines.some(
          (line) =>
            line.stockPoolId === row.poolId && line.quantity === row.quantity
        )
    )
  )
    invalid()
  const base = {
    schemaVersion: 1 as const,
    type: "checkout_spark_organizer_execution" as const,
    initialHandoffId: input.initialHandoffId,
    initialMerchantHandoffId: input.initialMerchantHandoffId,
    organizerPubkey: input.organizerPubkey,
    merchantPubkey: state.plan.merchantPubkey,
    recordedAt: state.updatedAt,
    orderBinding: bindingSchema.parse(input.orderBinding),
    writerBindings,
    state,
  }
  if (
    base.orderBinding.createdAt < state.plan.createdAt ||
    base.orderBinding.createdAt >= state.plan.takeoverAt
  )
    invalid()
  return Object.freeze({
    ...base,
    snapshotId: hash(["conduit:checkout-spark-organizer-execution:v1", base]),
  })
}

export function parseCheckoutSparkOrganizerExecutionProgress(
  value: unknown
): CheckoutSparkOrganizerExecutionProgress {
  const parsed = payloadSchema.safeParse(value)
  if (!parsed.success) invalid()
  const canonical = createCheckoutSparkOrganizerExecutionProgress({
    ...parsed.data,
    state: parsed.data.state as CheckoutSparkSettledReconciliation,
  })
  // Compare canonical values, not caller field insertion order.
  if (
    JSON.stringify({ ...parsed.data, state: canonical.state }) !==
      JSON.stringify(payloadSchema.parse(canonical)) ||
    JSON.stringify(parsed.data.state) !== JSON.stringify(canonical.state)
  )
    invalid()
  return canonical
}

export function buildCheckoutSparkOrganizerExecutionRumor(
  input: CheckoutSparkOrganizerExecutionProgress
): PrivateMessageRumor {
  const payload = parseCheckoutSparkOrganizerExecutionProgress(input)
  const rumor = {
    kind: 16,
    pubkey: payload.organizerPubkey,
    created_at: Math.floor(payload.recordedAt / 1000),
    tags: [
      ["p", payload.merchantPubkey],
      ["type", payload.type],
      ["order", payload.state.plan.orderId],
    ],
    content: JSON.stringify(payload),
  }
  return { ...rumor, id: getEventHash(rumor) }
}

export async function openCheckoutSparkOrganizerExecutionProgress(input: {
  signedRecipientWrap: SignedPublicNostrEvent
  signer: NostrKeySigner
  shouldContinue(): boolean
}): Promise<CheckoutSparkOrganizerExecutionProgress> {
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
  const payload = parseCheckoutSparkOrganizerExecutionRumor(rumor)
  if (![payload.organizerPubkey, payload.merchantPubkey].includes(principal))
    invalid()
  return payload
}

export function parseCheckoutSparkOrganizerExecutionRumor(
  rumor: PrivateMessageEvent
): CheckoutSparkOrganizerExecutionProgress {
  const payload = parseCheckoutSparkOrganizerExecutionProgress(
    JSON.parse(rumor.content)
  )
  const expected = buildCheckoutSparkOrganizerExecutionRumor(payload)
  if (!hasExactMachineRumorBindings(rumor, expected)) invalid()
  return payload
}

function exactWrap(value: unknown, recipient: string): SignedPublicNostrEvent {
  const wrap = value as SignedPublicNostrEvent
  if (
    !isValidSignedPublicNostrEvent(wrap) ||
    wrap.kind !== 1059 ||
    JSON.stringify(wrap.tags.filter((tag) => tag[0] === "p")) !==
      JSON.stringify([["p", recipient]]) ||
    wrap.tags.some((tag) => tag[0] === "expiration")
  )
    invalid()
  return structuredClone(wrap)
}
export interface CheckoutSparkOrganizerProgressDelivery {
  schemaVersion: 1
  organizerPubkey: string
  merchantPubkey: string
  checkoutId: string
  planDigest: string
  snapshotId: string
  initialHandoffId: string
  rumorId: string
  recordedAt: number
  merchantWrap: SignedPublicNostrEvent
  selfWrap: SignedPublicNostrEvent
  merchantAccepted: boolean
  selfAccepted: boolean
}
const deliverySchema = z
  .object({
    schemaVersion: z.literal(1),
    organizerPubkey: hashSchema,
    merchantPubkey: hashSchema,
    checkoutId: z.string().trim().min(1).max(512),
    planDigest: hashSchema,
    snapshotId: hashSchema,
    initialHandoffId: hashSchema,
    rumorId: hashSchema,
    recordedAt: time,
    merchantWrap: z.unknown(),
    selfWrap: z.unknown(),
    merchantAccepted: z.boolean(),
    selfAccepted: z.boolean(),
  })
  .strict()
function delivery(value: unknown): CheckoutSparkOrganizerProgressDelivery {
  const parsed = deliverySchema.parse(value)
  return {
    ...parsed,
    merchantWrap: exactWrap(parsed.merchantWrap, parsed.merchantPubkey),
    selfWrap: exactWrap(parsed.selfWrap, parsed.organizerPubkey),
  }
}
export interface CheckoutSparkOrganizerProgressStore {
  load(
    organizer: string,
    checkoutId: string,
    planDigest: string,
    snapshotId: string
  ): Promise<CheckoutSparkOrganizerProgressDelivery | null>
  stage(
    record: CheckoutSparkOrganizerProgressDelivery,
    assertCurrent: () => void
  ): Promise<CheckoutSparkOrganizerProgressDelivery>
  markAccepted(
    record: CheckoutSparkOrganizerProgressDelivery,
    assertCurrent: () => void
  ): Promise<CheckoutSparkOrganizerProgressDelivery>
}

/** Ciphertext only in the existing checkout binding; no additional database. */
export class DexieCheckoutSparkOrganizerProgressRepository implements CheckoutSparkOrganizerProgressStore {
  constructor(private readonly database: ConduitDB = db) {}
  private async bound(
    organizer: string,
    checkoutId: string,
    planDigest: string
  ) {
    const binding =
      await this.database.checkoutSparkPlanBindings.get(checkoutId)
    const active =
      await this.database.checkoutSparkReconciliations.get(checkoutId)
    const retired = await this.database.checkoutSparkRetirements.get(checkoutId)
    if (
      !binding ||
      !active ||
      retired ||
      binding.planDigest !== planDigest ||
      active.state.schemaVersion !== 6
    )
      invalid()
    const state = restoreCheckoutSparkSettledReconciliation(active.state)
    if (
      state.plan.schemaVersion !== 5 ||
      state.plan.planDigest !== planDigest ||
      state.plan.eventMarket?.mode !== "organizer_handoff" ||
      state.plan.eventMarket.organizerPubkey !== organizer
    )
      invalid()
    const raw = binding.organizerProgressOutbox ?? []
    if (!Array.isArray(raw) || raw.length > 512) invalid()
    const entries = raw.map(delivery)
    if (
      new Set(entries.map((row) => row.snapshotId)).size !== entries.length ||
      entries.some(
        (row) =>
          row.organizerPubkey !== organizer ||
          row.checkoutId !== checkoutId ||
          row.planDigest !== planDigest ||
          row.merchantPubkey !== state.plan.merchantPubkey
      )
    )
      invalid()
    return { binding, entries }
  }
  async load(
    organizer: string,
    checkoutId: string,
    planDigest: string,
    snapshotId: string
  ) {
    return this.database.transaction(
      "r",
      [
        this.database.checkoutSparkPlanBindings,
        this.database.checkoutSparkReconciliations,
        this.database.checkoutSparkRetirements,
      ],
      async () => {
        const { entries } = await this.bound(organizer, checkoutId, planDigest)
        return entries.find((entry) => entry.snapshotId === snapshotId) ?? null
      }
    )
  }
  async list(organizer: string, checkoutId: string, planDigest: string) {
    return this.database.transaction(
      "r",
      [
        this.database.checkoutSparkPlanBindings,
        this.database.checkoutSparkReconciliations,
        this.database.checkoutSparkRetirements,
      ],
      async () => (await this.bound(organizer, checkoutId, planDigest)).entries
    )
  }
  async stage(
    value: CheckoutSparkOrganizerProgressDelivery,
    assertCurrent: () => void
  ) {
    const record = delivery(value)
    assertCurrent()
    return this.database.transaction(
      "rw",
      [
        this.database.checkoutSparkPlanBindings,
        this.database.checkoutSparkReconciliations,
        this.database.checkoutSparkRetirements,
      ],
      async () => {
        const { binding, entries } = await this.bound(
          record.organizerPubkey,
          record.checkoutId,
          record.planDigest
        )
        assertCurrent()
        const prior = entries.find(
          (entry) => entry.snapshotId === record.snapshotId
        )
        if (prior) {
          if (
            JSON.stringify({
              ...prior,
              merchantAccepted: false,
              selfAccepted: false,
            }) !==
            JSON.stringify({
              ...record,
              merchantAccepted: false,
              selfAccepted: false,
            })
          )
            invalid()
          return prior
        }
        if (
          entries.length >= 512 ||
          record.merchantAccepted ||
          record.selfAccepted
        )
          invalid()
        await this.database.checkoutSparkPlanBindings.put({
          ...binding,
          organizerProgressOutbox: [...entries, record],
        })
        assertCurrent()
        const saved = (
          await this.bound(
            record.organizerPubkey,
            record.checkoutId,
            record.planDigest
          )
        ).entries.find((entry) => entry.snapshotId === record.snapshotId)
        if (!saved || JSON.stringify(saved) !== JSON.stringify(record))
          invalid()
        return saved
      }
    )
  }
  async markAccepted(
    value: CheckoutSparkOrganizerProgressDelivery,
    assertCurrent: () => void
  ) {
    const record = delivery(value)
    assertCurrent()
    return this.database.transaction(
      "rw",
      [
        this.database.checkoutSparkPlanBindings,
        this.database.checkoutSparkReconciliations,
        this.database.checkoutSparkRetirements,
      ],
      async () => {
        const { binding, entries } = await this.bound(
          record.organizerPubkey,
          record.checkoutId,
          record.planDigest
        )
        assertCurrent()
        const prior = entries.find(
          (entry) => entry.snapshotId === record.snapshotId
        )
        if (
          !prior ||
          JSON.stringify({
            ...prior,
            merchantAccepted: false,
            selfAccepted: false,
          }) !==
            JSON.stringify({
              ...record,
              merchantAccepted: false,
              selfAccepted: false,
            })
        )
          invalid()
        const next = {
          ...prior,
          merchantAccepted: prior.merchantAccepted || record.merchantAccepted,
          selfAccepted: prior.selfAccepted || record.selfAccepted,
        }
        await this.database.checkoutSparkPlanBindings.put({
          ...binding,
          organizerProgressOutbox: entries.map((entry) =>
            entry.snapshotId === next.snapshotId ? next : entry
          ),
        })
        assertCurrent()
        return next
      }
    )
  }
}
export type CheckoutSparkOrganizerProgressTransport = Pick<
  PublishPrivateMessageInput,
  | "publishFn"
  | "resolveInboxRelays"
  | "recipientInboxRelays"
  | "giftWrapFn"
  | "deliveryStore"
  | "accountNetworkLocalStateRepository"
  | "inboxDeclarationEvidenceRepository"
>
const accepted = (
  result: { attemptedRelayUrls: string[]; successfulRelayUrls: string[] } | null
) => {
  if (!result) return false
  const attempted = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(result.attemptedRelayUrls)
  )
  return normalizeSecureOrIsolatedE2eRelayUrls(result.successfulRelayUrls).some(
    (url) => attempted.has(url)
  )
}

/** Both copies are saved atomically before either is sent; retries never rewrap. */
export async function publishCheckoutSparkOrganizerExecutionProgress(input: {
  payload: CheckoutSparkOrganizerExecutionProgress
  signer: NostrKeySigner
  store: CheckoutSparkOrganizerProgressStore
  shouldContinue(): boolean
  transport?: CheckoutSparkOrganizerProgressTransport
}): Promise<CheckoutSparkOrganizerProgressDelivery> {
  const payload = parseCheckoutSparkOrganizerExecutionProgress(input.payload)
  const rumor = buildCheckoutSparkOrganizerExecutionRumor(payload)
  const assertCurrent = () => {
    if (!input.shouldContinue()) invalid()
  }
  assertCurrent()
  if ((await input.signer.getPublicKey()) !== payload.organizerPubkey) invalid()
  assertCurrent()
  const bound = (value: CheckoutSparkOrganizerProgressDelivery) => {
    const record = delivery(value)
    if (
      record.organizerPubkey !== payload.organizerPubkey ||
      record.merchantPubkey !== payload.merchantPubkey ||
      record.checkoutId !== payload.state.plan.checkoutId ||
      record.planDigest !== payload.state.plan.planDigest ||
      record.snapshotId !== payload.snapshotId ||
      record.initialHandoffId !== payload.initialHandoffId ||
      record.rumorId !== rumor.id ||
      record.recordedAt !== payload.recordedAt
    )
      invalid()
    return record
  }
  const existing = await input.store.load(
    payload.organizerPubkey,
    payload.state.plan.checkoutId,
    payload.state.plan.planDigest,
    payload.snapshotId
  )
  assertCurrent()
  let record = existing ? bound(existing) : null
  if (!record) {
    // The normal private-message owner completes both wraps, then invokes this
    // atomic stage callback before any relay I/O. A throw retains exact bytes.
    const result = await publishPrivateMessage({
      ...input.transport,
      rumor,
      senderPubkey: payload.organizerPubkey,
      recipientPubkey: payload.merchantPubkey,
      accountPubkey: payload.organizerPubkey,
      authenticatedPubkey: payload.organizerPubkey,
      signer: input.signer,
      signerInteraction: "external",
      rumorKind: 16,
      selfCopy: true,
      requireSelfWrap: true,
      shouldContinue: input.shouldContinue,
      onWrapped: async (prepared) => {
        assertCurrent()
        if (!prepared.wrappedToSelf) invalid()
        const exact = delivery({
          schemaVersion: 1,
          organizerPubkey: payload.organizerPubkey,
          merchantPubkey: payload.merchantPubkey,
          checkoutId: payload.state.plan.checkoutId,
          planDigest: payload.state.plan.planDigest,
          snapshotId: payload.snapshotId,
          initialHandoffId: payload.initialHandoffId,
          rumorId: rumor.id,
          recordedAt: payload.recordedAt,
          merchantWrap: prepared.wrappedToRecipient,
          selfWrap: prepared.wrappedToSelf,
          merchantAccepted: false,
          selfAccepted: false,
        })
        record = bound(await input.store.stage(exact, assertCurrent))
        if (JSON.stringify(record) !== JSON.stringify(exact)) invalid()
        assertCurrent()
      },
    })
    assertCurrent()
    if (!record) invalid()
    record = bound(
      await input.store.markAccepted(
        {
          ...bound(record),
          merchantAccepted: accepted(result.recipientDelivery),
          selfAccepted: accepted(result.selfDelivery),
        },
        assertCurrent
      )
    )
  } else if (!record.merchantAccepted || !record.selfAccepted) {
    const result = await retryPrivateMessageWraps({
      ...input.transport,
      rumorId: record.rumorId,
      senderPubkey: record.organizerPubkey,
      recipientPubkey: record.merchantPubkey,
      accountPubkey: record.organizerPubkey,
      authenticatedPubkey: record.organizerPubkey,
      wrappedToRecipient: record.merchantWrap,
      wrappedToSelf: record.selfWrap,
      shouldContinue: input.shouldContinue,
    })
    assertCurrent()
    record = bound(
      await input.store.markAccepted(
        {
          ...record,
          merchantAccepted:
            record.merchantAccepted || accepted(result.recipientDelivery),
          selfAccepted: record.selfAccepted || accepted(result.selfDelivery),
        },
        assertCurrent
      )
    )
  }
  assertCurrent()
  return record
}
