import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import { db } from "../../packages/core/src/db"
import { commitLocalProductWrite } from "../../packages/core/src/protocol/local-product-write"
import { withLocalLegacyProductWriteStage } from "../../packages/core/src/protocol/local-product-write"
import { projectSignedProductListingForLocalCommit } from "../../packages/core/src/protocol/commerce"
import { withMerchantStockLock } from "../../apps/merchant/src/lib/productStock"
import {
  confirmLocalProductStockRecovery,
  getLocalProductStockRecoveryForOrder,
  settleLocalProductStockRecovery,
} from "../../packages/core/src/protocol/local-product-stock"
import { getProductListingDeliveryJobId } from "../../packages/core/src/protocol/product-listing-delivery"
import {
  buildProductDeletionEventDraft,
  buildProductListingEventDraft,
} from "../../packages/core/src/protocol/products"
import { EVENT_KINDS } from "../../packages/core/src/protocol/kinds"
import type { ProductSchema } from "../../packages/core/src/schemas"
import type {
  LocalProductShippingJob,
  ProductDeletionDeliveryJob,
  ProductListingDeliveryJob,
} from "../../packages/core/src/db"

const fixtureWindow = window as Window & {
  __localProductWriteFixtureKeyBytes?: number[]
}
const fixtureKeyBytes = fixtureWindow.__localProductWriteFixtureKeyBytes
if (!fixtureKeyBytes)
  throw new Error("Local product-write fixture key is missing")
delete fixtureWindow.__localProductWriteFixtureKeyBytes
const secret = Uint8Array.from(fixtureKeyBytes)
const merchantPubkey = getPublicKey(secret)
const relayUrl = "wss://product-write-fixture.example"
const shippingDTag = "cnd-356-atomic-shipping"
const shippingCoordinate = `${EVENT_KINDS.SHIPPING_OPTION}:${merchantPubkey}:${shippingDTag}`
const signedAt = 1_800_000_000
const signedShipping = finalizeEvent(
  {
    kind: EVENT_KINDS.SHIPPING_OPTION,
    created_at: signedAt,
    content: "",
    tags: [["d", shippingDTag]],
  },
  secret
)

function productFor(dTag: string, title: string): ProductSchema {
  return {
    id: `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${dTag}`,
    pubkey: merchantPubkey,
    title,
    summary: "Atomic local product write fixture",
    price: 10,
    currency: "USD",
    type: "simple",
    specifications: [],
    format: "physical",
    visibility: "public",
    images: [{ url: "https://example.com/product.png" }],
    tags: ["test"],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: signedAt * 1000,
    updatedAt: signedAt * 1000,
    stock: 3,
  }
}

interface FixtureWriteInput {
  dTag: string
  title: string
  expectedEventId?: string | null
  useShipping?: boolean
  signedAtOffset?: number
  stock?: {
    orderId: string
    sourceEventId: string
    nextStock: number
    replacesSignedEventId?: string
  }
}

