import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  type CheckoutSparkNetwork,
  type CheckoutSparkObligationPlanInput,
} from "@conduit/core"

import {
  resolveCheckoutSparkLnurlInvoice,
  type CheckoutSparkLnurlInvoiceDependencies,
} from "./checkout-spark-lnurl-invoice"
import {
  readCheckoutSparkRecipientPayoutAddress,
  type CheckoutSparkRecipientProfileReadInput,
} from "./checkout-spark-recipient-profile"

export interface CheckoutSparkRecipientInvoiceWitness {
  readonly checkoutId: string
  readonly recipientPubkey: string
  readonly profileEventId: string
  readonly profileEventCreatedAt: number
  readonly lud16: string
  readonly amountSats: number
  readonly network: CheckoutSparkNetwork
  readonly paymentRequest: string
  readonly paymentHash: string
  readonly expiresAt: number
}

export interface CheckoutSparkRecipientInvoiceWitnessInput extends CheckoutSparkRecipientProfileReadInput {
  checkoutId: string
  /** Exact amount from the frozen, authorized payout obligation. */
  amountSats: number
  network: CheckoutSparkNetwork
  nowSeconds: number
}

export interface CheckoutSparkRecipientInvoiceWitnessDependencies {
  profile?: Parameters<typeof readCheckoutSparkRecipientPayoutAddress>[1]
  lnurl?: CheckoutSparkLnurlInvoiceDependencies
}

export interface CheckoutSparkConduitInvoiceWitness {
  readonly checkoutId: string
  readonly recipientId: typeof CONDUIT_CHECKOUT_FEE_RECIPIENT
  readonly lud16: typeof CONDUIT_CHECKOUT_FEE_RECIPIENT
  readonly amountSats: number
  readonly network: CheckoutSparkNetwork
  readonly paymentRequest: string
  readonly paymentHash: string
  readonly expiresAt: number
}

export type CheckoutSparkPayoutInvoiceWitness =
  CheckoutSparkRecipientInvoiceWitness | CheckoutSparkConduitInvoiceWitness

interface WitnessOrigin {
  checkoutId: string
  shouldContinue: () => boolean
}

// Only an invoice returned by one of the resolvers in this module can authorize
// preparation. Serializing or copying the public witness does not carry proof.
const witnessOrigins = new WeakMap<object, WitnessOrigin>()

function assertCheckoutId(checkoutId: string): void {
  if (!checkoutId.trim() || checkoutId.length > 256) {
    throw new Error("Checkout Spark checkout identity is invalid.")
  }
}

/**
 * Bind one plain payout invoice to the recipient's freshly observed signed
 * kind-0 payment address. This only prepares evidence; it does not send funds.
 * The caller must bind the recipient, amount, and network to its frozen order
 * obligation and revalidate invoice lifetime before any eventual send.
 */
export async function resolveCheckoutSparkRecipientInvoiceWitness(
  input: CheckoutSparkRecipientInvoiceWitnessInput,
  dependencies: CheckoutSparkRecipientInvoiceWitnessDependencies = {}
): Promise<CheckoutSparkRecipientInvoiceWitness> {
  assertCheckoutId(input.checkoutId)
  const assertCurrent = () => {
    if (input.shouldContinue() !== true) {
      throw new Error("Checkout session changed during payout preparation.")
    }
  }
  assertCurrent()

  let recipient: Awaited<
    ReturnType<typeof readCheckoutSparkRecipientPayoutAddress>
  >
  try {
    recipient = await readCheckoutSparkRecipientPayoutAddress(
      {
        recipientPubkey: input.recipientPubkey,
        accountPubkey: input.accountPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
      },
      dependencies.profile
    )
  } catch (error) {
    assertCurrent()
    throw error
  }
  assertCurrent()
  if (recipient.state !== "ready") {
    throw new Error("Checkout Spark recipient payout address is not verified.")
  }

  let invoice: Awaited<ReturnType<typeof resolveCheckoutSparkLnurlInvoice>>
  try {
    invoice = await resolveCheckoutSparkLnurlInvoice(
      {
        lud16: recipient.lud16,
        amountSats: input.amountSats,
        network: input.network,
        nowSeconds: input.nowSeconds,
        shouldContinue: input.shouldContinue,
      },
      dependencies.lnurl
    )
  } catch (error) {
    assertCurrent()
    throw error
  }
  assertCurrent()

  const witness = Object.freeze({
    checkoutId: input.checkoutId,
    recipientPubkey: recipient.recipientPubkey,
    profileEventId: recipient.profileEventId,
    profileEventCreatedAt: recipient.profileEventCreatedAt,
    lud16: recipient.lud16,
    amountSats: input.amountSats,
    network: input.network,
    paymentRequest: invoice.paymentRequest,
    paymentHash: invoice.paymentHash,
    expiresAt: invoice.expiresAt,
  })
  witnessOrigins.set(witness, {
    checkoutId: input.checkoutId,
    shouldContinue: input.shouldContinue,
  })
  return witness
}

