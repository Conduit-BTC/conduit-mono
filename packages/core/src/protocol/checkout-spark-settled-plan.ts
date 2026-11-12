import {
  type CheckoutSparkConduitDestinationPolicy,
  type CheckoutSparkConduitFeePolicy,
  checkoutSparkConduitFeeRecipient,
} from "./checkout-spark-router-obligations"
import {
  type CheckoutSparkObligationKind,
  type CheckoutSparkNetwork,
  type CheckoutSparkCommerceQuote,
  freezeCheckoutSparkCommerceQuote,
  assertCheckoutSparkMerchantPayoutRecipient,
} from "./checkout-spark-reconciliation"
import {
  type CheckoutSparkMerchantPublicZapPolicy,
  checkoutSparkMerchantPublicZapPolicyDigestValue,
  freezeCheckoutSparkMerchantPublicZapPolicy,
} from "./checkout-spark-public-zap"
import {
  type CheckoutSparkNativeTreasuryPlan,
  isCheckoutSparkNativeTreasuryPlan,
  restoreCheckoutSparkNativeTreasuryPlan,
} from "./checkout-spark-treasury-model"
import {
  type CheckoutSparkEventMarketBinding,
  checkoutSparkEventMarketBindingDigestValue,
  freezeCheckoutSparkEventMarketBinding,
} from "./checkout-spark-event-market"
import { bytesToHex } from "@noble/hashes/utils.js"
import { checkoutSparkCommerceQuoteDigestValue } from "./checkout-spark-commerce-pricing"
import {
  text,
  hex,
  time,
  sats,
  normalizeInvoice,
  compressedPublicKey,
  HEX_64,
  digest,
} from "./checkout-spark-settled-validation"
import {
  calculateCheckoutSparkEventAllocationWeights,
  calculateCheckoutSparkAllocationWeights,
  calculateCheckoutSparkEventSettledGrossFundingSats,
  calculateCheckoutSparkSettledGrossFundingSats,
} from "./checkout-spark-settled-allocation"

const PLAN_DOMAIN = "conduit:checkout-spark-settled-plan:v3"

const LEG_DOMAIN = "conduit:checkout-spark-settled-leg:v3"

const TRANSFER_DOMAIN = "conduit:checkout-spark-settled-transfer:v3"

export type CheckoutSparkSettledDestinationSource =
  | {
      readonly type: "signed_profile"
      readonly profileEventId: string
      readonly profileEventCreatedAt: number
    }
  | {
      readonly type: "signed_event_market"
      readonly marketCoordinate: string
      readonly eventId: string
      readonly eventCreatedAt: number
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
  /** Absent on historical plans; when present, committed by the plan digest. */
  readonly conduitFeePolicy?: CheckoutSparkConduitFeePolicy
}

/** V3 freezes identities, endpoints and weights, but no outgoing invoice. */
export interface CheckoutSparkSettledPlan extends FreezeCheckoutSparkSettledPlanInput {
  readonly schemaVersion: 3 | 4 | 5
  readonly nativeTreasury?: CheckoutSparkNativeTreasuryPlan
  readonly eventMarket?: CheckoutSparkEventMarketBinding
  readonly planDigest: string
  readonly recipients: readonly CheckoutSparkSettledRecipient[]
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
    plan.schemaVersion === 5
      ? "conduit:checkout-spark-settled-plan:v5"
      : plan.schemaVersion === 4
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
      destinationSourceDigestValue(recipient.destination.source),
      recipient.weightSats,
    ]),
    ...(isCheckoutSparkNativeTreasuryPlan(plan)
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
    ...(plan.schemaVersion === 5
      ? [checkoutSparkEventMarketBindingDigestValue(plan.eventMarket!)]
      : []),
    ...(plan.merchantPublicZapPolicy
      ? [
          checkoutSparkMerchantPublicZapPolicyDigestValue(
            plan.merchantPublicZapPolicy
          ),
        ]
      : []),
    ...(plan.conduitFeePolicy !== undefined
      ? [["conduit-fee-policy", plan.conduitFeePolicy]]
      : []),
  ]
}

