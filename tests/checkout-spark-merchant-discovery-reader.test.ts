import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkRecoveryRumor,
  calculateCheckoutSparkSettledGrossFundingSats,
  calculateConduitCheckoutFeeSats,
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createMerchantCheckoutSparkRecoveryDiscovery,
  deriveCheckoutSparkSignedCommerceObligations,
  DexieCheckoutSparkSettledRepository,
  freezeCheckoutSparkSettledPlan,
  orderSchema,
  wrapPrivateMessage,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  __resetInboxDeclarationCache,
  resolveInboxDeclaration,
  sharedInboxDiscoveryRelayUrls,
} from "../packages/core/src/protocol/private-message-routing"
import { createInMemoryInboxDeclarationEvidenceRepository } from "../packages/core/src/protocol/inbox-declaration-evidence"
import {
  __resetPublicReaderTestState,
  fetchPublicEventsWithDiagnostics,
} from "../packages/core/src/protocol/relay-reader"
import { relayTargetsFromUrls } from "../packages/core/src/protocol/relay-authority"
import {
  applyAccountNetworkRelayExclusion,
  createInMemoryAccountNetworkLocalStateRepository,
  emptyAccountNetworkLocalState,
} from "../packages/core/src/protocol/account-network-local-state"
import { visitProtectedInboxHistoryPage } from "../packages/core/src/protocol/protected-inbox-history"
import {
  clearTestAccountSigner,
  plainTestSigner,
  setTestAccountSigner,
} from "./helpers/plain-signer"
import { createCheckoutSparkGuestSupplierFixture } from "./support/checkout-spark-guest-supplier-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const INBOX = "wss://discovery.inbox.conduit.market"
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")

class Socket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent | Event) => void) | null = null

  constructor(
    readonly url: string,
    private readonly events: readonly SignedPublicNostrEvent[]
  ) {
    queueMicrotask(() => {
      if (this.readyState === 3) return
      this.readyState = 1
      this.onopen?.(new Event("open"))
    })
  }

  send(payload: string) {
    const frame = JSON.parse(payload) as unknown[]
    if (frame[0] !== "REQ") return
    queueMicrotask(() => {
      for (const event of this.events)
        this.onmessage?.({
          data: JSON.stringify(["EVENT", frame[1], event]),
        } as MessageEvent<string>)
      this.onmessage?.({
        data: JSON.stringify(["EOSE", frame[1]]),
      } as MessageEvent<string>)
    })
  }

  close() {
    this.readyState = 3
  }
}

