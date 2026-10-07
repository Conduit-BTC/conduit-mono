import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { checkoutSparkCommerceQuoteDigestValue } from "./checkout-spark-commerce-pricing"
import {
  freezeCheckoutSparkReceiverBinding,
  normalizeCheckoutSparkReceiverAddress,
  type CheckoutSparkReceiverBinding,
} from "./checkout-spark-receiver-capability"
import {
  checkoutSparkMerchantPublicZapPolicyDigestValue,
  freezeCheckoutSparkMerchantPublicZapPolicy,
  restoreCheckoutSparkPublicZapContext,
  type CheckoutSparkMerchantPublicZapPolicy,
  type CheckoutSparkPublicZapContext,
} from "./checkout-spark-public-zap"
import {
  assertCheckoutSparkSettledReturnedProof,
  restoreCheckoutSparkSettledReturnClosure,
  type CheckoutSparkSettledReturnedProof,
  type CheckoutSparkSettledReturnClosure,
} from "./checkout-spark-settled-returned"
import { checkoutSparkProviderSendWindowEndsAt } from "./checkout-spark-invoice-expiry"
import {
  createCheckoutSparkNativeTreasuryFinalization,
  restoreCheckoutSparkNativeTreasuryFinalization,
  restoreCheckoutSparkNativeTreasuryPlan,
  type CheckoutSparkNativeTreasuryFinalization,
  type CheckoutSparkNativeTreasuryPlan,
} from "./checkout-spark-treasury-finalization"
import {
  assertCheckoutSparkMerchantPayoutRecipient,
  freezeCheckoutSparkCommerceQuote,
  type CheckoutSparkCommerceQuote,
  type CheckoutSparkNetwork,
  type CheckoutSparkObligationKind,
  type CheckoutSparkRetirementAssessment,
  type CheckoutSparkRetirementEvidence,
  type CheckoutSparkRetirementPendingReason,
  type CheckoutSparkRetirementTombstone,
} from "./checkout-spark-reconciliation"
import {
  allocateCheckoutSparkSettledSats,
  calculateCheckoutSparkAllocationWeights,
  calculateCheckoutSparkSettledGrossFundingSats,
} from "./checkout-spark-settled-allocation"
import {
  checkoutSparkConduitFeeRecipient,
  type CheckoutSparkConduitDestinationPolicy,
} from "./checkout-spark-router-obligations"
import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  isValidLightningInvoice,
  normalizeLightningInvoice,
} from "./lightning"

const PLAN_DOMAIN = "conduit:checkout-spark-settled-plan:v3"
const LEG_DOMAIN = "conduit:checkout-spark-settled-leg:v3"
const TRANSFER_DOMAIN = "conduit:checkout-spark-settled-transfer:v3"
const INTENT_REVIEW_DOMAIN = "conduit:checkout-spark-settled-intent-review:v3"
const HEX_64 = /^[0-9a-f]{64}$/
const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/
const MAX_ID_LENGTH = 512
const MAX_REQUEST_LENGTH = 16_384

export type CheckoutSparkSettledDestinationSource =
  | {
      readonly type: "signed_profile"
      readonly profileEventId: string
      readonly profileEventCreatedAt: number
    }
  | {
      readonly type: "conduit_allowlist"
      readonly policy: CheckoutSparkConduitDestinationPolicy
    }

export interface CheckoutSparkSettledDestination {
  readonly type: "lightning_address"
  readonly value: string
  readonly source: CheckoutSparkSettledDestinationSource
}

export interface CheckoutSparkSettledRecipientInput {
  readonly kind: CheckoutSparkObligationKind
  readonly recipientId: string
  readonly destination: CheckoutSparkSettledDestination
  readonly weightSats: number
}

export interface CheckoutSparkSettledRecipient extends CheckoutSparkSettledRecipientInput {
  readonly position: number
  readonly legId: string
}

export interface CheckoutSparkSettledFundingPlan {
  readonly requestId: string
  readonly paymentRequest: string
  readonly paymentHash: string
  readonly receiverIdentityPublicKey: string
  readonly grossFundingSats: number
  readonly createdAt: number
  readonly expiresAt: number
}

export interface FreezeCheckoutSparkSettledPlanInput {
  readonly checkoutId: string
  readonly orderId: string
  readonly merchantPubkey: string
  readonly walletId: string
  readonly network: CheckoutSparkNetwork
  readonly createdAt: number
  readonly takeoverAt: number
  readonly commerceQuote: CheckoutSparkCommerceQuote
  readonly funding: CheckoutSparkSettledFundingPlan
  readonly recipients: readonly CheckoutSparkSettledRecipientInput[]
  readonly merchantPublicZapPolicy?: CheckoutSparkMerchantPublicZapPolicy
}

/** V3 freezes identities, endpoints and weights, but no outgoing invoice. */
export interface CheckoutSparkSettledPlan extends FreezeCheckoutSparkSettledPlanInput {
  readonly schemaVersion: 3 | 4
  readonly nativeTreasury?: CheckoutSparkNativeTreasuryPlan
  readonly planDigest: string
  readonly recipients: readonly CheckoutSparkSettledRecipient[]
}

export interface CheckoutSparkSettledCreditEvidence {
  readonly requestId: string
  readonly paymentHash: string
  readonly transferId: string
  readonly receiverIdentityPublicKey: string
  readonly grossSats: number
  readonly creditedSats: number
  readonly observedAt: number
}

export interface CheckoutSparkSettledLegIntentInput {
  readonly legId: string
  readonly transferId: string
  readonly paymentRequest: string
  readonly paymentHash: string
  readonly invoiceAmountSats: number
  readonly maxFeeSats: number
  readonly preparedAt: number
  readonly publicZap?: CheckoutSparkPublicZapContext
  readonly receiverBinding?: CheckoutSparkReceiverBinding
}

export type CheckoutSparkSettledLegStatus =
  | "unprepared"
  | "prepared"
  | "submitted"
  | "ambiguous"
  | "lookup_unavailable"
  | "conflicting_evidence"
  | "paid"
  | "terminal_failure"

export interface CheckoutSparkSettledLegProgress {
  readonly legId: string
  /** Null until one exact provider receive has been proved. */
  readonly allocationSats: number | null
  readonly intent: CheckoutSparkSettledLegIntentInput | null
  readonly status: CheckoutSparkSettledLegStatus
  readonly observedAt: number | null
  readonly finalFeeSats: number | null
  readonly finalDebitSats: number | null
  readonly generation?: 0 | 1
  readonly closedGenerations?: readonly CheckoutSparkSettledClosedGeneration[]
}