/** Resolve the fixed Conduit leg as a plain LNURL invoice, never a zap. */
export async function resolveCheckoutSparkConduitInvoiceWitness(
  input: {
    checkoutId: string
    amountSats: number
    network: CheckoutSparkNetwork
    nowSeconds: number
    shouldContinue: () => boolean
  },
  dependencies: CheckoutSparkLnurlInvoiceDependencies = {}
): Promise<CheckoutSparkConduitInvoiceWitness> {
  assertCheckoutId(input.checkoutId)
  const assertCurrent = () => {
    if (input.shouldContinue() !== true) {
      throw new Error("Checkout session changed during payout preparation.")
    }
  }
  assertCurrent()

  let invoice: Awaited<ReturnType<typeof resolveCheckoutSparkLnurlInvoice>>
  try {
    invoice = await resolveCheckoutSparkLnurlInvoice(
      {
        lud16: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        amountSats: input.amountSats,
        network: input.network,
        nowSeconds: input.nowSeconds,
        shouldContinue: input.shouldContinue,
      },
      dependencies
    )
  } catch (error) {
    assertCurrent()
    throw error
  }
  assertCurrent()

  const witness = Object.freeze({
    checkoutId: input.checkoutId,
    recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
    lud16: CONDUIT_CHECKOUT_FEE_RECIPIENT,
    amountSats: input.amountSats,
    network: input.network,
    paymentRequest: invoice.paymentRequest,
    paymentHash: invoice.paymentHash,
    expiresAt: invoice.expiresAt,
  })
  witnessOrigins.set(witness, {
    checkoutId: input.checkoutId,
    shouldContinue: input.shouldContinue,
  })
  return witness
}

/**
 * Require a one-to-one, exact recipient/invoice binding for every frozen leg.
 * This is a payment-recipient invariant, not a display-profile lookup.
 */
export function assertCheckoutSparkRouterInvoiceWitnesses(input: {
  checkoutId: string
  network: CheckoutSparkNetwork
  nowSeconds: number
  obligations: readonly CheckoutSparkObligationPlanInput[]
  witnesses: readonly CheckoutSparkPayoutInvoiceWitness[]
}): void {
  const { checkoutId, network, nowSeconds, obligations, witnesses } = input
  assertCheckoutId(checkoutId)
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    !Array.isArray(witnesses) ||
    obligations.length !== witnesses.length ||
    new Set(witnesses).size !== witnesses.length
  ) {
    throw new Error("Checkout Spark payout invoice witnesses do not match.")
  }

  const unmatched = new Set<CheckoutSparkPayoutInvoiceWitness>(witnesses)
  for (const witness of witnesses) {
    const origin = witnessOrigins.get(witness)
    if (
      !origin ||
      origin.checkoutId !== checkoutId ||
      origin.shouldContinue() !== true ||
      witness.checkoutId !== checkoutId ||
      witness.network !== network ||
      witness.expiresAt <= nowSeconds
    ) {
      throw new Error("Checkout Spark payout invoice witness is not current.")
    }
  }

  for (const obligation of obligations) {
    const witness = [...unmatched].find(
      (candidate) =>
        candidate.amountSats === obligation.amountSats &&
        candidate.paymentRequest === obligation.paymentRequest &&
        (obligation.kind === "conduit"
          ? "recipientId" in candidate &&
            obligation.recipientId === CONDUIT_CHECKOUT_FEE_RECIPIENT &&
            candidate.recipientId === CONDUIT_CHECKOUT_FEE_RECIPIENT &&
            candidate.lud16 === CONDUIT_CHECKOUT_FEE_RECIPIENT
          : "recipientPubkey" in candidate &&
            candidate.recipientPubkey === obligation.recipientId)
    )
    if (!witness) {
      throw new Error("Checkout Spark payout invoice witnesses do not match.")
    }
    unmatched.delete(witness)
  }
}
