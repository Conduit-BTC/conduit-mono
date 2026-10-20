import { afterEach, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { generateSecretKey } from "nostr-tools/pure"
import { ConduitDB } from "@conduit/core/db"
import { config } from "@conduit/core/config"
import {
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  normalizeCommercePrice,
  parseProductEvent,
  checkoutSparkConduitFeeRecipient,
  DexieCheckoutSparkSettledRepository,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { freezeCheckoutSparkSettledEventPlan } from "@conduit/core/protocol/checkout-spark-settled-router"
import { buildEventMarketAssignmentDraft } from "@conduit/core/protocol/event-market-assignment"
import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
} from "@conduit/core/protocol/event-market-stock-authority"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "@conduit/core/protocol/checkout-spark-pricing-authority-server"
import { getConduitNip89AppDefinition } from "@conduit/core/protocol/nip89"
import { CommerceInbox } from "@conduit/core/protocol/commerce-inbox"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import { SessionSigner } from "@conduit/core/protocol/session-signer"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { readRetainedCheckoutSparkOrganizerRecoveries } from "@conduit/core/protocol/checkout-spark-organizer-discovery"
import { orderSchema } from "@conduit/core/schemas"
import { prepareCheckoutSparkSettledFunding } from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  publishCheckoutSparkEventRecoveryHandoff,
  acknowledgeCheckoutSparkSettledSnapshot,
  getCheckoutSparkRecoveryDelivery,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
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
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []
const previousPricingKeys = config.checkoutSparkPricingPublicKeys
const previousMarketClient = getConduitNip89AppDefinition("market").pubkey
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  config.checkoutSparkPricingPublicKeys = previousPricingKeys
  getConduitNip89AppDefinition("market").pubkey = previousMarketClient
  for (const database of databases.splice(0)) await database.delete()
})