async function commit(input: FixtureWriteInput) {
  const addressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${input.dTag}`
  const draft = buildProductListingEventDraft({
    product: {
      ...productFor(input.dTag, input.title),
      stock: input.stock?.nextStock ?? 3,
    },
    dTag: input.dTag,
    clientAppId: "merchant",
  })
  const signedListing = finalizeEvent(
    {
      kind: draft.kind,
      created_at: signedAt + (input.signedAtOffset ?? 0),
      content: draft.content,
      tags: [
        ...draft.tags,
        ...(input.useShipping ? [["shipping_option", shippingCoordinate]] : []),
      ],
    },
    secret
  )
  const listingJobId = getProductListingDeliveryJobId([signedListing])
  const now = Date.now()
  const listingJob: ProductListingDeliveryJob = {
    id: listingJobId,
    merchantPubkey,
    signedEvents: [signedListing],
    relayTargets: [{ relayUrl, ownerSelected: true, personalRelay: true }],
    relayDelivery: [
      {
        eventId: signedListing.id,
        relayUrl,
        status: "pending",
        attemptCount: 0,
      },
    ],
    ...(input.useShipping
      ? { prerequisiteShippingEventIds: [signedShipping.id] }
      : {}),
    readyForDelivery: false,
    state: "pending",
    deliveryAttemptCount: 0,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  }
  const shippingJobs: LocalProductShippingJob[] = input.useShipping
    ? [
        {
          id: signedShipping.id,
          merchantPubkey,
          signedEvent: signedShipping,
          relayUrls: [relayUrl],
          acknowledgedRelayUrls: [],
          createdAt: now,
        },
      ]
    : []
  const intent = await commitLocalProductWrite({
    intentId: crypto.randomUUID(),
    merchantPubkey,
    expectedRevisions: [{ addressId, eventId: input.expectedEventId ?? null }],
    listingJob,
    shippingJobs,
    ...(input.stock
      ? {
          stock: {
            orderId: input.stock.orderId,
            adjustment: {
              key: `${encodeURIComponent(input.stock.orderId)}:${encodeURIComponent(addressId)}`,
              addressId,
              sourceEventId: input.stock.sourceEventId,
              title: input.dTag,
              quantity: 3 - input.stock.nextStock,
              currentStock: 3,
              nextStock: input.stock.nextStock,
              shortfall: 0,
            },
            ...(input.stock.replacesSignedEventId
              ? { replacesSignedEventId: input.stock.replacesSignedEventId }
              : {}),
          },
        }
      : {}),
  })
  return {
    addressId,
    eventId: signedListing.id,
    listingJobId,
    intentId: intent.id,
  }
}

async function readStock(orderId: string) {
  const rows = await getLocalProductStockRecoveryForOrder(
    merchantPubkey,
    orderId
  )
  return rows.map(({ checkpoint, signedEvent, listingJob }) => ({
    state: checkpoint.state,
    signedEventId: signedEvent.id,
    listingJobId: listingJob.id,
    listingState: listingJob.state,
    nextStock: checkpoint.adjustment.nextStock,
  }))
}

async function settleStock(
  orderId: string,
  addressId: string,
  signedEventId: string,
  kind: "applied" | "unpublished"
) {
  const jobId = `product-listing:${signedEventId}`
  const updated = await db.productListingOutbox.update(jobId, {
    state: kind === "applied" ? "delivered" : "failed",
    relayDelivery: [
      {
        eventId: signedEventId,
        relayUrl,
        status: kind === "applied" ? "acked" : "rejected",
        attemptCount: 1,
      },
    ],
  })
  if (updated !== 1) throw new Error("Signed stock delivery job is missing")
  return settleLocalProductStockRecovery({
    merchantPubkey,
    orderId,
    addressId,
    signedEventId,
    kind,
  })
}

async function confirmStock(
  orderId: string,
  addressId: string,
  signedEventId: string
) {
  const recovered = await confirmLocalProductStockRecovery({
    merchantPubkey,
    orderId,
    addressId,
    signedEventId,
  })
  return recovered.signedEvent.id
}

async function commitDeletion(
  dTag: string,
  expectedEventId: string,
  extraEventId?: string
) {
  const addressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${dTag}`
  const draft = buildProductDeletionEventDraft({
    merchantPubkey,
    targets: [
      { eventId: expectedEventId, addressId },
      ...(extraEventId ? [{ eventId: extraEventId }] : []),
    ],
    clientAppId: "merchant",
  })
  const signedDeletion = finalizeEvent(
    {
      kind: draft.kind,
      created_at: signedAt + 1,
      content: draft.content,
      tags: draft.tags,
    },
    secret
  )
  const now = Date.now()
  const deletionJob: ProductDeletionDeliveryJob = {
    id: signedDeletion.id,
    signedEvent: signedDeletion,
    relayPlan: [
      {
        relayUrl,
        roles: ["author_write"],
        personalRelay: true,
      },
    ],
    relayDelivery: [{ relayUrl, status: "pending", attemptCount: 0 }],
    state: "pending",
    deliveryAttemptCount: 0,
    retryCount: 0,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  }
  const intent = await commitLocalProductWrite({
    intentId: crypto.randomUUID(),
    merchantPubkey,
    expectedRevisions: [{ addressId, eventId: expectedEventId }],
    deletionJob,
  })
  return { intentId: intent.id, deletionEventId: signedDeletion.id }
}