async function fixture() {
  const createdAt = Math.floor(Date.now() / 1_000) * 1_000
  const source = await createCheckoutSparkGuestSupplierFixture(createdAt)
  const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
  const quote = buildCheckoutSparkCommerceEvidence(source.quoteAuthority)
  const obligations = deriveCheckoutSparkSignedCommerceObligations({
    quote,
    products: source.products,
    merchantPubkey: source.merchantPubkey,
  })
  const gross = calculateCheckoutSparkSettledGrossFundingSats(
    quote.commerceTotalSats
  )
  const fundingInvoice = makeSignedBolt11Fixture({
    hrp: `lnbc${gross * 10}n`,
    createdAt: createdAt / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      { tag: "x", words: [28, 4] },
    ],
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "real-reader-checkout",
    orderId: "real-reader-order",
    merchantPubkey: source.merchantPubkey,
    walletId: "real-reader-wallet",
    network: "mainnet",
    createdAt,
    takeoverAt: createdAt + 120_000,
    commerceQuote: quote,
    funding: {
      requestId: "real-reader-funding",
      paymentRequest: fundingInvoice,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"a".repeat(64)}`,
      grossFundingSats: gross,
      createdAt,
      expiresAt: createdAt + 900_000,
    },
    recipients: [
      ...obligations.map((obligation) => {
        const profile =
          obligation.kind === "merchant"
            ? source.merchantProfile
            : source.supplierProfile
        return {
          kind: obligation.kind,
          recipientId: obligation.recipientId,
          weightSats: obligation.amountSats,
          destination: {
            type: "lightning_address" as const,
            value:
              source.profileContexts[obligation.recipientId]!.profile.lud16!,
            source: {
              type: "signed_profile" as const,
              profileEventId: profile.id,
              profileEventCreatedAt: profile.created_at,
            },
          },
        }
      }),
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        weightSats: calculateConduitCheckoutFeeSats(quote.commerceTotalSats),
        destination: {
          type: "lightning_address",
          value: "conduithodlings@strike.me",
          source: { type: "conduit_allowlist", policy: "production" },
        },
      },
    ],
  })
  const state = createCheckoutSparkSettledReconciliation(plan)
  const payload = createCheckoutSparkSettledRecoveryPayload({
    state,
    sourceEvents: source.sourceEvents,
    senderPubkey: buyer.pubkey,
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 0,
    preparedAt: createdAt + 1,
  })
  const recovery = await wrapPrivateMessage(
    buildCheckoutSparkRecoveryRumor(payload),
    new NDKUser({ pubkey: source.merchantPubkey }),
    buyer
  )
  const order = orderSchema.parse({
    id: plan.orderId,
    buyerPubkey: buyer.pubkey,
    buyerIdentityKind: "signed_in",
    merchantPubkey: source.merchantPubkey,
    items: source.quoteAuthority.pricing.items,
    subtotal: quote.commerceTotalSats,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt: createdAt + 1,
  })
  const rumor = new NDKEvent(undefined, {
    kind: 16,
    pubkey: buyer.pubkey,
    created_at: createdAt / 1_000,
    tags: [
      ["p", source.merchantPubkey],
      ["type", "order"],
      ["order", plan.orderId],
      ["amount", String(quote.commerceTotalSats)],
      ["currency", "SATS"],
      [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
      ...order.items.map((item) => [
        "item",
        item.productId,
        String(item.quantity),
      ]),
    ],
    content: JSON.stringify(order),
  })
  rumor.id = rumor.getEventHash()
  const orderWrap = await wrapPrivateMessage(
    rumor,
    new NDKUser({ pubkey: source.merchantPubkey }),
    buyer
  )
  const declaration = new NDKEvent(undefined, {
    kind: 10_050,
    created_at: createdAt / 1_000,
    tags: [["relay", INBOX]],
    content: "",
  })
  await declaration.sign(source.merchantSigner)
  const evidenceRepository = createInMemoryInboxDeclarationEvidenceRepository()
  const resolved = await resolveInboxDeclaration(source.merchantPubkey, {
    evidenceRepository,
    relayUrls: [sharedInboxDiscoveryRelayUrls()[0]!],
    fetchEventsWithDiagnostics: (filter, options) =>
      fetchPublicEventsWithDiagnostics(filter, {
        ...options,
        reuseRelayConnections: false,
        socketScope: {
          createWebSocket: (url) =>
            new Socket(url, [declaration.rawEvent() as SignedPublicNostrEvent]),
        },
      }),
  })
  expect(resolved.state).toBe("declared")
  expect(resolved.stale).toBe(false)
  const signer = setTestAccountSigner(source.merchantSigner)
  installProtectedReadSigner(signer, source.merchantPubkey, () => true)
  const sockets: Socket[] = []
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class extends Socket {
      constructor(url: string) {
        super(url, [recovery, orderWrap] as SignedPublicNostrEvent[])
        sockets.push(this)
      }
    },
  })
  const database = new ConduitDB(`real-reader-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const repository = new DexieCheckoutSparkSettledRepository(database)
  const localStateRepository =
    createInMemoryAccountNetworkLocalStateRepository()
  __setCommerceTestOverrides({
    getAccountSigner: () => signer,
    checkoutSparkSettledRepository: repository,
    accountNetworkLocalStateRepository: localStateRepository,
  })
  return {
    plan,
    state,
    source,
    sockets,
    database,
    repository,
    evidenceRepository,
    blockInbox: async () => {
      await localStateRepository.replace(
        source.merchantPubkey,
        applyAccountNetworkRelayExclusion(
          emptyAccountNetworkLocalState(source.merchantPubkey),
          {
            relayUrl: INBOX,
            relayListFrontier: { eventId: null, createdAt: null },
            inboxDeclarationFrontier: {
              eventId: declaration.id,
              createdAt: declaration.created_at,
            },
            committedAt: Date.now(),
          }
        )
      )
    },
  }
}

afterEach(() => {
  clearTestAccountSigner()
  __resetProtectedReadSigner()
  __resetCommerceTestOverrides()
  __resetInboxDeclarationCache()
  __resetPublicReaderTestState()
  if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

describe("cold Merchant discovery through the real protected reader", () => {
  it("admits a current owner inbox history page only through its exact signed grant", async () => {
    const test = await fixture()
    try {
      let visited = 0
      const result = await visitProtectedInboxHistoryPage({
        principalPubkey: test.plan.merchantPubkey,
        relayUrl: INBOX,
        authorizedRelayUrls: [INBOX],
        relayTargets: relayTargetsFromUrls([INBOX], {
          kind: "owner_nip17",
          operation: "read",
          ownerPubkey: test.plan.merchantPubkey,
        }),
        authorization: getProtectedReadAuthorization(test.plan.merchantPubkey)!,
        accountNetworkLocalStateRepository: { get: async () => undefined },
        visit: async () => {
          visited++
        },
      })
      expect(result.status).toBe("source_eose")
      expect(visited).toBe(2)
      expect(test.sockets).toHaveLength(1)
    } finally {
      await test.database.delete()
    }
  })

  it("persists the exact frozen recovery plan and matching order before takeover without wallet I/O", async () => {
    const test = await fixture()
    const discovery = await createMerchantCheckoutSparkRecoveryDiscovery(
      test.plan.merchantPubkey,
      {
        onOrderRecovery: async ({
          state,
          witness,
          sourceEvents,
          assertCurrent,
        }) => {
          await test.repository.importMerchantOrderRecovery(
            state,
            witness,
            assertCurrent
          )
          await test.repository.recordMerchantPlanSources(
            state.plan,
            sourceEvents,
            assertCurrent
          )
        },
      }
    )
    try {
      const found = await discovery.nextPage()
      expect(found.candidates).toHaveLength(1)
      expect(found.history.pageStatus).toBe("source_eose")
      expect(found.orderBindingFailureCount ?? 0).toBe(0)
      const saved = await test.repository.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status).toBe("active")
      if (saved.status === "active") {
        expect(saved.state).toEqual(test.state)
        expect(saved.state.plan.takeoverAt).toBe(test.plan.takeoverAt)
        expect(saved.state.plan.funding.expiresAt).toBe(
          test.plan.funding.expiresAt
        )
      }
      expect(test.sockets).toHaveLength(1)
    } finally {
      discovery.dispose()
      await test.database.delete()
    }
  })

  it("denies discovery contact and import when the current account excludes its earlier signed inbox", async () => {
    const test = await fixture()
    await test.blockInbox()
    let imports = 0
    const discovery = await createMerchantCheckoutSparkRecoveryDiscovery(
      test.plan.merchantPubkey,
      {
        onOrderRecovery: async ({ state, witness, assertCurrent }) => {
          imports++
          await test.repository.importMerchantOrderRecovery(
            state,
            witness,
            assertCurrent
          )
        },
      }
    )
    try {
      const found = await discovery.nextPage()
      expect(found.candidates).toHaveLength(0)
      expect(test.sockets).toHaveLength(0)
      expect(imports).toBe(0)
      expect(
        (await test.repository.load(test.plan.checkoutId, test.plan.planDigest))
          .status
      ).toBe("absent")
    } finally {
      discovery.dispose()
      await test.database.delete()
    }
  })
})
