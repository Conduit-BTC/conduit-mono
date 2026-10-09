import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { admitFixture } from "./helpers/public-event"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure"
import {
  clearTestAccountSigner,
  setTestAccountSigner as setSigner,
} from "./helpers/plain-signer"
import {
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
  buildProductSupplierAllocation,
  config,
  db,
  deriveCheckoutSparkSignedCommerceObligations,
  parseProductEvent,
  type ProductSchema,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { __resetNdkTestState } from "../packages/core/src/protocol/ndk"
import {
  loadProductDraft,
  saveProductDraft,
} from "../apps/merchant/src/lib/productDraft"
import {
  getMerchantProductSupplierAllocationFormState,
  validateMerchantProductSupplierAllocationForm,
  type MerchantProductFormValues,
} from "../apps/merchant/src/lib/productForm"
import { createEmptyProductVariationForm } from "../apps/merchant/src/lib/productVariations"
import { signAndPublishProductWriteBundle } from "../apps/merchant/src/lib/product-publishing"
import { deliverQueuedProductListings } from "../apps/merchant/src/lib/product-listing-delivery"

const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const supplier = getPublicKey(generateSecretKey())
const nextSupplier = getPublicKey(generateSecretKey())
const relayA = "wss://relay.conduit.market"
const relayB = "wss://relay.damus.io"
const dTag = "synthetic-supplier-publication"
const coordinate = `30402:${merchant}:${dTag}`
const policyRepository = { get: async () => undefined }

function allocation(recipient = supplier) {
  const result = buildProductSupplierAllocation({
    merchantPubkey: merchant,
    merchantRelayHint: relayA,
    merchantWeight: 3,
    suppliers: [{ identity: recipient, relayHint: relayB, weight: 1 }],
  })
  if (!result.ok) throw new Error("Invalid synthetic supplier allocation")
  return result.allocation
}

function form(): MerchantProductFormValues {
  return {
    title: "Synthetic supplier product",
    summary: "Offline publication fixture",
    listingAreaCountry: "",
    listingAreaState: "",
    listingAreaPlaceId: null,
    listingAreaMode: "clear",
    price: "1003",
    stock: "5",
    variations: createEmptyProductVariationForm(),
    currency: "SAT",
    format: "digital",
    fulfillment: "digital",
    eventMarketReference: "",
    futureEventMarketReference: "",
    eventHandoffMode: "merchant_handoff",
    merchantPickupTitle: "Merchant booth pickup",
    merchantPickupLocation: "",
    merchantPickupGeohash: "",
    merchantPickupCountry: "US",
    shippingPricingMode: "fixed",
    shippingCost: "",
    usePresetShippingZone: false,
    customShippingConfig: { countries: [] },
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    images: [],
    tags: "digital, supplier, test",
    ...getMerchantProductSupplierAllocationFormState(allocation()),
  }
}

function reloadDraft(
  value: MerchantProductFormValues
): MerchantProductFormValues {
  const target = { merchantPubkey: merchant }
  expect(saveProductDraft(target, value, localStorage)).toBe(true)
  const loaded = loadProductDraft(target, localStorage).draft
  if (!loaded) throw new Error("Synthetic product draft was not retained")
  return loaded
}

function productFromForm(value: MerchantProductFormValues): ProductSchema {
  const validation = validateMerchantProductSupplierAllocationForm(
    value,
    merchant
  )
  expect(validation.canPublish).toBe(true)
  return {
    id: coordinate,
    pubkey: merchant,
    title: value.title,
    summary: value.summary,
    price: Number(value.price),
    stock: Number(value.stock),
    currency: value.currency,
    type: "simple",
    format: "digital",
    visibility: "public",
    specifications: [],
    images: [],
    tags: ["digital", "supplier", "test"],
    supplierAllocation: validation.allocation,
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function routerAllocations(event: SignedPublicNostrEvent) {
  const product = { ...parseProductEvent(event), sourceEventId: event.id }
  return deriveCheckoutSparkSignedCommerceObligations({
    merchantPubkey: merchant,
    quote: {
      commerceTotalSats: 1_003,
      lines: [
        {
          productCoordinate: coordinate,
          productEventId: event.id,
          merchantPubkey: merchant,
          quantity: 1,
          unitMerchandiseSats: 1_003,
          unitShippingSats: 0,
        },
      ],
    },
    products: [product],
  })
}

let restoreBrowser: (() => void) | undefined
let priorCommerceRelayUrls: string[] | undefined

beforeEach(() => {
  priorCommerceRelayUrls = config.commerceRelayUrls
  // These exact planned targets have current App write authority in this
  // controlled fixture; persisted provenance flags alone are not permission.
  config.commerceRelayUrls = [relayA, relayB]
  const deps = (
    db as unknown as {
      _deps: {
        indexedDB?: globalThis.IDBFactory
        IDBKeyRange?: typeof IDBKeyRange
      }
    }
  )._deps
  const priorIndexedDB = deps.indexedDB
  const priorKeyRange = deps.IDBKeyRange
  const priorNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  )
  const priorStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  )
  const values = new Map<string, string>()
  db.close({ disableAutoOpen: false })
  deps.indexedDB = new IDBFactory()
  deps.IDBKeyRange = IDBKeyRange
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async <T>(
          name: string,
          operation: (lock: { name: string }) => Promise<T>
        ) => operation({ name }),
      },
    },
  })
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  })
  restoreBrowser = () => {
    db.close({ disableAutoOpen: false })
    deps.indexedDB = priorIndexedDB
    deps.IDBKeyRange = priorKeyRange
    if (priorNavigator)
      Object.defineProperty(globalThis, "navigator", priorNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
    if (priorStorage)
      Object.defineProperty(globalThis, "localStorage", priorStorage)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
  __resetNdkTestState()
  __resetRelayPublishTestOverrides()
  __setRelayPublishTestOverrides({
    accountNetworkLocalStateRepository: policyRepository,
    planPublishRelays: async () => {
      throw new Error("Unexpected external relay planning")
    },
    publishSignedEventFrameToRelay: async () => {
      throw new Error("Unexpected external relay transport")
    },
  })
  // This signer owns only an ephemeral test key and performs real signatures
  // locally; no account, browser signer, provider, or relay is contacted.
  setSigner(new NDKPrivateKeySigner(merchantSecret))
})