async function seedStrongerSameSecondTombstone(
  dTag: string,
  expectedEventId: string
) {
  const addressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${dTag}`
  const draft = buildProductDeletionEventDraft({
    merchantPubkey,
    targets: [{ eventId: expectedEventId, addressId }],
    clientAppId: "merchant",
  })
  const candidate = finalizeEvent(
    {
      kind: draft.kind,
      created_at: signedAt + 1,
      content: draft.content,
      tags: draft.tags,
    },
    secret
  )
  let competing = candidate
  for (
    let counter = 0;
    counter < 100 && competing.id >= candidate.id;
    counter++
  ) {
    competing = finalizeEvent(
      {
        kind: draft.kind,
        created_at: signedAt + 1,
        content: `Earlier same-second deletion ${counter}`,
        tags: draft.tags,
      },
      secret
    )
  }
  if (competing.id >= candidate.id) {
    throw new Error("Could not form a lower-ID same-second tombstone")
  }
  await db.productTombstones.put({
    id: `a:${addressId}`,
    pubkey: merchantPubkey,
    addressId,
    deletedAt: signedAt + 1,
    deletionEventId: competing.id,
    signedEvent: competing,
    observedLocally: true,
    sourceRelayUrls: [],
    cachedAt: Date.now(),
  })
  return competing.id
}

async function settleFixtureListing(listingJobId: string) {
  const updated = await db.productListingOutbox.update(listingJobId, {
    state: "delivered",
    relayDelivery: [
      {
        eventId: (await db.productListingOutbox.get(listingJobId))!
          .signedEvents[0]!.id,
        relayUrl,
        status: "acked",
        attemptCount: 1,
      },
    ],
  })
  if (updated !== 1) throw new Error("Fixture listing was not found")
}

async function seedPendingStockCheckpoint(dTag: string, sourceEventId: string) {
  const addressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${dTag}`
  await db.localProductStockCheckpoints.add({
    id: `${merchantPubkey}:fixture:${encodeURIComponent(addressId)}`,
    merchantPubkey,
    orderId: "fixture",
    productAddressId: addressId,
    sourceEventId,
    signedEventId: sourceEventId,
    adjustment: {
      key: `fixture:${encodeURIComponent(addressId)}`,
      addressId,
      sourceEventId,
      title: "Fixture stock",
      quantity: 1,
      currentStock: 2,
      nextStock: 1,
      shortfall: 0,
    },
    state: "pending",
    committedAt: Date.now(),
  })
}

async function seedLegacyRejectedStock(dTag: string) {
  const draft = buildProductListingEventDraft({
    product: { ...productFor(dTag, "Legacy rejected stock"), stock: 2 },
    dTag,
    clientAppId: "merchant",
  })
  const event = finalizeEvent(
    {
      kind: draft.kind,
      created_at: signedAt + 1,
      content: draft.content,
      tags: draft.tags,
    },
    secret
  )
  const jobId = getProductListingDeliveryJobId([event])
  const now = Date.now()
  await db.productListingOutbox.add({
    id: jobId,
    merchantPubkey,
    signedEvents: [event],
    relayTargets: [{ relayUrl, ownerSelected: true, personalRelay: true }],
    relayDelivery: [
      { eventId: event.id, relayUrl, status: "rejected", attemptCount: 1 },
    ],
    readyForDelivery: true,
    state: "failed",
    deliveryAttemptCount: 1,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  })
  await db.products.put(projectSignedProductListingForLocalCommit(event))
  return { eventId: event.id, jobId }
}

async function stageLegacyRejectedStock(
  dTag: string,
  previousStockEventId: string
) {
  const addressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${dTag}`
  const draft = buildProductListingEventDraft({
    product: { ...productFor(dTag, "Legacy replacement stock"), stock: 2 },
    dTag,
    clientAppId: "merchant",
  })
  const event = finalizeEvent(
    {
      kind: draft.kind,
      created_at: signedAt + 2,
      content: draft.content,
      tags: draft.tags,
    },
    secret
  )
  return withMerchantStockLock(merchantPubkey, () =>
    withLocalLegacyProductWriteStage(
      {
        merchantPubkey,
        expectedRevisions: [{ addressId, eventId: previousStockEventId }],
        signedListings: [event],
        recovery: { kind: "stock_republish", previousStockEventId },
      },
      async () => {
        const locks = await navigator.locks.query()
        return {
          eventId: event.id,
          heldLocks: locks.held?.map((lock) => lock.name) ?? [],
        }
      }
    )
  )
}

async function clearPendingStockCheckpoint(dTag: string) {
  const addressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${dTag}`
  await db.localProductStockCheckpoints
    .where("productAddressId")
    .equals(addressId)
    .delete()
}

