import type { ConduitDB } from "../db"
import type { AccountSigner } from "./nostr-event-signer"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  openCheckoutSparkOrganizerRecoveryMessage,
  type CheckoutSparkOrganizerOrderBinding,
  type CheckoutSparkOrganizerRecoveryPayload,
} from "./checkout-spark-organizer-recovery"
import { validateCheckoutSparkPlanSources } from "./checkout-spark-plan-sources"
import { assertCheckoutSparkSettledRecoveryProgression } from "./checkout-spark-settled-router-repository"
import {
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import { inspectEventMarketStockPacket } from "./event-market-stock-workflow"
import { validateOrganizerStockJournalPool } from "./event-market-stock-journal"
import { getFutureMarketClaimRef } from "./future-market-handoff"
import { parseEventMarketStockAuthorityRumor } from "./event-market-stock-authority"
import { openCheckoutSparkOrganizerExecutionProgress } from "./checkout-spark-organizer-progress"
import type { CheckoutSparkEventMarketBinding } from "./checkout-spark-event-market"

export interface CheckoutSparkOrganizerPurchase {
  readonly handoffId: string
  readonly plan: CheckoutSparkSettledPlan
  readonly orderBinding: CheckoutSparkOrganizerOrderBinding
  readonly claimRef: string
  readonly writerBindings: readonly {
    poolId: string
    writerId: string
    quantity: number
  }[]
}
declare const recoveryAuthorityBrand: unique symbol
/** Authenticated account/session capability, not a persisted grant or paid flag. */
export interface CheckoutSparkOrganizerRecoveryAuthority {
  readonly [recoveryAuthorityBrand]: true
}

type OpenInput = {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  /** Locally selected device incarnation; never adopt an ID from relay history. */
  writerId: string
  initialWrap: SignedPublicNostrEvent
  buyerProgressWraps?: readonly SignedPublicNostrEvent[]
  organizerProgressWraps?: readonly SignedPublicNostrEvent[]
  shouldContinue(): boolean
  now?: () => number
}
type Context = {
  input: OpenInput
  initial: CheckoutSparkOrganizerRecoveryPayload
  state: CheckoutSparkSettledReconciliation
  purchase: CheckoutSparkOrganizerPurchase
  assertCurrent(): void
  expiresAt: number
}
const contexts = new WeakMap<CheckoutSparkOrganizerRecoveryAuthority, Context>()
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function unavailable(): never {
  throw new Error("Exact organizer checkout recovery requires reconciliation.")
}

/** A bounded observation never proves the absence of a later possible send. */
function advance(
  previous: CheckoutSparkSettledReconciliation,
  candidate: CheckoutSparkSettledReconciliation
): CheckoutSparkSettledReconciliation {
  try {
    assertCheckoutSparkSettledRecoveryProgression(previous, candidate)
    return candidate
  } catch {
    assertCheckoutSparkSettledRecoveryProgression(candidate, previous)
    return previous
  }
}

async function assertStockWriters(context: Context): Promise<void> {
  const { input, initial, purchase } = context
  return assertEventMarketOrganizerStockWriters({
    ...input,
    merchantPubkey: initial.merchantPubkey,
    organizerPubkey: initial.organizerPubkey,
    eventMarket: initial.plan.eventMarket!,
    writerBindings: purchase.writerBindings,
    assertCurrent: context.assertCurrent,
  })
}

/** Shared stock-writer check for financial recovery and genuinely free pickup. */
export async function assertEventMarketOrganizerStockWriters(input: {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  merchantPubkey: string
  organizerPubkey: string
  writerId: string
  eventMarket: CheckoutSparkEventMarketBinding
  writerBindings: CheckoutSparkOrganizerPurchase["writerBindings"]
  shouldContinue(): boolean
  assertCurrent(): void
}): Promise<void> {
  const binding = input.eventMarket
  if (
    binding.mode !== "organizer_handoff" ||
    binding.organizerPubkey !== input.organizerPubkey ||
    input.authenticatedPubkey !== input.organizerPubkey ||
    !UUID_V4.test(input.writerId) ||
    input.writerBindings.length !== binding.lines.length ||
    new Set(input.writerBindings.map((row) => row.poolId)).size !==
      input.writerBindings.length
  )
    unavailable()
  for (const writer of input.writerBindings) {
    input.assertCurrent()
    const pool = await input.db.eventMarketOrganizerStockPools.get(
      `${input.organizerPubkey}:${writer.poolId}`
    )
    input.assertCurrent()
    if (
      !pool ||
      pool.accountPubkey !== input.organizerPubkey ||
      pool.organizerPubkey !== input.organizerPubkey ||
      pool.merchantPubkey !== input.merchantPubkey ||
      pool.writerId !== input.writerId ||
      pool.readOnlyRecovery ||
      !pool.receivedEnvelope
    )
      unavailable()
    const grant = validateOrganizerStockJournalPool(pool)
    const line = binding.lines.find((row) => row.stockPoolId === writer.poolId)
    if (
      !line ||
      line.quantity !== writer.quantity ||
      grant.productCoordinate !== line.productCoordinate ||
      grant.assignmentCoordinate !== line.assignmentCoordinate ||
      grant.marketCoordinate !== binding.marketCoordinate ||
      grant.occurrenceCoordinate !== binding.occurrenceCoordinate ||
      grant.merchantPubkey !== input.merchantPubkey ||
      grant.organizerPubkey !== input.organizerPubkey ||
      grant.writerId !== writer.writerId ||
      writer.quantity > grant.quantity
    )
      unavailable()
    // Re-authenticate the Merchant seal, not a plaintext local journal row.
    const packet = await inspectEventMarketStockPacket({
      signer: input.signer,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      envelope: pool.receivedEnvelope,
    })
    input.assertCurrent()
    if (
      !packet ||
      packet.payload.type !== "grant" ||
      packet.rumor.id !== pool.poolId ||
      JSON.stringify(packet.rumor) !== JSON.stringify(pool.grantRumor)
    )
      unavailable()
  }
}

/**
 * Independently authenticate the Buyer recovery and original Merchant stock
 * grants. The UI receives commercial hashes/quantities only. Wallet material
 * stays inside the existing executor's bounded callback below.
 */
export async function openCheckoutSparkOrganizerRecoveryAuthority(
  input: OpenInput
): Promise<CheckoutSparkOrganizerRecoveryAuthority> {
  input = {
    ...input,
    initialWrap: structuredClone(input.initialWrap),
    buyerProgressWraps: structuredClone([...(input.buyerProgressWraps ?? [])]),
    organizerProgressWraps: structuredClone([
      ...(input.organizerProgressWraps ?? []),
    ]),
  }
  const signerRevision = input.signer.revision
  const signerMethod = input.signer.authMethod
  const now = input.now ?? Date.now
  const openedAt = now()
  const assertCurrent = () => {
    if (
      !input.shouldContinue() ||
      !signerRevision ||
      !signerMethod ||
      input.signer.revision !== signerRevision ||
      input.signer.authMethod !== signerMethod ||
      input.signer.pubkey !== input.authenticatedPubkey ||
      !input.signer.capabilities.nip44 ||
      !UUID_V4.test(input.writerId) ||
      !Number.isSafeInteger(now()) ||
      now() < openedAt ||
      now() >= openedAt + 5 * 60_000
    )
      unavailable()
  }
  assertCurrent()
  if (
    input.buyerProgressWraps!.length + input.organizerProgressWraps!.length >
      512 ||
    new TextEncoder().encode(
      JSON.stringify([input.buyerProgressWraps, input.organizerProgressWraps])
    ).length >
      4 * 1024 * 1024
  )
    unavailable()
  const opened = await openCheckoutSparkOrganizerRecoveryMessage({
    signedRecipientWrap: input.initialWrap,
    signer: input.signer,
    shouldContinue: () => {
      assertCurrent()
      return true
    },
  })
  assertCurrent()
  if (opened.payload.schemaVersion !== 4) unavailable()
  const initial = opened.payload
  if (initial.organizerPubkey !== input.authenticatedPubkey) unavailable()
  validateCheckoutSparkPlanSources(initial.plan, initial.sourceEvents ?? [])
  let state = initial.state
  const observations = [] as {
    preparedAt: number
    state: CheckoutSparkSettledReconciliation
  }[]
  for (const wrap of input.buyerProgressWraps!) {
    const update = await openCheckoutSparkOrganizerRecoveryMessage({
      signedRecipientWrap: wrap,
      signer: input.signer,
      shouldContinue: () => {
        assertCurrent()
        return true
      },
    })
    assertCurrent()
    const message = update.payload
    if (
      message.schemaVersion !== 5 ||
      message.initialHandoffId !== initial.handoffId ||
      message.initialMerchantHandoffId !== initial.merchantHandoffId ||
      message.organizerPubkey !== initial.organizerPubkey ||
      message.senderPubkey !== initial.senderPubkey ||
      message.plan.planDigest !== initial.plan.planDigest
    )
      unavailable()
    observations.push(message)
  }
  observations.sort((a, b) => a.preparedAt - b.preparedAt)
  for (const update of observations) state = advance(state, update.state)
  const binding = initial.plan.eventMarket!
  const writerBindings = binding.lines
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
    unavailable()
  for (const wrap of input.organizerProgressWraps!) {
    const progress = await openCheckoutSparkOrganizerExecutionProgress({
      signedRecipientWrap: wrap,
      signer: input.signer,
      shouldContinue: () => {
        assertCurrent()
        return true
      },
    })
    assertCurrent()
    if (
      progress.initialHandoffId !== initial.handoffId ||
      progress.initialMerchantHandoffId !== initial.merchantHandoffId ||
      progress.organizerPubkey !== initial.organizerPubkey ||
      progress.merchantPubkey !== initial.merchantPubkey ||
      progress.state.plan.planDigest !== initial.plan.planDigest ||
      JSON.stringify(progress.orderBinding) !==
        JSON.stringify(initial.orderBinding) ||
      JSON.stringify(progress.writerBindings) !== JSON.stringify(writerBindings)
    )
      unavailable()
    state = advance(state, progress.state)
  }
  const purchase: CheckoutSparkOrganizerPurchase = Object.freeze({
    handoffId: initial.handoffId,
    plan: initial.plan,
    orderBinding: initial.orderBinding,
    claimRef: getFutureMarketClaimRef({
      orderId: initial.plan.orderId,
      merchantPubkey: initial.merchantPubkey,
      organizerPubkey: initial.organizerPubkey,
      marketCoordinate: binding.marketCoordinate,
    }),
    writerBindings: Object.freeze(
      writerBindings.map((row) => Object.freeze(row))
    ),
  })
  const context: Context = {
    input,
    initial,
    state,
    purchase,
    assertCurrent,
    expiresAt: openedAt + 5 * 60_000,
  }
  await assertStockWriters(context)
  assertCurrent()
  const authority = Object.freeze({}) as CheckoutSparkOrganizerRecoveryAuthority
  contexts.set(authority, context)
  return authority
}

/** A raw/restored payload or a serialized capability grants no stock authority. */
export function assertCheckoutSparkOrganizerRecoveryAuthority(
  authority: CheckoutSparkOrganizerRecoveryAuthority
): CheckoutSparkOrganizerPurchase {
  const context = contexts.get(authority)
  if (!context) unavailable()
  context.assertCurrent()
  return structuredClone(context.purchase)
}

/**
 * Spend-capable consumption requires the designated writer's whole-order stock
 * reservation first. No Merchant dispatch alias or account wallet is involved.
 * The callback must reconcile every possible send with the shared executor.
 */
export async function withCheckoutSparkOrganizerRecovery<T>(
  authority: CheckoutSparkOrganizerRecoveryAuthority,
  consume: (input: {
    initial: CheckoutSparkOrganizerRecoveryPayload
    state: CheckoutSparkSettledReconciliation
    purchase: CheckoutSparkOrganizerPurchase
    assertCurrent(): void
  }) => Promise<T>
): Promise<T> {
  const context = contexts.get(authority)
  if (!context) unavailable()
  await assertCheckoutSparkOrganizerRecoveryWriterCurrent(authority)
  return consume({
    initial: context.initial,
    state: restoreCheckoutSparkSettledReconciliation(context.state),
    purchase: structuredClone(context.purchase),
    assertCurrent: context.assertCurrent,
  })
}

/** Recheck the actual stock owner and whole-order manifest at provider boundaries. */
export async function assertCheckoutSparkOrganizerRecoveryWriterCurrent(
  authority: CheckoutSparkOrganizerRecoveryAuthority
): Promise<void> {
  const context = contexts.get(authority)
  if (!context) unavailable()
  context.assertCurrent()
  if ((context.input.now ?? Date.now)() < context.initial.plan.takeoverAt)
    throw new Error("Buyer routing is still active for this checkout.")
  await assertStockWriters(context)
  const rows = await context.input.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(context.initial.organizerPubkey)
    .filter((entry) => entry.orderId === context.initial.plan.orderId)
    .toArray()
  context.assertCurrent()
  const manifest = JSON.stringify(context.purchase.writerBindings)
  if (
    rows.length !== context.purchase.writerBindings.length ||
    rows.some((entry) => {
      const accepted = parseEventMarketStockAuthorityRumor(entry.rumor)
      const writer = context.purchase.writerBindings.find(
        (row) => row.poolId === entry.poolId
      )
      return (
        !writer ||
        accepted.type !== "accepted" ||
        accepted.poolId !== entry.poolId ||
        accepted.orderId !== context.initial.plan.orderId ||
        accepted.organizerPubkey !== context.initial.organizerPubkey ||
        accepted.merchantPubkey !== context.initial.merchantPubkey ||
        accepted.writerId !== writer.writerId ||
        accepted.identityBinding !==
          context.initial.orderBinding.identityHash ||
        accepted.termsBinding !== context.initial.orderBinding.termsHash ||
        accepted.quantity !== writer.quantity ||
        accepted.claimRef !== context.purchase.claimRef ||
        entry.quantity !== writer.quantity ||
        entry.claimRef !== context.purchase.claimRef ||
        entry.orderPoolBinding !== manifest ||
        !entry.evidence
      )
    })
  )
    throw new Error("Reserve this complete organizer order before routing.")
}