afterEach(() => {
  clearTestAccountSigner()
  if (priorCommerceRelayUrls) config.commerceRelayUrls = priorCommerceRelayUrls
  priorCommerceRelayUrls = undefined
  restoreBrowser?.()
  restoreBrowser = undefined
  __resetRelayPublishTestOverrides()
  __resetNdkTestState()
})

describe("supplier terms through durable Merchant publication", () => {
  it("preserves draft terms, rotates only the new signed revision, and fences old retries", async () => {
    const publishes: Array<{ eventId: string; relayUrl: string }> = []
    const publish = async (
      product: ProductSchema,
      previous?: SignedPublicNostrEvent
    ) => {
      let signed: SignedPublicNostrEvent | undefined
      const before = publishes.length
      await signAndPublishProductWriteBundle(
        {
          merchantPubkey: merchant,
          authenticatedPubkey: merchant,
          durableCommit: {},
          listings: [
            {
              product,
              dTag,
              previousEventId: previous?.id ?? null,
              previousEventCreatedAt: previous?.created_at,
              fulfillmentIntent: previous
                ? {
                    kind: "preserve_existing",
                    baseline: parseProductEvent(previous),
                  }
                : { kind: "digital" },
            },
          ],
          waitForSignerVisibility: async () => {},
          onSignedLocal: async (bundle) => {
            signed = bundle.events[0]!
            expect(publishes).toHaveLength(before)
            expect(
              (
                await db.productListingOutbox.get(
                  bundle.productListingDeliveryJobId!
                )
              )?.signedEvents[0]
            ).toEqual(JSON.parse(JSON.stringify(signed)))
            expect(
              (await db.localProductWriteFrontiers.get(coordinate))?.eventId
            ).toBe(signed.id)
          },
          productListingDeliveryOptions: {
            accountNetworkLocalStateRepository: policyRepository,
            publisher: async ({ signedEvent, relayUrl }) => {
              publishes.push({ eventId: signedEvent.id, relayUrl })
              return { status: relayUrl === relayA ? "acked" : "timed_out" }
            },
          },
        },
        {
          planProductListingRelayTargets: async () => [
            { relayUrl: relayA, ownerSelected: false, appRelay: true },
            { relayUrl: relayB, ownerSelected: false, independentRelay: true },
          ],
          getShippingOptions: async () => {
            throw new Error("Unexpected external shipping read")
          },
          getEventMarketPickups: async () => {
            throw new Error("Unexpected external pickup read")
          },
        }
      )
      if (!signed) throw new Error("Signed supplier listing was not committed")
      expect(verifyEvent(signed)).toBe(true)
      return admitFixture(signed)
    }

    const initialForm = reloadDraft(form())
    const initial = await publish(productFromForm(initialForm))
    const initialTerms = initial.tags.filter(([name]) => name === "zap")
    expect(parseProductEvent(initial).publicZapEnabled).toBe(false)
    expect(routerAllocations(initial)).toEqual([
      { kind: "merchant", recipientId: merchant, amountSats: 753 },
      { kind: "supplier", recipientId: supplier, amountSats: 250 },
    ])

    const preserved = await publish(
      { ...parseProductEvent(initial), title: "Edited title" },
      initial
    )
    expect(preserved.tags.filter(([name]) => name === "zap")).toEqual(
      initialTerms
    )
    expect(
      parseProductEvent(preserved).supplierAllocation?.revisionEventId
    ).toBe(preserved.id)

    const rotatedForm = reloadDraft({
      ...initialForm,
      ...getMerchantProductSupplierAllocationFormState(
        allocation(nextSupplier)
      ),
    })
    const rotated = await publish(
      {
        ...parseProductEvent(preserved),
        supplierAllocation: productFromForm(rotatedForm).supplierAllocation,
      },
      preserved
    )
    expect(rotated.created_at).toBeGreaterThan(preserved.created_at)
    expect(routerAllocations(rotated)).toEqual([
      { kind: "merchant", recipientId: merchant, amountSats: 753 },
      { kind: "supplier", recipientId: nextSupplier, amountSats: 250 },
    ])
    expect(routerAllocations(initial)[1]?.recipientId).toBe(supplier)

    const sendsBeforeRetry = publishes.length
    for (const old of [initial, preserved]) {
      const jobId = `product-listing:${old.id}`
      const historical = await db.productListingOutbox.get(jobId)
      expect(historical?.localReplaySupersededBy?.[old.id]).toBeString()
      expect(
        historical?.relayDelivery.find((pair) => pair.relayUrl === relayB)
          ?.status
      ).toBe("timed_out")
      await deliverQueuedProductListings(jobId, {
        expectedSignedEvents: [old],
        accountNetworkLocalStateRepository: policyRepository,
        publisher: async ({ signedEvent, relayUrl }) => {
          publishes.push({ eventId: signedEvent.id, relayUrl })
          return { status: "acked" }
        },
      })
      expect(
        (await db.productListingOutbox.get(jobId))?.signedEvents[0]
      ).toEqual(JSON.parse(JSON.stringify(old)))
    }
    expect(publishes).toHaveLength(sendsBeforeRetry)
    expect((await db.products.get(coordinate))?.eventId).toBe(rotated.id)
    expect(
      (await db.products.get(coordinate))?.supplierAllocation?.recipients[1]
        ?.pubkey
    ).toBe(nextSupplier)
    expect(await db.localProductWriteIntents.count()).toBe(3)
  })
})