it("round-trips the actual USD variation preparation and two-recipient app handoff into mixed-client Organizer discovery", async () => {
  const currencies = SUPPORTED_PRODUCT_PRICE_CURRENCIES.filter(
    (currency) => currency !== "SATS" && currency !== "USD"
  )
  const rate = {
    rate: 82_000.123456789,
    fetchedAt: AT - 1_000,
    source: "coinbase" as const,
    fiatUsdRates: Object.fromEntries(
      currencies.map((currency, index) => [
        currency,
        0.0123456789012345 * (index + 1),
      ])
    ),
    fiatSource: "frankfurter" as const,
    fiatSources: Object.fromEntries(
      currencies.map((currency) => [currency, "frankfurter" as const])
    ),
  }
  expect(currencies.length + 1).toBe(30)
  const price = normalizeCommercePrice(0.5, "USD", rate)
  if (price.status !== "ok") throw new Error("Fixture conversion unavailable")
  const source = checkoutSparkEventMarketFixture({
    commerceTotalSats: price.sats,
    supplier: true,
    variation: true,
    mode: "organizer_handoff",
    receiverDomain: "wallet.conduit.market",
    stockGrant: { writerId: crypto.randomUUID(), quantity: 4 },
    organizerFee: {
      state: "active",
      basisPoints: 250,
      minimumSats: 50,
      lightningAddress: "organizer@wallet.conduit.market",
    },
  })
  const product = source.signMerchant({
    ...source.events.product,
    tags: source.events.product.tags.map((tag) =>
      tag[0] === "price"
        ? ["price", "0.5", "USD"]
        : tag[0] === "spec"
          ? ["spec", "Size", "Small"]
          : tag[0] === "zap" && tag[1] === source.merchantPubkey
            ? [...tag.slice(0, 3), "3"]
            : tag
    ),
  })
  const parentProduct = source.signMerchant({
    ...source.events.parentProduct!,
    tags: source.events.parentProduct!.tags.map((tag) =>
      tag[0] === "price" ? ["price", "0.5", "USD"] : tag
    ),
  })
  const originalGrant = parseEventMarketStockAuthorityRumor(source.stockGrant!)
  if (originalGrant.type !== "grant")
    throw new Error("Fixture grant unavailable")
  const stockGrant = createEventMarketStockAuthorityRumor({
    createdAt: source.stockGrant!.created_at!,
    payload: { ...originalGrant, productEventId: product.id },
  })
  const assignment = source.signMerchant(
    buildEventMarketAssignmentDraft({
      marketCoordinate: source.eventMarket.marketCoordinate,
      occurrenceCoordinate: source.eventMarket.occurrenceCoordinate,
      productCoordinate: source.eventMarket.lines[0]!.productCoordinate,
      merchantPubkey: source.merchantPubkey,
      state: "active",
      inventory: { mode: "tracked", quantity: 5 },
      fulfillmentMethods: ["pickup"],
      previousEventId: source.originalAssignment.id,
      organizerStockPool: {
        state: "active",
        poolId: stockGrant.id,
        organizerPubkey: source.organizerPubkey,
        quantity: 4,
        importedQuantity: 0,
      },
    })
  )
  // Dedicated runtime-generated pricing identity, never an app or service credential.
  const privateKeyHex = Buffer.from(generateSecretKey()).toString("hex")
  const pricingAuthority = createCheckoutSparkPricingRateAttestation({
    rate,
    keyId: "closed-loop-fixture",
    privateKeyHex,
    issuedAtMs: AT - 500,
  })
  config.checkoutSparkPricingPublicKeys = `closed-loop-fixture:${getCheckoutSparkPricingAuthorityPublicKey(privateKeyHex)}`
  const eventMarket = {
    ...source.eventMarket,
    lines: source.eventMarket.lines.map((line) => ({
      ...line,
      productEventId: product.id,
      assignmentEventId: assignment.id,
      stockPoolId: stockGrant.id,
      parentProduct: { ...line.parentProduct!, eventId: parentProduct.id },
    })),
  }
  const sourceEvents = source.sourceEvents.map((event) =>
    event.id === source.events.product.id
      ? product
      : event.id === source.events.parentProduct!.id
        ? parentProduct
        : event.id === source.events.assignment.id
          ? assignment
          : event
  )
  const input = {
    ...source.input,
    eventMarket,
    commerceQuote: {
      ...source.input.commerceQuote!,
      pricing: { version: 1 as const, rate },
      pricingAuthority,
      lines: source.input.commerceQuote!.lines.map((line) => ({
        ...line,
        productEventId: product.id,
        sourcePrice: {
          amount: 0.5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        variation: {
          ...line.variation!,
          specifications: [{ key: "Size", value: "Small" }],
        },
      })),
    },
    recipients: source.input.recipients.map((recipient) =>
      recipient.kind === "merchant"
        ? { ...recipient, weightSats: price.sats - Math.floor(price.sats / 4) }
        : recipient.kind === "supplier"
          ? { ...recipient, weightSats: Math.floor(price.sats / 4) }
          : recipient
    ),
  }
  const graph = {
    ...source,
    input,
    eventMarket,
    sourceEvents,
    stockGrant,
    plan: freezeCheckoutSparkSettledEventPlan(input),
    events: { ...source.events, product, parentProduct, assignment },
  }
  const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
  const order = orderSchema.parse({
    ...createCheckoutSparkEventMarketFixtureOrder(graph, buyer.pubkey, AT),
    buyerIdentityKind: "signed_in",
    shippingCostStatus: "included",
    checkoutSparkPricing: graph.plan.commerceQuote.pricing,
    checkoutSparkPricingAuthority: pricingAuthority,
  })
  const listing = {
    ...parseProductEvent(await admitFixture(product)),
    sourceEventId: product.id,
  }
  const quoteAuthority = buildCheckoutSparkQuoteAuthority({
    authorization: {
      status: "ok",
      items: [
        {
          ...createCartItemFromProduct(listing, order.items[0]!.fulfillment),
          familyProductId: listing.parentProductId,
          quantity: 1,
        },
      ],
      listingReadProducts: [listing],
      fulfillmentResolvedProducts: [listing],
      shippingOptionEvidence: { status: "not_required", options: [] },
      pickupSourceEvents: sourceEvents,
    },
    rateInput: rate,
    pricingAuthority,
    nowMs: AT,
  })
  const database = new ConduitDB(`event-fiat-inbox-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(database)
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
  const published: SignedPublicNostrEvent[] = []
  const relays = ["wss://relay.damus.io"]
  const publish = (async (event) => {
    published.push(structuredClone(event))
    return {
      attemptedRelayUrls: relays,
      successfulRelayUrls: relays,
      failedRelayUrls: [],
      relayFailureMessages: {},
    }
  }) as NonNullable<
    Parameters<typeof publishCheckoutSparkEventRecoveryHandoff>[0]["transport"]
  >["publishFn"]
  const transport = { recipientInboxRelays: relays, publishFn: publish }
  getConduitNip89AppDefinition("market").pubkey = buyer.pubkey
  const prepared = await prepareCheckoutSparkSettledFunding(
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
      sourceEvents,
      eventMarket: quoteAuthority.eventMarket,
      organizerOrder: order,
      storage,
      recoveryStorage: storage,
      recipients: input.recipients.map((recipient) =>
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
    },
    {
      now: () => AT,
      repository: new DexieCheckoutSparkSettledRepository(database),
      receiverContracts: qualifiedReceiverMetadataFixture(
        "merchant@wallet.conduit.market"
      ).contracts,
      fetchPayoutMetadata: async (address) =>
        qualifiedReceiverMetadataFixture(address).metadata,
      treasuryConfiguration: {
        mainnetAddress: graph.plan.nativeTreasury!.sparkAddress,
      },
      validateTreasuryDestination: async () => ({
        sparkAddress: graph.plan.nativeTreasury!.sparkAddress,
        receiverIdentityPublicKey:
          graph.plan.nativeTreasury!.receiverIdentityPublicKey,
      }),
      prepareTreasuryRequest: async (request) => ({
        ...graph.plan.nativeTreasury!,
        senderIdentityPublicKey: request.senderIdentityPublicKey,
        invoiceId: request.invoiceId,
      }),
      createWalletMaterial: () => ({
        walletId: graph.plan.walletId,
        mnemonic: createRuntimeMnemonic(),
        accountNumber: 1,
        network: "mainnet",
      }),
      openWallet: async () => {},
      closeWallet: async () => {},
      createFundingReceive: async () => ({
        walletId: graph.plan.walletId,
        network: "mainnet",
        id: graph.plan.funding.requestId,
        paymentRequest: graph.plan.funding.paymentRequest,
        paymentHash: graph.plan.funding.paymentHash,
        providerStatus: "INVOICE_CREATED",
        requiredNetSats: graph.plan.funding.grossFundingSats,
        grossFundingSats: graph.plan.funding.grossFundingSats,
        expirySecs: 3_600,
        createdAt: AT,
        expiresAt: AT + 3_600_000,
        providerCreatedAtMs: AT,
        providerExpiresAtMs: AT + 3_600_000,
        receiveSettledPolicy: "ordinary-exact-credit-v3",
        receiverIdentityPublicKey: graph.plan.funding.receiverIdentityPublicKey,
      }),
      publishEventRecoveryHandoff: (request) =>
        publishCheckoutSparkEventRecoveryHandoff({
          ...request,
          now: () => AT,
          transport,
          organizerTransport: transport,
        }),
    }
  )
  const saved = getCheckoutSparkRecoveryDelivery(
    prepared.recoveryHandoffId,
    storage
  )!
  expect(published.length).toBe(2)
  expect(saved.organizerDelivery !== undefined).toBe(true)
  // Buyer progress uses the same actual app handoff owner, not a fabricated descriptor.
  await acknowledgeCheckoutSparkSettledSnapshot({
    state: prepared.state,
    initialHandoffId: saved.record.handoffId,
    identity: { kind: "signed_in", pubkey: buyer.pubkey, signer: buyer },
    preparedAt: AT + 1_000,
    now: () => AT + 1_000,
    storage,
    transport,
    organizerTransport: transport,
  })
  expect(published.length).toBe(4)
  // A fresh receiving app has no pricing service initialization or live fetch.
  config.checkoutSparkPricingPublicKeys = null
  getConduitNip89AppDefinition("market").pubkey = source.merchantPubkey
  const clock = { active: true }
  const organizer = new SessionSigner(source.organizerSigner, {
    expectedPubkey: source.organizerPubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => clock.active,
  })
  installProtectedReadSigner(
    organizer,
    source.organizerPubkey,
    () => clock.active
  )
  const authorization = getProtectedReadAuthorization(source.organizerPubkey)!
  const inbox = new CommerceInbox(
    authorization,
    authorization.signer,
    new CommerceInboxStore(authorization, database)
  )
  owners.push(inbox)
  const organizerWraps = published.filter((event) =>
    event.tags.some(
      (tag) => tag[0] === "p" && tag[1] === source.organizerPubkey
    )
  )
  expect(organizerWraps.length).toBe(2)
  // Progress-first arrival must not poison later initial projection or grouping.
  await inbox.ingest(organizerWraps[1]!, relays)
  const progressOnly = await readRetainedCheckoutSparkOrganizerRecoveries({
    inbox,
    marketCoordinate: eventMarket.marketCoordinate,
    shouldContinue: () => clock.active,
  })
  expect(progressOnly.missingInitialCheckouts).toBe(1)
  expect(progressOnly.selections.length).toBe(0)
  await inbox.ingest(organizerWraps[0]!, relays)
  const discovered = await readRetainedCheckoutSparkOrganizerRecoveries({
    inbox,
    marketCoordinate: eventMarket.marketCoordinate,
    shouldContinue: () => clock.active,
  })
  expect(discovered.selections.length).toBe(1)
  expect(discovered.missingInitialCheckouts).toBe(0)
  expect(discovered.conflictingCheckouts).toBe(0)
  expect(discovered.selections[0]!.buyerProgressWraps.length).toBe(1)
  expect(inbox.getSnapshot().diagnostics.states.machine).toBe(2)
  expect(inbox.getSnapshot().diagnostics.states.malformed ?? 0).toBe(0)
  expect(inbox.getSnapshot().directMessages.length).toBe(0)
  expect(inbox.getSnapshot().orderMessages.length).toBe(0)
})
