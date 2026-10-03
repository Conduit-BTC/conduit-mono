import {
  calculateConduitCheckoutFeeSats,
  createSelectedProfileContext,
  type LnurlPayMetadata,
} from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  resolveCheckoutSparkConduitInvoiceWitness,
  resolveCheckoutSparkRecipientInvoiceWitness,
  type CheckoutSparkPayoutInvoiceWitness,
} from "../../apps/market/src/lib/checkout-spark-recipient-invoice-witness"
import type { PrepareCheckoutSparkRouterFundingInput } from "../../apps/market/src/lib/checkout-spark-router-preparation"

type ProfileRead = Awaited<
  ReturnType<typeof import("@conduit/core").getProfiles>
>

const LUD16 = "seller@wallet.conduit.market"
const CALLBACK = "https://wallet.conduit.market/lnurlp/callback"

function metadata(): LnurlPayMetadata {
  return {
    payRequestUrl: "https://wallet.conduit.market/.well-known/lnurlp/seller",
    lnurl: "lnurl1test",
    callback: CALLBACK,
    minSendable: 1_000,
    maxSendable: 10_000_000,
    tag: "payRequest",
    allowsNostr: false,
    metadata: "[]",
  }
}

/** Stub the trusted getProfiles boundary only for preparation unit tests. */
function profileRead(
  recipientPubkey: string,
  nowSeconds: number,
  signingKeys: ReadonlyMap<string, Uint8Array>
): ProfileRead {
  const signingKey = signingKeys.get(recipientPubkey)
  if (!signingKey || getPublicKey(signingKey) !== recipientPubkey) {
    throw new Error("Router fixture requires the exact recipient signing key.")
  }
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: nowSeconds - 100,
      tags: [],
      content: JSON.stringify({ lud16: LUD16 }),
    },
    signingKey
  )
  const context = {
    ...createSelectedProfileContext({
      pubkey: recipientPubkey,
      row: {
        pubkey: recipientPubkey,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        rawContent: event.content,
        cachedAt: Date.now(),
      },
      observed: true,
      readComplete: true,
    }),
    signedEvent: event,
  }
  return {
    data: { [recipientPubkey]: context.profile },
    profileContexts: { [recipientPubkey]: context },
    meta: {
      stale: false,
      degraded: false,
      capped: false,
    } as ProfileRead["meta"],
  }
}

export async function mockRouterInvoiceWitnesses(
  input: Pick<
    PrepareCheckoutSparkRouterFundingInput,
    "checkoutId" | "network" | "routerObligationInputs"
  >,
  nowSeconds: number,
  signingKeys: ReadonlyMap<string, Uint8Array>,
  shouldContinue = () => true
): Promise<readonly CheckoutSparkPayoutInvoiceWitness[]> {
  const recipients = [
    ...input.routerObligationInputs.commerce,
    ...(input.routerObligationInputs.organizer
      ? [input.routerObligationInputs.organizer]
      : []),
  ]
  const witnesses = await Promise.all(
    recipients.map((obligation) =>
      resolveCheckoutSparkRecipientInvoiceWitness(
        {
          checkoutId: input.checkoutId,
          recipientPubkey: obligation.recipientId,
          amountSats: obligation.amountSats,
          network: input.network,
          nowSeconds,
          shouldContinue,
        },
        {
          profile: {
            readProfiles: async () =>
              profileRead(obligation.recipientId, nowSeconds, signingKeys),
          },
          lnurl: {
            fetchMetadata: async () => metadata(),
            fetchInvoice: async () => ({ invoice: obligation.paymentRequest }),
          },
        }
      )
    )
  )
  const conduit = await resolveCheckoutSparkConduitInvoiceWitness(
    {
      checkoutId: input.checkoutId,
      amountSats: calculateConduitCheckoutFeeSats(
        input.routerObligationInputs.commerceTotalSats
      ),
      network: input.network,
      nowSeconds,
      shouldContinue,
    },
    {
      fetchMetadata: async () => metadata(),
      fetchInvoice: async () => ({
        invoice: input.routerObligationInputs.conduit.paymentRequest,
      }),
    }
  )
  return Object.freeze([...witnesses, conduit])
}

export async function withMockRouterInvoiceWitnesses<
  T extends Pick<
    PrepareCheckoutSparkRouterFundingInput,
    "checkoutId" | "network" | "routerObligationInputs"
  >,
>(
  input: T,
  nowSeconds: number,
  signingKeys: ReadonlyMap<string, Uint8Array>
): Promise<
  T & {
    invoiceWitnesses: readonly CheckoutSparkPayoutInvoiceWitness[]
  }
> {
  return {
    ...input,
    invoiceWitnesses: await mockRouterInvoiceWitnesses(
      input,
      nowSeconds,
      signingKeys
    ),
  }
}
