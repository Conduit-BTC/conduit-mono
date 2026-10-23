import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  DexieCheckoutSparkSettledRepository,
  checkoutSparkConduitFeeRecipient,
  parseProductEvent,
} from "@conduit/core"
import { encodeSparkAddress } from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import { prepareCheckoutSparkSettledFunding } from "../apps/market/src/lib/checkout-spark-settled-preparation"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import { plainTestSigner } from "./helpers/plain-signer"
import { admitFixture } from "./helpers/public-event"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import { qualifiedReceiverMetadataFixture } from "./support/checkout-spark-qualified-receiver-fixture"

async function rejectedPreparation(input: {
  feeSats: number
  commerceTotalSats: number
  organizerMinSendable?: number
}) {
  const graph = checkoutSparkEventMarketFixture({
    commerceTotalSats: input.commerceTotalSats,
    receiverDomain: "wallet.conduit.market",
    organizerFee: {
      state: "active",
      basisPoints: 0,
      minimumSats: input.feeSats,
      lightningAddress: "organizer@wallet.conduit.market",
    },
  })
  const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
  const order = createCheckoutSparkEventMarketFixtureOrder(
    graph,
    buyer.pubkey,
    AT
  )
  const product = {
    ...parseProductEvent(await admitFixture(graph.events.product)),
    sourceEventId: graph.events.product.id,
  }
  const quoteAuthority = buildCheckoutSparkQuoteAuthority({
    authorization: {
      status: "ok",
      items: [
        {
          ...createCartItemFromProduct(product, order.items[0]!.fulfillment),
          quantity: 1,
        },
      ],
      listingReadProducts: [product],
      fulfillmentResolvedProducts: [product],
      shippingOptionEvidence: { status: "not_required", options: [] },
      pickupSourceEvents: graph.sourceEvents,
    },
    rateInput: null,
    nowMs: AT,
  })
  const database = new ConduitDB(`event-preparation-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const calls = {
    walletMaterial: 0,
    wallet: 0,
    invoice: 0,
    organizerMetadata: 0,
  }
  try {
    let error: unknown
    try {
      await prepareCheckoutSparkSettledFunding(
        {
          checkoutId: graph.plan.checkoutId,
          orderId: graph.plan.orderId,
          merchantPubkey: graph.merchantPubkey,
          network: "mainnet",
          takeoverAt: AT + 120_000,
          grossFundingSats: graph.plan.funding.grossFundingSats,
          fundingExpirySecs: 3_600,
          identity: { kind: "signed_in", pubkey: buyer.pubkey, signer: buyer },
          quoteAuthority,
          eventMarket: quoteAuthority.eventMarket,
          sourceEvents: graph.sourceEvents,
          recipients: graph.input.recipients.map((recipient) =>
            recipient.kind !== "conduit"
              ? recipient
              : {
                  ...recipient,
                  recipientId: checkoutSparkConduitFeeRecipient("production"),
                  destination: {
                    type: "lightning_address",
                    value: checkoutSparkConduitFeeRecipient("production"),
                    source: { type: "conduit_allowlist", policy: "production" },
                  },
                }
          ),
          storage,
          recoveryStorage: storage,
        },
        {
          now: () => AT,
          repository: new DexieCheckoutSparkSettledRepository(database),
          receiverContracts: qualifiedReceiverMetadataFixture(
            "merchant@wallet.conduit.market"
          ).contracts,
          fetchPayoutMetadata: async (address) => {
            const organizer = address === "organizer@wallet.conduit.market"
            if (organizer) calls.organizerMetadata++
            return qualifiedReceiverMetadataFixture(
              address,
              organizer ? { minSendable: input.organizerMinSendable } : {}
            ).metadata
          },
          treasuryConfiguration: {
            mainnetAddress: encodeSparkAddress({
              identityPublicKey:
                "0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
              network: "MAINNET",
            }),
          },
          createWalletMaterial: () => {
            calls.walletMaterial++
            throw new Error("Unexpected wallet material")
          },
          openWallet: async () => {
            calls.wallet++
            throw new Error("Unexpected wallet")
          },
          createFundingReceive: async () => {
            calls.invoice++
            throw new Error("Unexpected invoice")
          },
        }
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(calls.walletMaterial).toBe(0)
    expect(calls.wallet).toBe(0)
    expect(calls.invoice).toBe(0)
    expect(values.size).toBe(0)
    return { error: error as Error, calls }
  } finally {
    database.close()
    await database.delete()
  }
}

describe("event organizer prefunding amount admission", () => {
  it("rejects a one-sat organizer fee with an actionable reserve error before creating a wallet or invoice", async () => {
    const result = await rejectedPreparation({
      feeSats: 1,
      commerceTotalSats: 1_000,
    })
    expect(result.error.message).toContain(
      "too small to cover its payment reserve"
    )
    expect(result.calls.organizerMetadata).toBe(0)
  })

  it("does not use a large commerce balance to admit an organizer endpoint above its exact four-sat ceiling", async () => {
    const result = await rejectedPreparation({
      feeSats: 5,
      commerceTotalSats: 100_000,
      organizerMinSendable: 5_000,
    })
    expect(result.error.message).toContain("payment endpoint is not ready")
    expect(result.calls.organizerMetadata).toBe(1)
  })
})