function destinationSourceDigestValue(
  source: CheckoutSparkSettledDestinationSource
): unknown[] {
  if (source.type === "signed_profile")
    return [source.type, source.profileEventId, source.profileEventCreatedAt]
  if (source.type === "signed_event_market")
    return [
      source.type,
      source.marketCoordinate,
      source.eventId,
      source.eventCreatedAt,
    ]
  return [source.type, source.policy]
}

function freezeCheckoutSparkSettledPlanInternal(
  input: FreezeCheckoutSparkSettledPlanInput,
  allowPreAllowanceV3: boolean,
  nativeTreasury?: CheckoutSparkNativeTreasuryPlan,
  eventMarketInput?: CheckoutSparkEventMarketBinding
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
    merchantPubkey,
    { allowZeroTotal: eventMarketInput !== undefined }
  )
  const eventMarket =
    eventMarketInput === undefined
      ? undefined
      : freezeCheckoutSparkEventMarketBinding(eventMarketInput, {
          merchantPubkey,
          commerceQuote,
          acceptedAtMs: createdAt,
        })
  if (eventMarket && !nativeTreasury)
    throw new Error(
      "Checkout Spark event plans require native final collection."
    )
  const weights = eventMarket
    ? calculateCheckoutSparkEventAllocationWeights(
        commerceQuote.commerceTotalSats,
        eventMarket.organizerFeeSats,
        input.conduitFeePolicy
      )
    : calculateCheckoutSparkAllocationWeights(
        commerceQuote.commerceTotalSats,
        input.conduitFeePolicy
      )
  const grossFundingSats = sats(input.funding.grossFundingSats, "Gross funding")
  const preAllowanceGrossSats =
    weights.commerceWeightSats + weights.conduitWeightSats
  if (
    grossFundingSats !==
      (eventMarket
        ? calculateCheckoutSparkEventSettledGrossFundingSats(
            commerceQuote.commerceTotalSats,
            eventMarket.organizerFeeSats,
            input.conduitFeePolicy
          )
        : calculateCheckoutSparkSettledGrossFundingSats(
            commerceQuote.commerceTotalSats,
            input.conduitFeePolicy
          )) &&
    (!allowPreAllowanceV3 ||
      input.conduitFeePolicy !== undefined ||
      grossFundingSats !== preAllowanceGrossSats)
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
  const recipients: CheckoutSparkSettledRecipient[] = input.recipients.map(
    (candidate: CheckoutSparkSettledRecipientInput, position) => {
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
      } else if (eventMarket && candidate.kind === "organizer") {
        const fee = eventMarket.organizerFee
        if (
          source.type !== "signed_event_market" ||
          recipientId !== eventMarket.organizerPubkey ||
          source.marketCoordinate !== eventMarket.marketCoordinate ||
          source.eventId !== eventMarket.marketEventId ||
          source.eventCreatedAt * 1_000 > createdAt ||
          source.eventCreatedAt !== fee.createdAt ||
          fee.state !== "active" ||
          candidate.destination.value !== fee.lightningAddress ||
          candidate.weightSats !== eventMarket.organizerFeeSats
        )
          throw new Error(
            "Checkout Spark organizer lacks exact signed event fee evidence."
          )
        normalizedSource = Object.freeze({
          type: "signed_event_market",
          marketCoordinate: source.marketCoordinate,
          eventId: hex(source.eventId, "Organizer fee event"),
          eventCreatedAt: time(source.eventCreatedAt, "Organizer fee time"),
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
        destinationSourceDigestValue(normalizedSource),
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
    }
  )
  const conduit = recipients.filter((recipient) => recipient.kind === "conduit")
  if (
    conduit.length !== 1 ||
    recipients.at(-1)?.kind !== "conduit" ||
    conduit[0]!.weightSats !== weights.conduitWeightSats ||
    recipients.filter((recipient) => recipient.kind === "merchant").length !==
      (eventMarket && commerceQuote.commerceTotalSats === 0 ? 0 : 1)
  ) {
    throw new Error("Checkout Spark recipient authority is invalid.")
  }
  if (!eventMarket || commerceQuote.commerceTotalSats > 0)
    assertCheckoutSparkMerchantPayoutRecipient(merchantPubkey, recipients)
  const commerceWeight = recipients
    .filter((recipient) =>
      eventMarket
        ? recipient.kind === "merchant" || recipient.kind === "supplier"
        : recipient.kind !== "conduit"
    )
    .reduce((sum, recipient) => sum + BigInt(recipient.weightSats), 0n)
  if (commerceWeight !== BigInt(weights.commerceWeightSats)) {
    throw new Error("Checkout Spark recipients differ from commerce quote.")
  }
  if (eventMarket) {
    const organizers = recipients.filter(
      (recipient) => recipient.kind === "organizer"
    )
    const ranks = { merchant: 0, supplier: 1, organizer: 2, conduit: 3 }
    if (
      organizers.length !== (eventMarket.organizerFeeSats > 0 ? 1 : 0) ||
      recipients.some(
        (recipient, index) =>
          index > 0 &&
          ranks[recipient.kind] < ranks[recipients[index - 1]!.kind]
      )
    )
      throw new Error("Checkout Spark event payout ordering is invalid.")
  }
  const unsigned = {
    schemaVersion: eventMarket
      ? (5 as const)
      : nativeTreasury
        ? (4 as const)
        : (3 as const),
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
    ...(input.conduitFeePolicy !== undefined
      ? { conduitFeePolicy: input.conduitFeePolicy }
      : {}),
    ...(eventMarket ? { eventMarket } : {}),
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
  assertOrdinaryCheckoutSparkSettledPlanInput(input)
  return freezeCheckoutSparkSettledPlanInternal(input, false)
}

/** V4 freezes a native final allocation before funding; commerce remains LN. */
export function freezeCheckoutSparkSettledTreasuryPlan(
  input: FreezeCheckoutSparkSettledPlanInput & {
    readonly nativeTreasury: CheckoutSparkNativeTreasuryPlan
  }
): CheckoutSparkSettledPlan {
  assertPrivateCheckoutSparkSettledPlanInput(input)
  assertOrdinaryCheckoutSparkSettledPlanInput(input)
  return freezeCheckoutSparkSettledPlanInternal(
    input,
    false,
    input.nativeTreasury
  )
}

/** Event fees require a new digest and never reinterpret ordinary funded plans. */
export function freezeCheckoutSparkSettledEventPlan(
  input: FreezeCheckoutSparkSettledPlanInput & {
    readonly nativeTreasury: CheckoutSparkNativeTreasuryPlan
    readonly eventMarket: CheckoutSparkEventMarketBinding
  }
): CheckoutSparkSettledPlan {
  assertPrivateCheckoutSparkSettledPlanInput(input)
  return freezeCheckoutSparkSettledPlanInternal(
    input,
    false,
    input.nativeTreasury,
    input.eventMarket
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

function assertOrdinaryCheckoutSparkSettledPlanInput(
  input: FreezeCheckoutSparkSettledPlanInput
): void {
  if (
    Object.hasOwn(input, "eventMarket") ||
    input.recipients.some((recipient) => recipient.kind === "organizer")
  )
    throw new Error("Checkout Spark event obligations require an event plan.")
}

export function restoreCheckoutSparkSettledPlan(
  plan: CheckoutSparkSettledPlan
): CheckoutSparkSettledPlan {
  if (
    (plan.schemaVersion !== 3 &&
      plan.schemaVersion !== 4 &&
      plan.schemaVersion !== 5) ||
    (plan.schemaVersion === 3 && Object.hasOwn(plan, "nativeTreasury")) ||
    (isCheckoutSparkNativeTreasuryPlan(plan) && !plan.nativeTreasury) ||
    (plan.schemaVersion === 5
      ? !plan.eventMarket
      : Object.hasOwn(plan, "eventMarket")) ||
    (plan.schemaVersion === 5 && plan.merchantPublicZapPolicy !== undefined)
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
      ...(plan.conduitFeePolicy !== undefined
        ? { conduitFeePolicy: plan.conduitFeePolicy }
        : {}),
      ...(plan.merchantPublicZapPolicy
        ? { merchantPublicZapPolicy: plan.merchantPublicZapPolicy }
        : {}),
    },
    plan.schemaVersion === 3,
    plan.nativeTreasury,
    plan.eventMarket
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
    isCheckoutSparkNativeTreasuryPlan(canonical) &&
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
