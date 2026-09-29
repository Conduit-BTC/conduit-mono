import {
  getProfiles,
  resolveCheckoutSparkRecipientPayoutAddress,
  type CheckoutSparkRecipientPayoutAddressResolution,
} from "@conduit/core"

const PUBKEY = /^[0-9a-f]{64}$/

export interface CheckoutSparkRecipientProfileReadInput {
  recipientPubkey: string
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  shouldContinue: () => boolean
}

export async function readCheckoutSparkRecipientPayoutAddress(
  input: CheckoutSparkRecipientProfileReadInput,
  dependencies: { readProfiles?: typeof getProfiles } = {}
): Promise<CheckoutSparkRecipientPayoutAddressResolution> {
  if (!PUBKEY.test(input.recipientPubkey)) {
    throw new Error("Checkout Spark recipient pubkey is invalid.")
  }

  const assertCurrentSession = () => {
    if (input.shouldContinue() !== true) {
      throw new Error("Checkout session changed during recipient verification.")
    }
  }
  assertCurrentSession()

  let result: Awaited<ReturnType<typeof getProfiles>>
  try {
    result = await (dependencies.readProfiles ?? getProfiles)({
      pubkeys: [input.recipientPubkey],
      accountPubkey: input.accountPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "payment",
      priority: "visible",
    })
  } catch (error) {
    assertCurrentSession()
    throw error
  }
  assertCurrentSession()

  return resolveCheckoutSparkRecipientPayoutAddress({
    recipientPubkey: input.recipientPubkey,
    context: result.profileContexts[input.recipientPubkey],
    readMeta: result.meta,
  })
}
