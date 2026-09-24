import type { CheckoutSparkNetwork } from "@conduit/core"

import {
  resolveCheckoutSparkLnurlInvoice,
  type CheckoutSparkLnurlInvoiceDependencies,
} from "./checkout-spark-lnurl-invoice"
import {
  readCheckoutSparkRecipientPayoutAddress,
  type CheckoutSparkRecipientProfileReadInput,
} from "./checkout-spark-recipient-profile"

export interface CheckoutSparkRecipientInvoiceWitness {
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
  /** Exact amount from the frozen, authorized payout obligation. */
  amountSats: number
  network: CheckoutSparkNetwork
  nowSeconds: number
}

export interface CheckoutSparkRecipientInvoiceWitnessDependencies {
  profile?: Parameters<typeof readCheckoutSparkRecipientPayoutAddress>[1]
  lnurl?: CheckoutSparkLnurlInvoiceDependencies
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

  return Object.freeze({
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
}