export interface CheckoutSparkSettledClosedGeneration {
  readonly generation: 0
  readonly intent: CheckoutSparkSettledLegIntentInput
  readonly status: Exclude<CheckoutSparkSettledLegStatus, "unprepared" | "paid">
  readonly observedAt: number
  readonly finalFeeSats: null
  readonly finalDebitSats: null
  readonly closure: CheckoutSparkSettledReturnClosure
}

export interface CheckoutSparkSettledReconciliation {
  readonly schemaVersion: 3 | 4 | 5
  readonly treasuryFinalization?: CheckoutSparkNativeTreasuryFinalization
  readonly plan: CheckoutSparkSettledPlan
  /** Exact invoice-attributed credit; never a wallet-balance inference. */
  readonly credit: CheckoutSparkSettledCreditEvidence | null
  readonly legs: readonly CheckoutSparkSettledLegProgress[]
  readonly updatedAt: number
}

export interface CheckoutSparkSettledLegEvidence {
  readonly legId: string
  readonly transferId: string
  readonly paymentHash: string
  readonly status: Exclude<
    CheckoutSparkSettledLegStatus,
    "unprepared" | "prepared"
  >
  readonly observedAt: number
  /** Required for paid; actual provider fee, not a route estimate. */
  readonly finalFeeSats?: number
  /** Required for paid; exact provider transfer debit, not a balance delta. */
  readonly finalDebitSats?: number
}

function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
}

