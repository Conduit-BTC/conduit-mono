import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { generateSecretKey } from "nostr-tools/pure"

const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const fixturePath = fileURLToPath(
  new URL("./fixtures/local-product-write.ts", import.meta.url)
)
// One ephemeral signer per worker keeps cross-tab product coordinates identical.
const fixtureKeyBytes = Array.from(generateSecretKey())

interface ProductWriteHarness {
  commit(input: {
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
  }): Promise<{
    addressId: string
    eventId: string
    listingJobId: string
    intentId: string
  }>
  commitDeletion(
    dTag: string,
    expectedEventId: string,
    extraEventId?: string
  ): Promise<{ intentId: string; deletionEventId: string }>
  seedStrongerSameSecondTombstone(
    dTag: string,
    expectedEventId: string
  ): Promise<string>
  settleFixtureListing(listingJobId: string): Promise<void>
  seedPendingStockCheckpoint(dTag: string, sourceEventId: string): Promise<void>
  seedLegacyRejectedStock(
    dTag: string
  ): Promise<{ eventId: string; jobId: string }>
  stageLegacyRejectedStock(
    dTag: string,
    previousStockEventId: string
  ): Promise<{ eventId: string; heldLocks: string[] }>
  clearPendingStockCheckpoint(dTag: string): Promise<void>
  seedLegacyMixedRejected(
    rootTag: string,
    removedTag: string,
    removedEventId: string
  ): Promise<{
    listingEventId: string
    deletionEventId: string
    deletionCreatedAt: number
  }>
  stageLegacyMixedRejected(input: {
    rootTag: string
    removedTag: string
    removedEventId: string
    previousListingEventId: string
    previousDeletionEventId: string
    deletionCreatedAt: number
    changedCutoff?: boolean
  }): Promise<{ deletionCreatedAt: number; heldLocks: string[] }>
  readStock(orderId: string): Promise<
    Array<{
      state: "pending" | "applied" | "unpublished"
      signedEventId: string
      listingJobId: string
      listingState: string
      nextStock: number
    }>
  >
  settleStock(
    orderId: string,
    addressId: string,
    signedEventId: string,
    kind: "applied" | "unpublished"
  ): Promise<"saved" | "stale">
  confirmStock(
    orderId: string,
    addressId: string,
    signedEventId: string
  ): Promise<string>
  read(dTag: string): Promise<{
    productEventId: string | null
    frontierEventId: string | null
    frontierDeletionEventId: string | null
    tombstoneDeletionEventId: string | null
    listingJobIds: string[]
    intentIds: string[]
    shippingAcknowledgedRelayUrls: string[]
    readyStates: Array<{ id: string; ready: boolean | undefined }>
  }>
}

declare global {
  interface Window {
    __localProductWriteFixtureKeyBytes?: number[]
    __localProductWriteHarness: ProductWriteHarness
  }
}

async function loadHarness(page: import("@playwright/test").Page) {
  const browserErrors: string[] = []
  page.on("pageerror", (error) => browserErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) {
      browserErrors.push(`${response.status()} ${response.url()}`)
    }
  })
  await page.goto(`${merchantUrl}/about`)
  await page.evaluate((keyBytes) => {
    window.__localProductWriteFixtureKeyBytes = keyBytes
  }, fixtureKeyBytes)
  await page.addScriptTag({
    type: "module",
    content: `import ${JSON.stringify(encodeURI(`/@fs/${fixturePath.replaceAll("\\", "/")}`))};`,
  })
  try {
    await expect
      .poll(() => page.evaluate(() => !!window.__localProductWriteHarness))
      .toBe(true)
  } catch (error) {
    throw new Error(
      `Product-write fixture failed: ${browserErrors.join(" | ")}`,
      {
        cause: error,
      }
    )
  }
}