async function seedLegacyMixedRejected(
  rootTag: string,
  removedTag: string,
  removedEventId: string
) {
  const listingDraft = buildProductListingEventDraft({
    product: productFor(rootTag, "Rejected mixed replacement"),
    dTag: rootTag,
    clientAppId: "merchant",
  })
  const listing = finalizeEvent(
    {
      kind: listingDraft.kind,
      created_at: signedAt + 1,
      content: listingDraft.content,
      tags: listingDraft.tags,
    },
    secret
  )
  const removedAddressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${removedTag}`
  const deletionDraft = buildProductDeletionEventDraft({
    merchantPubkey,
    targets: [{ eventId: removedEventId, addressId: removedAddressId }],
    clientAppId: "merchant",
  })
  const deletion = finalizeEvent(
    {
      kind: deletionDraft.kind,
      created_at: signedAt + 1,
      content: deletionDraft.content,
      tags: deletionDraft.tags,
    },
    secret
  )
  const listingJobId = getProductListingDeliveryJobId([listing])
  const now = Date.now()
  await db.productListingOutbox.add({
    id: listingJobId,
    merchantPubkey,
    signedEvents: [listing],
    relayTargets: [{ relayUrl, ownerSelected: true, personalRelay: true }],
    relayDelivery: [
      { eventId: listing.id, relayUrl, status: "rejected", attemptCount: 1 },
    ],
    companionDeletionJobId: deletion.id,
    readyForDelivery: true,
    state: "failed",
    deliveryAttemptCount: 1,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  })
  await db.productDeletionOutbox.add({
    id: deletion.id,
    signedEvent: deletion,
    relayPlan: [{ relayUrl, roles: ["author_write"], personalRelay: true }],
    relayDelivery: [{ relayUrl, status: "pending", attemptCount: 0 }],
    companionListingJobId: listingJobId,
    state: "pending",
    deliveryAttemptCount: 0,
    retryCount: 0,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  })
  await db.products.put(projectSignedProductListingForLocalCommit(listing))
  return {
    listingEventId: listing.id,
    deletionEventId: deletion.id,
    deletionCreatedAt: deletion.created_at,
  }
}

async function stageLegacyMixedRejected(input: {
  rootTag: string
  removedTag: string
  removedEventId: string
  previousListingEventId: string
  previousDeletionEventId: string
  deletionCreatedAt: number
  changedCutoff?: boolean
}) {
  const listingDraft = buildProductListingEventDraft({
    product: productFor(input.rootTag, "Recovered mixed replacement"),
    dTag: input.rootTag,
    clientAppId: "merchant",
  })
  const listing = finalizeEvent(
    {
      kind: listingDraft.kind,
      created_at: signedAt + 2,
      content: listingDraft.content,
      tags: listingDraft.tags,
    },
    secret
  )
  const rootAddressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${input.rootTag}`
  const removedAddressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${input.removedTag}`
  const deletionDraft = buildProductDeletionEventDraft({
    merchantPubkey,
    targets: [{ eventId: input.removedEventId, addressId: removedAddressId }],
    clientAppId: "merchant",
  })
  const deletion = finalizeEvent(
    {
      kind: deletionDraft.kind,
      created_at: input.deletionCreatedAt + (input.changedCutoff ? 1 : 0),
      content: deletionDraft.content,
      tags: [
        ...deletionDraft.tags,
        ["conduit_recovery_attempt", input.previousDeletionEventId, "fixture"],
      ],
    },
    secret
  )
  return withMerchantStockLock(merchantPubkey, () =>
    withLocalLegacyProductWriteStage(
      {
        merchantPubkey,
        expectedRevisions: [
          { addressId: rootAddressId, eventId: input.previousListingEventId },
          { addressId: removedAddressId, eventId: input.removedEventId },
        ],
        signedListings: [listing],
        signedDeletion: deletion,
        recovery: {
          kind: "mixed_deletion",
          previousDeletionEventId: input.previousDeletionEventId,
        },
      },
      async () => {
        const locks = await navigator.locks.query()
        return {
          deletionCreatedAt: deletion.created_at,
          heldLocks: locks.held?.map((lock) => lock.name) ?? [],
        }
      }
    )
  )
}

async function read(dTag: string) {
  const addressId = `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${dTag}`
  const [product, frontier, listings, intents, shipping, tombstone] =
    await Promise.all([
      db.products.get(addressId),
      db.localProductWriteFrontiers.get(addressId),
      db.productListingOutbox
        .where("merchantPubkey")
        .equals(merchantPubkey)
        .toArray(),
      db.localProductWriteIntents
        .where("merchantPubkey")
        .equals(merchantPubkey)
        .toArray(),
      db.localProductShippingOutbox.get(signedShipping.id),
      db.productTombstones.get(`a:${addressId}`),
    ])
  return {
    productEventId: product?.eventId ?? null,
    frontierEventId: frontier?.eventId ?? null,
    frontierDeletionEventId: frontier?.deletionEventId ?? null,
    tombstoneDeletionEventId: tombstone?.deletionEventId ?? null,
    listingJobIds: listings.map((job) => job.id),
    intentIds: intents.map((intent) => intent.id),
    shippingAcknowledgedRelayUrls: shipping?.acknowledgedRelayUrls ?? [],
    readyStates: listings.map((job) => ({
      id: job.id,
      ready: job.readyForDelivery,
    })),
  }
}

Object.assign(window, {
  __localProductWriteHarness: {
    commit,
    commitDeletion,
    seedStrongerSameSecondTombstone,
    settleFixtureListing,
    readStock,
    settleStock,
    confirmStock,
    seedPendingStockCheckpoint,
    seedLegacyRejectedStock,
    stageLegacyRejectedStock,
    clearPendingStockCheckpoint,
    seedLegacyMixedRejected,
    stageLegacyMixedRejected,
    read,
  },
})