function text(value: string, label: string, limit = MAX_ID_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function hex(value: string, label: string): string {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function compressedPublicKey(value: string, label: string): string {
  if (typeof value !== "string" || !COMPRESSED_PUBKEY.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function sats(value: number, label: string, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function time(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function normalizeInvoice(input: {
  paymentRequest: string
  paymentHash: string
  amountSats: number
  network: CheckoutSparkNetwork
  at: number
}): { paymentRequest: string; paymentHash: string; expiresAt: number } {
  const paymentRequest = text(
    normalizeLightningInvoice(input.paymentRequest).toLowerCase(),
    "Checkout Spark invoice",
    MAX_REQUEST_LENGTH
  )
  if (
    !isValidLightningInvoice(paymentRequest) ||
    getLightningInvoiceNetwork(paymentRequest) !== input.network
  ) {
    throw new Error("Checkout Spark invoice network or signature is invalid.")
  }
  const metadata = decodeLightningInvoiceMetadata(paymentRequest)
  const expectedMsats = BigInt(input.amountSats) * 1_000n
  const expiresAt =
    metadata.expiresAt === null ? null : metadata.expiresAt * 1_000
  const paymentHash = hex(input.paymentHash, "Checkout Spark invoice hash")
  if (
    expectedMsats > BigInt(Number.MAX_SAFE_INTEGER) ||
    metadata.msats !== Number(expectedMsats) ||
    decodeLightningInvoicePaymentHash(paymentRequest) !== paymentHash ||
    expiresAt === null ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= input.at
  ) {
    throw new Error(
      "Checkout Spark invoice amount, hash, or expiry is invalid."
    )
  }
  return { paymentRequest, paymentHash, expiresAt }
}

function uuidFromDigest(value: string): string {
  const bytes = Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  )
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const encoded = bytesToHex(bytes)
  return [
    encoded.slice(0, 8),
    encoded.slice(8, 12),
    encoded.slice(12, 16),
    encoded.slice(16, 20),
    encoded.slice(20),
  ].join("-")
}

function canonicalPlanValue(
  plan: Omit<CheckoutSparkSettledPlan, "planDigest">
): unknown {
  return [
    plan.schemaVersion === 4
      ? "conduit:checkout-spark-settled-plan:v4"
      : PLAN_DOMAIN,
    plan.schemaVersion,
    plan.checkoutId,
    plan.orderId,
    plan.merchantPubkey,
    plan.walletId,
    plan.network,
    plan.createdAt,
    plan.takeoverAt,
    checkoutSparkCommerceQuoteDigestValue(plan.commerceQuote),
    [
      plan.funding.requestId,
      plan.funding.paymentRequest,
      plan.funding.paymentHash,
      plan.funding.receiverIdentityPublicKey,
      plan.funding.grossFundingSats,
      plan.funding.createdAt,
      plan.funding.expiresAt,
    ],
    plan.recipients.map((recipient) => [
      recipient.position,
      recipient.legId,
      recipient.kind,
      recipient.recipientId,
      recipient.destination.type,
      recipient.destination.value,
      recipient.destination.source.type === "signed_profile"
        ? [
            "signed_profile",
            recipient.destination.source.profileEventId,
            recipient.destination.source.profileEventCreatedAt,
          ]
        : ["conduit_allowlist", recipient.destination.source.policy],
      recipient.weightSats,
    ]),
    ...(plan.schemaVersion === 4
      ? [
          [
            plan.nativeTreasury!.schemaVersion,
            plan.nativeTreasury!.sparkAddress,
            plan.nativeTreasury!.receiverIdentityPublicKey,
            plan.nativeTreasury!.senderIdentityPublicKey,
            plan.nativeTreasury!.invoiceId,
            plan.nativeTreasury!.invoiceRequest,
            plan.nativeTreasury!.feePolicy,
            plan.nativeTreasury!.residualPolicy,
          ],
        ]
      : []),
    ...(plan.merchantPublicZapPolicy
      ? [
          checkoutSparkMerchantPublicZapPolicyDigestValue(
            plan.merchantPublicZapPolicy
          ),
        ]
      : []),
  ]
}

function freezeCheckoutSparkSettledPlanInternal(
  input: FreezeCheckoutSparkSettledPlanInput,
  allowPreAllowanceV3: boolean,
  nativeTreasury?: CheckoutSparkNativeTreasuryPlan
): CheckoutSparkSettledPlan {
  const checkoutId = text(input.checkoutId, "Checkout id")
  const orderId = text(input.orderId, "Order id")
  const merchantPubkey = hex(input.merchantPubkey, "Merchant pubkey")
  const walletId = text(input.walletId, "Wallet id")
  if (input.network !== "mainnet" && input.network !== "regtest") {
    throw new Error("Checkout Spark network is invalid.")
  }
  const createdAt = time(input.createdAt, "Plan creation time")
  const takeoverAt = time(input.takeoverAt, "Takeover time")
  if (takeoverAt <= createdAt) {
    throw new Error("Checkout Spark takeover must follow plan creation.")
  }
  const commerceQuote = freezeCheckoutSparkCommerceQuote(
    input.commerceQuote,
    merchantPubkey
  )
  const weights = calculateCheckoutSparkAllocationWeights(
    commerceQuote.commerceTotalSats
  )
  const grossFundingSats = sats(input.funding.grossFundingSats, "Gross funding")
  const preAllowanceGrossSats =
    weights.commerceWeightSats + weights.conduitWeightSats
  if (
    grossFundingSats !==
      calculateCheckoutSparkSettledGrossFundingSats(
        commerceQuote.commerceTotalSats
      ) &&
    (!allowPreAllowanceV3 || grossFundingSats !== preAllowanceGrossSats)
  ) {
    throw new Error("Checkout Spark gross funding differs from frozen terms.")
  }
  const fundingRequest = normalizeInvoice({
    paymentRequest: input.funding.paymentRequest,
    paymentHash: input.funding.paymentHash,
    amountSats: grossFundingSats,
    network: input.network,
    at: createdAt,
  })
  const funding = Object.freeze({
    requestId: text(input.funding.requestId, "Funding request id"),
    paymentRequest: fundingRequest.paymentRequest,
    paymentHash: fundingRequest.paymentHash,
    receiverIdentityPublicKey: compressedPublicKey(
      input.funding.receiverIdentityPublicKey,
      "Funding receiver identity"
    ),
    grossFundingSats,
    createdAt: time(input.funding.createdAt, "Funding creation time"),
    expiresAt: time(input.funding.expiresAt, "Funding expiry time"),
  })
  if (
    funding.createdAt !== createdAt ||
    funding.expiresAt !== fundingRequest.expiresAt ||
    funding.expiresAt <= createdAt
  ) {
    throw new Error("Checkout Spark funding window is invalid.")
  }
  if (!Array.isArray(input.recipients) || input.recipients.length < 2) {
    throw new Error("Checkout Spark recipients are missing.")
  }
  const recipients = input.recipients.map((candidate, position) => {
    if (
      candidate.kind !== "merchant" &&
      candidate.kind !== "supplier" &&
      candidate.kind !== "organizer" &&
      candidate.kind !== "conduit"
    ) {
      throw new Error("Checkout Spark recipient kind is invalid.")
    }
    if (candidate.destination.type !== "lightning_address") {
      throw new Error("Checkout Spark destination type is invalid.")
    }
    const recipientId = text(candidate.recipientId, "Recipient id")
    const source = candidate.destination.source
    let normalizedSource: CheckoutSparkSettledDestinationSource
    if (candidate.kind === "conduit") {
      if (
        source.type !== "conduit_allowlist" ||
        recipientId !== candidate.destination.value ||
        candidate.destination.value !==
          checkoutSparkConduitFeeRecipient(source.policy)
      ) {
        throw new Error("Checkout Spark Conduit destination is invalid.")
      }
      normalizedSource = Object.freeze({
        type: "conduit_allowlist",
        policy: source.policy,
      })
    } else {
      if (source.type !== "signed_profile" || !HEX_64.test(recipientId)) {
        throw new Error(
          "Checkout Spark recipient lacks signed profile evidence."
        )
      }
      const profileEventCreatedAt = time(
        source.profileEventCreatedAt,
        "Recipient profile time"
      )
      if (profileEventCreatedAt * 1_000 > createdAt) {
        throw new Error("Checkout Spark recipient profile postdates plan.")
      }
      normalizedSource = Object.freeze({
        type: "signed_profile",
        profileEventId: hex(source.profileEventId, "Recipient profile event"),
        profileEventCreatedAt,
      })
    }
    const destination = Object.freeze({
      type: candidate.destination.type,
      value: text(candidate.destination.value, "Recipient destination"),
      source: normalizedSource,
    })
    const weightSats = sats(candidate.weightSats, "Recipient weight")
    const legId = digest([
      LEG_DOMAIN,
      checkoutId,
      orderId,
      position,
      candidate.kind,
      recipientId,
      destination.type,
      destination.value,
      normalizedSource.type === "signed_profile"
        ? [
            normalizedSource.type,
            normalizedSource.profileEventId,
            normalizedSource.profileEventCreatedAt,
          ]
        : [normalizedSource.type, normalizedSource.policy],
      weightSats,
    ])
    return Object.freeze({
      position,
      legId,
      kind: candidate.kind,
      recipientId,
      destination,
      weightSats,
    })
  })
  const conduit = recipients.filter((recipient) => recipient.kind === "conduit")
  if (
    conduit.length !== 1 ||
    recipients.at(-1)?.kind !== "conduit" ||
    conduit[0]!.weightSats !== weights.conduitWeightSats ||
    recipients.filter((recipient) => recipient.kind === "merchant").length !== 1
  ) {
    throw new Error("Checkout Spark recipient authority is invalid.")
  }
  assertCheckoutSparkMerchantPayoutRecipient(merchantPubkey, recipients)
  const commerceWeight = recipients
    .filter((recipient) => recipient.kind !== "conduit")
    .reduce((sum, recipient) => sum + BigInt(recipient.weightSats), 0n)
  if (commerceWeight !== BigInt(weights.commerceWeightSats)) {
    throw new Error("Checkout Spark recipients differ from commerce quote.")
  }
  const unsigned = {
    schemaVersion: nativeTreasury ? (4 as const) : (3 as const),
    checkoutId,
    orderId,
    merchantPubkey,
    walletId,
    network: input.network,
    createdAt,
    takeoverAt,
    commerceQuote,
    funding,
    recipients: Object.freeze(recipients),
    ...(input.merchantPublicZapPolicy
      ? {
          merchantPublicZapPolicy: freezeCheckoutSparkMerchantPublicZapPolicy(
            input.merchantPublicZapPolicy
          ),
        }
      : {}),
    ...(nativeTreasury
      ? {
          nativeTreasury: restoreCheckoutSparkNativeTreasuryPlan(
            nativeTreasury,
            {
              checkoutId,
              orderId,
              walletId,
              network: input.network,
              createdAt,
              funding,
            }
          ),
        }
      : {}),
  }
  return Object.freeze({
    ...unsigned,
    planDigest: digest(canonicalPlanValue(unsigned)),
  })
}

/** New plans must include the inbound allowance; only restore accepts old v3. */
export function freezeCheckoutSparkSettledPlan(
  input: FreezeCheckoutSparkSettledPlanInput
): CheckoutSparkSettledPlan {
  assertPrivateCheckoutSparkSettledPlanInput(input)
  return freezeCheckoutSparkSettledPlanInternal(input, false)
}

/** V4 freezes a native final allocation before funding; commerce remains LN. */
export function freezeCheckoutSparkSettledTreasuryPlan(
  input: FreezeCheckoutSparkSettledPlanInput & {
    readonly nativeTreasury: CheckoutSparkNativeTreasuryPlan
  }
): CheckoutSparkSettledPlan {
  assertPrivateCheckoutSparkSettledPlanInput(input)
  return freezeCheckoutSparkSettledPlanInternal(
    input,
    false,
    input.nativeTreasury
  )
}

/** New coordinated checkout is private; restore retains historical authority. */
function assertPrivateCheckoutSparkSettledPlanInput(
  input: FreezeCheckoutSparkSettledPlanInput
): void {
  if (input.merchantPublicZapPolicy !== undefined) {
    throw new Error(
      "Public routed zaps are unavailable for new checkout plans."
    )
  }
}

export function restoreCheckoutSparkSettledPlan(
  plan: CheckoutSparkSettledPlan
): CheckoutSparkSettledPlan {
  if (
    (plan.schemaVersion !== 3 && plan.schemaVersion !== 4) ||
    (plan.schemaVersion === 3 && Object.hasOwn(plan, "nativeTreasury")) ||
    (plan.schemaVersion === 4 && !plan.nativeTreasury)
  ) {
    throw new Error("Checkout Spark settled plan version is invalid.")
  }
  // Existing v3 plans bind the prior gross to the original invoice and digest.
  // Never reprice or rebind them; the new-plan writer remains allowance-only.
  const canonical = freezeCheckoutSparkSettledPlanInternal(
    {
      checkoutId: plan.checkoutId,
      orderId: plan.orderId,
      merchantPubkey: plan.merchantPubkey,
      walletId: plan.walletId,
      network: plan.network,
      createdAt: plan.createdAt,
      takeoverAt: plan.takeoverAt,
      commerceQuote: plan.commerceQuote,
      funding: plan.funding,
      recipients: plan.recipients,
      ...(plan.merchantPublicZapPolicy
        ? { merchantPublicZapPolicy: plan.merchantPublicZapPolicy }
        : {}),
    },
    plan.schemaVersion === 3,
    plan.nativeTreasury
  )
  if (
    canonical.planDigest !== plan.planDigest ||
    plan.recipients.length !== canonical.recipients.length ||
    plan.recipients.some(
      (recipient, position) =>
        recipient.position !== canonical.recipients[position]!.position ||
        recipient.legId !== canonical.recipients[position]!.legId
    )
  ) {
    throw new Error("Checkout Spark settled plan integrity check failed.")
  }
  return canonical
}

export function deriveCheckoutSparkSettledTransferId(
  plan: CheckoutSparkSettledPlan,
  legId: string
): string {
  const canonical = restoreCheckoutSparkSettledPlan(plan)
  if (
    canonical.schemaVersion === 4 &&
    canonical.recipients.find((leg) => leg.legId === legId)?.kind === "conduit"
  ) {
    throw new Error(
      "Checkout Spark native treasury has no local provider transfer ID."
    )
  }
  if (!canonical.recipients.some((recipient) => recipient.legId === legId)) {
    throw new Error("Checkout Spark settled leg is out of scope.")
  }
  return uuidFromDigest(digest([TRANSFER_DOMAIN, canonical.planDigest, legId]))
}

/** One bounded successor; generation zero retains its historical identity. */
export function deriveCheckoutSparkSettledRenewalTransferId(
  plan: CheckoutSparkSettledPlan,
  legId: string
): string {
  const parent = deriveCheckoutSparkSettledTransferId(plan, legId)
  return uuidFromDigest(
    digest([
      "conduit:checkout-spark-settled-transfer-generation:v1",
      plan.planDigest,
      legId,
      1,
      parent,
    ])
  )
}

export function getCheckoutSparkSettledLegGeneration(
  leg: CheckoutSparkSettledLegProgress
): 0 | 1 {
  return leg.generation ?? 0
}

export function getCheckoutSparkSettledClosedGeneration(
  leg: CheckoutSparkSettledLegProgress
): CheckoutSparkSettledClosedGeneration | null {
  return leg.closedGenerations?.[0] ?? null
}

/** Internal stale-review check only; never display or log this fingerprint. */
export function fingerprintCheckoutSparkSettledLegIntent(
  intent: CheckoutSparkSettledLegIntentInput
): string {
  return digest([
    INTENT_REVIEW_DOMAIN,
    intent.legId,
    intent.transferId,
    intent.paymentRequest,
    intent.paymentHash,
    intent.invoiceAmountSats,
    intent.maxFeeSats,
    intent.preparedAt,
    ...(intent.publicZap ? [intent.publicZap] : []),
    ...(intent.receiverBinding ? [intent.receiverBinding] : []),
  ])
}

function allocatedLegs(
  plan: CheckoutSparkSettledPlan,
  creditedSats: number
): readonly CheckoutSparkSettledLegProgress[] {
  const weights = calculateCheckoutSparkAllocationWeights(
    plan.commerceQuote.commerceTotalSats
  )
  const divided = allocateCheckoutSparkSettledSats({
    settledSats: creditedSats,
    fundingInvoiceGrossSats: plan.funding.grossFundingSats,
    weights,
  })
  const otherCommerceAllocations = new Map<string, number>()
  let assignedOtherCommerce = 0
  for (const recipient of plan.recipients) {
    if (recipient.kind === "merchant" || recipient.kind === "conduit") {
      continue
    }
    const share = Number(
      (BigInt(divided.commerceAllocationSats) * BigInt(recipient.weightSats)) /
        BigInt(weights.commerceWeightSats)
    )
    otherCommerceAllocations.set(recipient.legId, share)
    assignedOtherCommerce += share
  }
  return Object.freeze(
    plan.recipients.map((recipient) => {
      let allocationSats: number
      if (recipient.kind === "conduit") {
        allocationSats = divided.conduitAllocationSats
      } else if (recipient.kind === "merchant") {
        // Match the signed supplier-allocation rule: merchant gets whole-sat residue.
        allocationSats = divided.commerceAllocationSats - assignedOtherCommerce
      } else {
        allocationSats = otherCommerceAllocations.get(recipient.legId)!
      }
      return Object.freeze({
        legId: recipient.legId,
        allocationSats,
        intent: null,
        status: "unprepared" as const,
        observedAt: null,
        finalFeeSats: null,
        finalDebitSats: null,
        ...(plan.schemaVersion === 4
          ? { generation: 0 as const, closedGenerations: [] }
          : {}),
      })
    })
  )
}

function freezeState(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkSettledReconciliation {
  return Object.freeze({
    ...state,
    ...(state.treasuryFinalization
      ? {
          treasuryFinalization: Object.freeze({
            ...state.treasuryFinalization,
            intent: state.treasuryFinalization.intent
              ? Object.freeze({ ...state.treasuryFinalization.intent })
              : null,
          }),
        }
      : {}),
    credit: state.credit ? Object.freeze({ ...state.credit }) : null,
    legs: Object.freeze(
      state.legs.map((leg) =>
        Object.freeze({
          ...leg,
          intent: leg.intent ? Object.freeze({ ...leg.intent }) : null,
          ...(leg.closedGenerations
            ? {
                closedGenerations: Object.freeze(
                  leg.closedGenerations.map((entry) =>
                    Object.freeze({
                      ...entry,
                      intent: Object.freeze({ ...entry.intent }),
                      closure: Object.freeze({ ...entry.closure }),
                    })
                  )
                ),
              }
            : {}),
        })
      )
    ),
  })
}

export function createCheckoutSparkSettledReconciliation(
  plan: CheckoutSparkSettledPlan
): CheckoutSparkSettledReconciliation {
  const canonical = restoreCheckoutSparkSettledPlan(plan)
  return freezeState({
    schemaVersion: canonical.schemaVersion === 4 ? 5 : 3,
    plan: canonical,
    credit: null,
    legs: canonical.recipients.map((recipient) => ({
      legId: recipient.legId,
      allocationSats: null,
      intent: null,
      status: "unprepared",
      observedAt: null,
      finalFeeSats: null,
      finalDebitSats: null,
      ...(canonical.schemaVersion === 4
        ? { generation: 0 as const, closedGenerations: [] }
        : {}),
    })),
    ...(canonical.schemaVersion === 4
      ? {
          treasuryFinalization: createCheckoutSparkNativeTreasuryFinalization(),
        }
      : {}),
    updatedAt: canonical.createdAt,
  })
}

export function restoreCheckoutSparkSettledReconciliation(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkSettledReconciliation {
  if (
    state.schemaVersion !== 3 &&
    state.schemaVersion !== 4 &&
    state.schemaVersion !== 5
  ) {
    throw new Error("Checkout Spark settled state version is invalid.")
  }
  const plan = restoreCheckoutSparkSettledPlan(state.plan)
  if (
    (plan.schemaVersion === 4) !== (state.schemaVersion === 5) ||
    (state.schemaVersion !== 5 && Object.hasOwn(state, "treasuryFinalization"))
  ) {
    throw new Error("Checkout Spark treasury state version is invalid.")
  }
  time(state.updatedAt, "Checkout Spark settled update time")
  if (
    state.updatedAt < plan.createdAt ||
    state.legs.length !== plan.recipients.length
  ) {
    throw new Error("Checkout Spark settled state is invalid.")
  }
  let credit: CheckoutSparkSettledCreditEvidence | null = null
  let expected: readonly CheckoutSparkSettledLegProgress[] =
    createCheckoutSparkSettledReconciliation(plan).legs
  if (state.credit) {
    credit = normalizeCredit(plan, state.credit)
    expected = allocatedLegs(plan, credit.creditedSats)
  }
  const legs = state.legs.map((leg, position) => {
    const baseline = expected[position]!
    const generation = getCheckoutSparkSettledLegGeneration(leg)
    if (
      (state.schemaVersion === 3 &&
        (Object.hasOwn(leg, "generation") ||
          Object.hasOwn(leg, "closedGenerations"))) ||
      (state.schemaVersion !== 3 &&
        (![0, 1].includes(leg.generation!) ||
          !Array.isArray(leg.closedGenerations) ||
          leg.closedGenerations.length !== generation))
    ) {
      throw new Error("Checkout Spark settled generation is invalid.")
    }
    if (
      leg.legId !== baseline.legId ||
      leg.allocationSats !== baseline.allocationSats
    ) {
      throw new Error("Checkout Spark settled allocation is invalid.")
    }
    if (
      plan.schemaVersion === 4 &&
      plan.recipients[position]!.kind === "conduit"
    ) {
      if (
        leg.intent !== null ||
        generation !== 0 ||
        leg.closedGenerations!.length !== 0
      ) {
        throw new Error(
          "Checkout Spark native treasury cannot contain Lightning intents."
        )
      }
      return { ...leg, generation: 0 as const, closedGenerations: [] }
    }
    if (leg.intent === null) {
      if (
        leg.status !== "unprepared" ||
        leg.observedAt !== null ||
        leg.finalFeeSats !== null ||
        leg.finalDebitSats !== null
      ) {
        throw new Error("Checkout Spark settled empty leg is invalid.")
      }
      if (generation !== 0)
        throw new Error("Checkout Spark renewed leg lacks its intent.")
      return state.schemaVersion !== 3
        ? { ...baseline, generation: 0 as const, closedGenerations: [] }
        : baseline
    }
    if (!credit || baseline.allocationSats === null) {
      throw new Error("Checkout Spark settled leg lacks exact credit.")
    }
    const intent = normalizeIntent(plan, baseline, leg.intent, generation)
    let closed: CheckoutSparkSettledClosedGeneration | null = null
    if (generation === 1) {
      const entry = leg.closedGenerations![0]!
      const keys = [
        "generation",
        "intent",
        "status",
        "observedAt",
        "finalFeeSats",
        "finalDebitSats",
        "closure",
      ]
      if (
        Object.keys(entry).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(entry, key)) ||
        entry.generation !== 0 ||
        ![
          "prepared",
          "submitted",
          "ambiguous",
          "lookup_unavailable",
          "conflicting_evidence",
          "terminal_failure",
        ].includes(entry.status) ||
        entry.finalFeeSats !== null ||
        entry.finalDebitSats !== null
      )
        throw new Error("Checkout Spark closed generation is invalid.")
      const oldIntent = normalizeIntent(plan, baseline, entry.intent)
      const closure = restoreCheckoutSparkSettledReturnClosure(entry.closure, {
        plan,
        intent: oldIntent,
      })
      if (
        !Number.isSafeInteger(entry.observedAt) ||
        entry.observedAt < oldIntent.preparedAt ||
        closure.observedAt < entry.observedAt ||
        closure.observedAt > intent.preparedAt ||
        intent.preparedAt < plan.takeoverAt ||
        intent.paymentHash === oldIntent.paymentHash ||
        intent.paymentRequest === oldIntent.paymentRequest ||
        (checkoutSparkProviderSendWindowEndsAt(oldIntent.paymentRequest) ??
          Infinity) > intent.preparedAt
      )
        throw new Error("Checkout Spark renewal progression is invalid.")
      closed = { ...entry, intent: oldIntent, closure }
    }
    if (
      leg.status === "unprepared" ||
      leg.observedAt === null ||
      !Number.isSafeInteger(leg.observedAt) ||
      leg.observedAt < intent.preparedAt ||
      ![
        "prepared",
        "submitted",
        "ambiguous",
        "lookup_unavailable",
        "conflicting_evidence",
        "paid",
        "terminal_failure",
      ].includes(leg.status)
    ) {
      throw new Error("Checkout Spark settled leg progress is invalid.")
    }
    if (leg.status === "paid") {
      sats(leg.finalFeeSats!, "Checkout Spark final fee", true)
      sats(leg.finalDebitSats!, "Checkout Spark final debit")
      if (
        leg.finalDebitSats !== intent.invoiceAmountSats + leg.finalFeeSats! ||
        leg.finalDebitSats! > baseline.allocationSats
      ) {
        throw new Error("Checkout Spark settled leg exceeded its allocation.")
      }
    } else if (leg.finalFeeSats !== null || leg.finalDebitSats !== null) {
      throw new Error("Checkout Spark unconfirmed fee is invalid.")
    }
    return Object.freeze({
      ...leg,
      intent,
      ...(state.schemaVersion !== 3
        ? { generation, closedGenerations: closed ? [closed] : [] }
        : {}),
    })
  })
  if (
    state.schemaVersion === 4 &&
    !legs.some((leg) => getCheckoutSparkSettledLegGeneration(leg) === 1)
  ) {
    throw new Error("Checkout Spark renewed state lacks a closed generation.")
  }
  const cumulativeDebitSats = legs.reduce((total, leg) => {
    const historical = (leg.closedGenerations ?? []).reduce(
      (sum, entry) => sum + entry.closure.netDebitSats,
      0
    )
    const debit = historical + (leg.finalDebitSats ?? 0)
    const native =
      plan.schemaVersion === 4 &&
      plan.recipients.find((recipient) => recipient.legId === leg.legId)
        ?.kind === "conduit"
    if (
      !Number.isSafeInteger(debit) ||
      (!native && debit > (leg.allocationSats ?? 0))
    )
      throw new Error("Checkout Spark cumulative debit exceeds its allocation.")
    return total + debit
  }, 0)
  if (
    !Number.isSafeInteger(cumulativeDebitSats) ||
    cumulativeDebitSats > (credit?.creditedSats ?? 0)
  )
    throw new Error("Checkout Spark cumulative debit exceeds its credit.")
  const latest = Math.max(
    plan.createdAt,
    credit?.observedAt ?? plan.createdAt,
    ...legs.map((leg) => leg.observedAt ?? plan.createdAt)
  )
  if (state.updatedAt < latest) {
    throw new Error("Checkout Spark settled state timestamp is stale.")
  }
  const treasuryFinalization =
    state.schemaVersion === 5
      ? restoreCheckoutSparkNativeTreasuryFinalization(
          state.treasuryFinalization!,
          { ...state, plan, credit, legs }
        )
      : undefined
  if (treasuryFinalization) {
    const nativeLeg = legs.find(
      (leg) =>
        plan.recipients.find((recipient) => recipient.legId === leg.legId)
          ?.kind === "conduit"
    )!
    if (
      nativeLeg.status !== treasuryFinalization.status ||
      nativeLeg.observedAt !== treasuryFinalization.observedAt ||
      nativeLeg.finalFeeSats !== treasuryFinalization.finalFeeSats ||
      nativeLeg.finalDebitSats !== treasuryFinalization.finalDebitSats
    ) {
      throw new Error("Checkout Spark native treasury mirror is invalid.")
    }
  }
  return freezeState({
    schemaVersion: state.schemaVersion,
    plan,
    credit,
    legs,
    updatedAt: state.updatedAt,
    ...(treasuryFinalization ? { treasuryFinalization } : {}),
  })
}

function normalizeCredit(
  plan: CheckoutSparkSettledPlan,
  evidence: CheckoutSparkSettledCreditEvidence
): CheckoutSparkSettledCreditEvidence {
  const requestId = text(evidence.requestId, "Funding request id")
  const paymentHash = hex(evidence.paymentHash, "Funding payment hash")
  const transferId = text(evidence.transferId, "Funding transfer id")
  if (
    requestId !== plan.funding.requestId ||
    paymentHash !== plan.funding.paymentHash ||
    evidence.grossSats !== plan.funding.grossFundingSats ||
    compressedPublicKey(
      evidence.receiverIdentityPublicKey,
      "Funding receiver identity"
    ) !== plan.funding.receiverIdentityPublicKey
  ) {
    throw new Error("Checkout Spark settled credit is out of scope.")
  }
  const creditedSats = sats(evidence.creditedSats, "Settled credit")
  if (creditedSats > plan.funding.grossFundingSats) {
    throw new Error("Checkout Spark settled credit exceeds invoice.")
  }
  const observedAt = time(evidence.observedAt, "Funding credit time")
  if (observedAt < plan.createdAt) {
    throw new Error("Checkout Spark settled credit predates plan.")
  }
  return Object.freeze({
    requestId,
    paymentHash,
    transferId,
    receiverIdentityPublicKey: evidence.receiverIdentityPublicKey,
    grossSats: plan.funding.grossFundingSats,
    creditedSats,
    observedAt,
  })
}

export function recordCheckoutSparkSettledCredit(
  state: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkSettledCreditEvidence
): CheckoutSparkSettledReconciliation {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  const credit = normalizeCredit(current.plan, evidence)
  if (current.credit) {
    if (
      current.credit.requestId !== credit.requestId ||
      current.credit.paymentHash !== credit.paymentHash ||
      current.credit.transferId !== credit.transferId ||
      current.credit.receiverIdentityPublicKey !==
        credit.receiverIdentityPublicKey ||
      current.credit.grossSats !== credit.grossSats ||
      current.credit.creditedSats !== credit.creditedSats
    ) {
      throw new Error(
        "Checkout Spark settled credit conflicts with prior evidence."
      )
    }
    return current
  }
  return freezeState({
    ...current,
    credit,
    legs: allocatedLegs(current.plan, credit.creditedSats),
    updatedAt: Math.max(current.updatedAt, credit.observedAt),
  })
}

function normalizeIntent(
  plan: CheckoutSparkSettledPlan,
  leg: CheckoutSparkSettledLegProgress,
  input: CheckoutSparkSettledLegIntentInput,
  generation: 0 | 1 = 0
): CheckoutSparkSettledLegIntentInput {
  if (
    input.legId !== leg.legId ||
    input.transferId !==
      (generation === 0
        ? deriveCheckoutSparkSettledTransferId(plan, leg.legId)
        : deriveCheckoutSparkSettledRenewalTransferId(plan, leg.legId)) ||
    leg.allocationSats === null
  ) {
    throw new Error("Checkout Spark settled intent is out of scope.")
  }
  const invoiceAmountSats = sats(input.invoiceAmountSats, "Outgoing invoice")
  const maxFeeSats = sats(input.maxFeeSats, "Outgoing fee cap", true)
  const preparedAt = time(input.preparedAt, "Outgoing preparation time")
  if (
    preparedAt < plan.createdAt ||
    invoiceAmountSats >= leg.allocationSats ||
    maxFeeSats !== leg.allocationSats - invoiceAmountSats
  ) {
    throw new Error("Checkout Spark outgoing invoice exceeds allocation.")
  }
  const normalizedInvoice = normalizeInvoice({
    paymentRequest: input.paymentRequest,
    paymentHash: input.paymentHash,
    amountSats: invoiceAmountSats,
    network: plan.network,
    at: preparedAt,
  })
  const recipient = plan.recipients.find((item) => item.legId === leg.legId)!
  if (
    input.publicZap &&
    (!plan.merchantPublicZapPolicy || recipient.kind !== "merchant")
  ) {
    throw new Error(
      "Checkout Spark public zap is outside the approved Merchant leg."
    )
  }
  const publicZap = input.publicZap
    ? restoreCheckoutSparkPublicZapContext(input.publicZap, {
        policy: plan.merchantPublicZapPolicy!,
        recipientPubkey: plan.merchantPubkey,
        lud16: recipient.destination.value,
        amountSats: invoiceAmountSats,
        paymentRequest: normalizedInvoice.paymentRequest,
        preparedAt,
        planCreatedAt: plan.createdAt,
      })
    : undefined
  const receiverBinding = input.receiverBinding
    ? freezeCheckoutSparkReceiverBinding(input.receiverBinding)
    : undefined
  if (
    receiverBinding &&
    (receiverBinding.lud16 !==
      normalizeCheckoutSparkReceiverAddress(recipient.destination.value) ||
      receiverBinding.mode !== (publicZap ? "public" : "private"))
  ) {
    throw new Error("Checkout Spark receiver binding is out of scope.")
  }
  return Object.freeze({
    legId: leg.legId,
    transferId: input.transferId,
    paymentRequest: normalizedInvoice.paymentRequest,
    paymentHash: normalizedInvoice.paymentHash,
    invoiceAmountSats,
    maxFeeSats,
    preparedAt,
    ...(publicZap ? { publicZap } : {}),
    ...(receiverBinding ? { receiverBinding } : {}),
  })
}

/** Persist this exact invoice and stable transfer ID before provider I/O. */
export function prepareCheckoutSparkSettledLeg(
  state: CheckoutSparkSettledReconciliation,
  input: CheckoutSparkSettledLegIntentInput
): CheckoutSparkSettledReconciliation {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  if (
    current.plan.schemaVersion === 4 &&
    current.plan.recipients.find((leg) => leg.legId === input.legId)?.kind ===
      "conduit"
  ) {
    throw new Error(
      "Checkout Spark native treasury cannot prepare a Lightning invoice."
    )
  }
  const position = current.legs.findIndex((leg) => leg.legId === input.legId)
  if (position < 0 || !current.credit) {
    throw new Error("Checkout Spark settled leg is not funded.")
  }
  const leg = current.legs[position]!
  const intent = normalizeIntent(
    current.plan,
    leg,
    input,
    getCheckoutSparkSettledLegGeneration(leg)
  )
  if (leg.intent) {
    if (JSON.stringify(leg.intent) !== JSON.stringify(intent)) {
      throw new Error("Checkout Spark settled intent cannot be replaced.")
    }
    return current
  }
  if (intent.preparedAt < current.credit.observedAt) {
    throw new Error("Checkout Spark settled intent is stale.")
  }
  const legs = current.legs.map((candidate, index) =>
    index === position
      ? Object.freeze({
          ...candidate,
          intent,
          status: "prepared" as const,
          observedAt: intent.preparedAt,
        })
      : candidate
  )
  return freezeState({
    ...current,
    legs,
    updatedAt: Math.max(current.updatedAt, intent.preparedAt),
  })
}

/** Advance only after exact positive full return; never reset the old attempt. */
export function renewCheckoutSparkSettledLeg(
  state: CheckoutSparkSettledReconciliation,
  input: {
    legId: string
    intent: CheckoutSparkSettledLegIntentInput
    proof: CheckoutSparkSettledReturnedProof
    nowMs: number
  }
): CheckoutSparkSettledReconciliation {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  const leg = current.legs.find((item) => item.legId === input.legId)
  const recipient = current.plan.recipients.find(
    (item) => item.legId === input.legId
  )
  if (
    !current.credit ||
    !leg?.intent ||
    !recipient ||
    leg.allocationSats === null ||
    leg.status === "paid" ||
    getCheckoutSparkSettledLegGeneration(leg) !== 0 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < current.plan.takeoverAt ||
    input.nowMs < current.updatedAt ||
    input.intent.preparedAt !== input.nowMs ||
    (checkoutSparkProviderSendWindowEndsAt(leg.intent.paymentRequest) ??
      Infinity) > input.nowMs
  )
    throw new Error("Checkout Spark payout cannot be renewed.")
  const protectedSats = current.legs.reduce(
    (sum, item) =>
      sum + (item.status === "paid" ? 0 : (item.allocationSats ?? 0)),
    0
  )
  const closure = assertCheckoutSparkSettledReturnedProof(input.proof, {
    plan: current.plan,
    target: {
      walletId: current.plan.walletId,
      network: current.plan.network,
      legId: leg.legId,
      recipientId: recipient.recipientId,
      allocationSats: leg.allocationSats,
      unpaidAllocationSats: protectedSats,
      intent: leg.intent,
    },
    nowMs: input.nowMs,
  })
  if (closure.observedAt < (leg.observedAt ?? leg.intent.preparedAt))
    throw new Error("Checkout Spark returned transfer observation is stale.")
  if (leg.intent.publicZap && !input.intent.publicZap) {
    throw new Error(
      "Checkout Spark public payout renewal requires fresh buyer signing."
    )
  }
  const intent = normalizeIntent(current.plan, leg, input.intent, 1)
  const archived: CheckoutSparkSettledClosedGeneration = {
    generation: 0,
    intent: leg.intent,
    status: leg.status as CheckoutSparkSettledClosedGeneration["status"],
    observedAt: leg.observedAt!,
    finalFeeSats: null,
    finalDebitSats: null,
    closure,
  }
  return restoreCheckoutSparkSettledReconciliation({
    ...current,
    schemaVersion: current.plan.schemaVersion === 4 ? 5 : 4,
    legs: current.legs.map((item) =>
      item.legId === input.legId
        ? {
            ...item,
            generation: 1,
            closedGenerations: [archived],
            intent,
            status: "prepared",
            observedAt: intent.preparedAt,
            finalFeeSats: null,
            finalDebitSats: null,
          }
        : {
            ...item,
            generation: getCheckoutSparkSettledLegGeneration(item),
            closedGenerations: item.closedGenerations ?? [],
          }
    ),
    updatedAt: input.nowMs,
  })
}

/** A submitted/ambiguous leg is never re-created or silently made payable. */
export function recordCheckoutSparkSettledLegStatus(
  state: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkSettledLegEvidence
): CheckoutSparkSettledReconciliation {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  const position = current.legs.findIndex((leg) => leg.legId === evidence.legId)
  const leg = current.legs[position]
  if (
    !leg?.intent ||
    evidence.transferId !== leg.intent.transferId ||
    evidence.paymentHash !== leg.intent.paymentHash ||
    ![
      "submitted",
      "ambiguous",
      "lookup_unavailable",
      "conflicting_evidence",
      "paid",
      "terminal_failure",
    ].includes(evidence.status)
  ) {
    throw new Error("Checkout Spark settled leg evidence is out of scope.")
  }
  const observedAt = time(evidence.observedAt, "Outgoing observation time")
  if (
    observedAt < leg.intent.preparedAt ||
    (leg.observedAt !== null && observedAt < leg.observedAt)
  ) {
    throw new Error("Checkout Spark settled leg observation is stale.")
  }
  if (leg.status === "paid" && evidence.status !== "paid") {
    throw new Error("Checkout Spark paid leg cannot become payable again.")
  }
  if (
    leg.status === "terminal_failure" &&
    evidence.status !== "terminal_failure" &&
    evidence.status !== "paid"
  ) {
    throw new Error("Checkout Spark terminal leg cannot be retried.")
  }
  if (
    leg.status !== "prepared" &&
    evidence.status === "submitted" &&
    leg.status !== "submitted"
  ) {
    throw new Error("Checkout Spark uncertain leg cannot be resubmitted.")
  }
  const finalFeeSats =
    evidence.status === "paid"
      ? sats(evidence.finalFeeSats!, "Checkout Spark final fee", true)
      : null
  const finalDebitSats =
    evidence.status === "paid"
      ? sats(evidence.finalDebitSats!, "Checkout Spark final debit")
      : null
  if (
    evidence.status === "paid" &&
    (finalFeeSats === null ||
      finalDebitSats === null ||
      finalDebitSats !== leg.intent.invoiceAmountSats + finalFeeSats ||
      finalFeeSats > leg.intent.maxFeeSats ||
      finalDebitSats > leg.allocationSats!)
  ) {
    throw new Error("Checkout Spark paid leg exceeded allocation.")
  }
  if (
    evidence.status !== "paid" &&
    (evidence.finalFeeSats !== undefined ||
      evidence.finalDebitSats !== undefined)
  ) {
    throw new Error("Checkout Spark unconfirmed fee is invalid.")
  }
  if (
    leg.status === evidence.status &&
    leg.finalFeeSats === finalFeeSats &&
    leg.finalDebitSats === finalDebitSats
  ) {
    return current
  }
  const legs = current.legs.map((candidate, index) =>
    index === position
      ? Object.freeze({
          ...candidate,
          status: evidence.status,
          observedAt,
          finalFeeSats,
          finalDebitSats,
        })
      : candidate
  )
  return freezeState({
    ...current,
    legs,
    updatedAt: Math.max(current.updatedAt, observedAt),
  })
}

/** A fresh exact-wallet zero-funds read must follow every terminal provider observation. */
export function assessCheckoutSparkSettledRetirement(
  state: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkRetirementEvidence
): CheckoutSparkRetirementAssessment {
  const current = restoreCheckoutSparkSettledReconciliation(state)
  if (
    evidence.walletId !== current.plan.walletId ||
    evidence.network !== current.plan.network
  ) {
    throw new Error("Checkout Spark retirement evidence is out of scope.")
  }
  const observedAt = time(evidence.observedAt, "Retirement observation time")
  const availableSats = sats(
    evidence.availableSats,
    "Available retirement funds",
    true
  )
  const ownedSats = sats(evidence.ownedSats, "Owned retirement funds", true)
  const incomingSats = sats(
    evidence.incomingSats,
    "Incoming retirement funds",
    true
  )
  if (ownedSats < availableSats) {
    throw new Error("Checkout Spark retirement funds are inconsistent.")
  }
  if (
    typeof evidence.fundingReceiveTerminal !== "boolean" ||
    typeof evidence.sendHistoryTerminal !== "boolean" ||
    typeof evidence.claimsTerminal !== "boolean" ||
    typeof evidence.refundsTerminal !== "boolean"
  ) {
    throw new Error("Checkout Spark retirement terminal evidence is invalid.")
  }

  const reasons: CheckoutSparkRetirementPendingReason[] = []
  if (observedAt <= current.updatedAt) reasons.push("stale_funds_evidence")
  if (availableSats > 0 || ownedSats > 0) reasons.push("funds_remaining")
  if (incomingSats > 0) reasons.push("transfer_in_flight")
  if (!evidence.fundingReceiveTerminal) reasons.push("funding_receive_open")
  if (!evidence.sendHistoryTerminal) reasons.push("send_history_open")
  if (!evidence.claimsTerminal) reasons.push("claim_path_open")
  if (!evidence.refundsTerminal) reasons.push("refund_path_open")
  if (
    current.legs.some(
      (leg) => leg.status !== "paid" && leg.status !== "terminal_failure"
    )
  ) {
    reasons.push("obligation_open")
  }
  return reasons.length > 0
    ? { state: "retirement_pending", reasons }
    : { state: "ready" }
}

/** Keep only a non-secret replay barrier after conclusive v3 retirement. */
export function retireCheckoutSparkSettledReconciliation(
  state: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkRetirementEvidence
): CheckoutSparkRetirementTombstone {
  const assessment = assessCheckoutSparkSettledRetirement(state, evidence)
  if (assessment.state !== "ready") {
    throw new Error(
      "Checkout Spark settled reconciliation is not ready to retire."
    )
  }
  return Object.freeze({
    schemaVersion: 1,
    planDigest: state.plan.planDigest,
    retiredAt: evidence.observedAt,
  })
}