test("local product commit rolls back partial writes and serializes tabs @merchant", async ({
  browser,
}) => {
  const context = await browser.newContext()
  const first = await context.newPage()
  const second = await context.newPage()
  try {
    await Promise.all([loadHarness(first), loadHarness(second)])
    const tag = `cnd-356-${crypto.randomUUID()}`
    const attempts = await Promise.allSettled([
      first.evaluate(
        (dTag) =>
          window.__localProductWriteHarness.commit({
            dTag,
            title: "First tab",
          }),
        tag
      ),
      second.evaluate(
        (dTag) =>
          window.__localProductWriteHarness.commit({
            dTag,
            title: "Second tab",
          }),
        tag
      ),
    ])
    expect(
      attempts.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(
      attempts.filter((result) => result.status === "rejected")
    ).toHaveLength(1)
    const winner = attempts.find(
      (
        result
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<ProductWriteHarness["commit"]>>
      > => result.status === "fulfilled"
    )!.value
    const fromOtherTab = await second.evaluate(
      (dTag) => window.__localProductWriteHarness.read(dTag),
      tag
    )
    expect(fromOtherTab.productEventId).toBe(winner.eventId)
    expect(fromOtherTab.frontierEventId).toBe(winner.eventId)
    expect(fromOtherTab.listingJobIds).toEqual([winner.listingJobId])
    expect(fromOtherTab.intentIds).toEqual([winner.intentId])

    await expect(
      first.evaluate(
        ({ dTag, eventId }) =>
          window.__localProductWriteHarness.commit({
            dTag,
            title: "Same-second replacement",
            expectedEventId: eventId,
          }),
        { dTag: tag, eventId: winner.eventId }
      )
    ).rejects.toThrow("does not advance its source")

    const firstShippingTag = `${tag}-shipping-first`
    const firstShipping = await first.evaluate(
      (dTag) =>
        window.__localProductWriteHarness.commit({
          dTag,
          title: "Durable shipping prerequisite",
          useShipping: true,
        }),
      firstShippingTag
    )
    const shippingState = await second.evaluate(
      (dTag) => window.__localProductWriteHarness.read(dTag),
      firstShippingTag
    )
    expect(shippingState.readyStates).toContainEqual({
      id: firstShipping.listingJobId,
      ready: false,
    })
    expect(shippingState.shippingAcknowledgedRelayUrls).toEqual([])

    const beforeRollback = shippingState
    const secondShippingTag = `${tag}-shipping-rollback`
    await expect(
      second.evaluate(
        (dTag) =>
          window.__localProductWriteHarness.commit({
            dTag,
            title: "Must roll back on duplicate shipping ID",
            useShipping: true,
          }),
        secondShippingTag
      )
    ).rejects.toThrow()
    const afterRollback = await first.evaluate(
      (dTag) => window.__localProductWriteHarness.read(dTag),
      secondShippingTag
    )
    expect(afterRollback.productEventId).toBeNull()
    expect(afterRollback.frontierEventId).toBeNull()
    expect(afterRollback.listingJobIds).toEqual(beforeRollback.listingJobIds)
    expect(afterRollback.intentIds).toEqual(beforeRollback.intentIds)

    await second.evaluate(
      (listingJobId) =>
        window.__localProductWriteHarness.settleFixtureListing(listingJobId),
      winner.listingJobId
    )
    await expect(
      second.evaluate(
        ({ dTag, eventId }) =>
          window.__localProductWriteHarness.commitDeletion(
            dTag,
            eventId,
            "f".repeat(64)
          ),
        { dTag: tag, eventId: winner.eventId }
      )
    ).rejects.toThrow("Signed product-write coordinates changed")
    const strongerSameSecondTombstone = await first.evaluate(
      ({ dTag, eventId }) =>
        window.__localProductWriteHarness.seedStrongerSameSecondTombstone(
          dTag,
          eventId
        ),
      { dTag: tag, eventId: winner.eventId }
    )
    const deletion = await second.evaluate(
      ({ dTag, eventId }) =>
        window.__localProductWriteHarness.commitDeletion(dTag, eventId),
      { dTag: tag, eventId: winner.eventId }
    )
    const deleted = await first.evaluate(
      (dTag) => window.__localProductWriteHarness.read(dTag),
      tag
    )
    expect(deleted.productEventId).toBe(winner.eventId)
    expect(deleted.frontierDeletionEventId).toBe(strongerSameSecondTombstone)
    expect(deleted.tombstoneDeletionEventId).toBe(strongerSameSecondTombstone)
    expect(deleted.intentIds).toContain(deletion.intentId)

    const stockTag = `${tag}-stock`
    const stockSource = await first.evaluate(
      (dTag) =>
        window.__localProductWriteHarness.commit({
          dTag,
          title: "Stock source",
        }),
      stockTag
    )
    await first.evaluate(
      ({ dTag, eventId }) =>
        window.__localProductWriteHarness.seedPendingStockCheckpoint(
          dTag,
          eventId
        ),
      { dTag: stockTag, eventId: stockSource.eventId }
    )
    await expect(
      second.evaluate(
        ({ dTag, eventId }) =>
          window.__localProductWriteHarness.commitDeletion(dTag, eventId),
        { dTag: stockTag, eventId: stockSource.eventId }
      )
    ).rejects.toThrow("stock checkpoint must settle")
  } finally {
    await context.close()
  }
})

test("stock journal keeps exact recovery bytes and blocks edits until settlement @merchant", async ({
  browser,
}) => {
  const context = await browser.newContext()
  const first = await context.newPage()
  const second = await context.newPage()
  try {
    await Promise.all([loadHarness(first), loadHarness(second)])
    const dTag = `cnd-356-stock-${crypto.randomUUID()}`
    const orderId = `order-${crypto.randomUUID()}`
    const source = await first.evaluate(
      (dTag) =>
        window.__localProductWriteHarness.commit({
          dTag,
          title: "Original stock",
        }),
      dTag
    )
    await first.evaluate(
      (jobId) => window.__localProductWriteHarness.settleFixtureListing(jobId),
      source.listingJobId
    )
    const stock = await first.evaluate(
      ({ dTag, orderId, sourceEventId }) =>
        window.__localProductWriteHarness.commit({
          dTag,
          title: "Stock after order",
          expectedEventId: sourceEventId,
          signedAtOffset: 1,
          stock: { orderId, sourceEventId, nextStock: 2 },
        }),
      { dTag, orderId, sourceEventId: source.eventId }
    )
    expect(
      await second.evaluate(
        (orderId) => window.__localProductWriteHarness.readStock(orderId),
        orderId
      )
    ).toContainEqual({
      state: "pending",
      signedEventId: stock.eventId,
      listingJobId: stock.listingJobId,
      listingState: "pending",
      nextStock: 2,
    })
    expect(
      await second.evaluate(
        ({ orderId, addressId, signedEventId }) =>
          window.__localProductWriteHarness.confirmStock(
            orderId,
            addressId,
            signedEventId
          ),
        { orderId, addressId: source.addressId, signedEventId: stock.eventId }
      )
    ).toBe(stock.eventId)
    await expect(
      second.evaluate(
        ({ dTag, eventId }) =>
          window.__localProductWriteHarness.commit({
            dTag,
            title: "Competing ordinary edit",
            expectedEventId: eventId,
            signedAtOffset: 2,
          }),
        { dTag, eventId: stock.eventId }
      )
    ).rejects.toThrow("stock checkpoint must settle")
    expect(
      await first.evaluate(
        ({ orderId, addressId, signedEventId }) =>
          window.__localProductWriteHarness.settleStock(
            orderId,
            addressId,
            signedEventId,
            "applied"
          ),
        { orderId, addressId: source.addressId, signedEventId: stock.eventId }
      )
    ).toBe("saved")
    await expect(
      second.evaluate(
        ({ orderId, addressId, signedEventId }) =>
          window.__localProductWriteHarness.confirmStock(
            orderId,
            addressId,
            signedEventId
          ),
        { orderId, addressId: source.addressId, signedEventId: stock.eventId }
      )
    ).rejects.toThrow("no longer pending")
  } finally {
    await context.close()
  }
})

test("legacy rejected stock republish holds both locks and yields to a pending journal @merchant", async ({
  browser,
}) => {
  const context = await browser.newContext()
  const first = await context.newPage()
  const second = await context.newPage()
  try {
    await Promise.all([loadHarness(first), loadHarness(second)])
    const dTag = `cnd-356-legacy-${crypto.randomUUID()}`
    const source = await first.evaluate(
      (dTag) =>
        window.__localProductWriteHarness.commit({ dTag, title: "Source" }),
      dTag
    )
    await first.evaluate(
      (jobId) => window.__localProductWriteHarness.settleFixtureListing(jobId),
      source.listingJobId
    )
    const legacy = await first.evaluate(
      (dTag) => window.__localProductWriteHarness.seedLegacyRejectedStock(dTag),
      dTag
    )
    await first.evaluate(
      ({ dTag, eventId }) =>
        window.__localProductWriteHarness.seedPendingStockCheckpoint(
          dTag,
          eventId
        ),
      { dTag, eventId: legacy.eventId }
    )
    await expect(
      second.evaluate(
        ({ dTag, eventId }) =>
          window.__localProductWriteHarness.stageLegacyRejectedStock(
            dTag,
            eventId
          ),
        { dTag, eventId: legacy.eventId }
      )
    ).rejects.toThrow("stock checkpoint must settle")
    await first.evaluate(
      (dTag) =>
        window.__localProductWriteHarness.clearPendingStockCheckpoint(dTag),
      dTag
    )
    const staged = await second.evaluate(
      ({ dTag, eventId }) =>
        window.__localProductWriteHarness.stageLegacyRejectedStock(
          dTag,
          eventId
        ),
      { dTag, eventId: legacy.eventId }
    )
    expect(staged.heldLocks).toContain(
      `conduit:merchant:order-stock:v1:${source.addressId.split(":")[1]}`
    )
    expect(staged.heldLocks).toContain(
      `conduit:product-write:${source.addressId}`
    )
    expect(staged.eventId).not.toBe(legacy.eventId)
    expect(
      await first.evaluate(
        (dTag) => window.__localProductWriteHarness.read(dTag),
        dTag
      )
    ).toMatchObject({ productEventId: legacy.eventId })
  } finally {
    await context.close()
  }
})

test("mixed legacy recovery keeps its NIP-09 cutoff and yields to pending stock @merchant", async ({
  browser,
}) => {
  const context = await browser.newContext()
  const first = await context.newPage()
  const second = await context.newPage()
  try {
    await Promise.all([loadHarness(first), loadHarness(second)])
    const rootTag = `cnd-356-mixed-root-${crypto.randomUUID()}`
    const removedTag = `cnd-356-mixed-removed-${crypto.randomUUID()}`
    const [root, removed] = await Promise.all([
      first.evaluate(
        (dTag) =>
          window.__localProductWriteHarness.commit({ dTag, title: "Root" }),
        rootTag
      ),
      first.evaluate(
        (dTag) =>
          window.__localProductWriteHarness.commit({ dTag, title: "Removed" }),
        removedTag
      ),
    ])
    await Promise.all([
      first.evaluate(
        (jobId) =>
          window.__localProductWriteHarness.settleFixtureListing(jobId),
        root.listingJobId
      ),
      first.evaluate(
        (jobId) =>
          window.__localProductWriteHarness.settleFixtureListing(jobId),
        removed.listingJobId
      ),
    ])
    const legacy = await first.evaluate(
      ({ rootTag, removedTag, removedEventId }) =>
        window.__localProductWriteHarness.seedLegacyMixedRejected(
          rootTag,
          removedTag,
          removedEventId
        ),
      { rootTag, removedTag, removedEventId: removed.eventId }
    )
    const recovery = {
      rootTag,
      removedTag,
      removedEventId: removed.eventId,
      previousListingEventId: legacy.listingEventId,
      previousDeletionEventId: legacy.deletionEventId,
      deletionCreatedAt: legacy.deletionCreatedAt,
    }
    await expect(
      second.evaluate(
        (input) =>
          window.__localProductWriteHarness.stageLegacyMixedRejected(input),
        { ...recovery, changedCutoff: true }
      )
    ).rejects.toThrow("Rejected mixed product recovery changed")
    await first.evaluate(
      ({ dTag, eventId }) =>
        window.__localProductWriteHarness.seedPendingStockCheckpoint(
          dTag,
          eventId
        ),
      { dTag: removedTag, eventId: removed.eventId }
    )
    await expect(
      second.evaluate(
        (input) =>
          window.__localProductWriteHarness.stageLegacyMixedRejected(input),
        recovery
      )
    ).rejects.toThrow("stock checkpoint must settle")
    await first.evaluate(
      (dTag) =>
        window.__localProductWriteHarness.clearPendingStockCheckpoint(dTag),
      removedTag
    )
    const staged = await second.evaluate(
      (input) =>
        window.__localProductWriteHarness.stageLegacyMixedRejected(input),
      recovery
    )
    expect(staged.deletionCreatedAt).toBe(legacy.deletionCreatedAt)
    expect(staged.heldLocks).toContain(
      `conduit:product-write:${root.addressId}`
    )
    expect(staged.heldLocks).toContain(
      `conduit:product-write:${removed.addressId}`
    )
  } finally {
    await context.close()
  }
})

test("only terminally rejected stock can be re-signed without another decrement @merchant", async ({
  browser,
}) => {
  const context = await browser.newContext()
  const first = await context.newPage()
  const second = await context.newPage()
  try {
    await Promise.all([loadHarness(first), loadHarness(second)])
    const dTag = `cnd-356-rejected-${crypto.randomUUID()}`
    const orderId = `order-${crypto.randomUUID()}`
    const source = await first.evaluate(
      (dTag) =>
        window.__localProductWriteHarness.commit({ dTag, title: "Source" }),
      dTag
    )
    await first.evaluate(
      (jobId) => window.__localProductWriteHarness.settleFixtureListing(jobId),
      source.listingJobId
    )
    const rejected = await first.evaluate(
      ({ dTag, orderId, sourceEventId }) =>
        window.__localProductWriteHarness.commit({
          dTag,
          title: "Order stock 2",
          expectedEventId: sourceEventId,
          signedAtOffset: 1,
          stock: { orderId, sourceEventId, nextStock: 2 },
        }),
      { dTag, orderId, sourceEventId: source.eventId }
    )
    await expect(
      second.evaluate(
        ({ dTag, orderId, sourceEventId, rejectedId }) =>
          window.__localProductWriteHarness.commit({
            dTag,
            title: "Unsafe re-sign before final rejection",
            expectedEventId: rejectedId,
            signedAtOffset: 2,
            stock: {
              orderId,
              sourceEventId,
              nextStock: 2,
              replacesSignedEventId: rejectedId,
            },
          }),
        {
          dTag,
          orderId,
          sourceEventId: source.eventId,
          rejectedId: rejected.eventId,
        }
      )
    ).rejects.toThrow("stock checkpoint must settle")
    expect(
      await first.evaluate(
        ({ orderId, addressId, signedEventId }) =>
          window.__localProductWriteHarness.settleStock(
            orderId,
            addressId,
            signedEventId,
            "unpublished"
          ),
        {
          orderId,
          addressId: source.addressId,
          signedEventId: rejected.eventId,
        }
      )
    ).toBe("saved")
    await expect(
      second.evaluate(
        ({ dTag, orderId, sourceEventId, rejectedId }) =>
          window.__localProductWriteHarness.commit({
            dTag,
            title: "Forbidden second decrement",
            expectedEventId: rejectedId,
            signedAtOffset: 2,
            stock: {
              orderId,
              sourceEventId,
              nextStock: 1,
              replacesSignedEventId: rejectedId,
            },
          }),
        {
          dTag,
          orderId,
          sourceEventId: source.eventId,
          rejectedId: rejected.eventId,
        }
      )
    ).rejects.toThrow("already has a durable stock checkpoint")
    const replacement = await second.evaluate(
      ({ dTag, orderId, sourceEventId, rejectedId }) =>
        window.__localProductWriteHarness.commit({
          dTag,
          title: "Re-sign the same stock 2",
          expectedEventId: rejectedId,
          signedAtOffset: 2,
          stock: {
            orderId,
            sourceEventId,
            nextStock: 2,
            replacesSignedEventId: rejectedId,
          },
        }),
      {
        dTag,
        orderId,
        sourceEventId: source.eventId,
        rejectedId: rejected.eventId,
      }
    )
    expect(replacement.eventId).not.toBe(rejected.eventId)
    expect(
      await first.evaluate(
        (orderId) => window.__localProductWriteHarness.readStock(orderId),
        orderId
      )
    ).toEqual([
      {
        state: "pending",
        signedEventId: replacement.eventId,
        listingJobId: replacement.listingJobId,
        listingState: "pending",
        nextStock: 2,
      },
      {
        state: "unpublished",
        signedEventId: rejected.eventId,
        listingJobId: rejected.listingJobId,
        listingState: "failed",
        nextStock: 2,
      },
    ])
    await expect(
      first.evaluate(
        ({ orderId, addressId, signedEventId }) =>
          window.__localProductWriteHarness.confirmStock(
            orderId,
            addressId,
            signedEventId
          ),
        {
          orderId,
          addressId: source.addressId,
          signedEventId: rejected.eventId,
        }
      )
    ).rejects.toThrow("no longer pending")
  } finally {
    await context.close()
  }
})
