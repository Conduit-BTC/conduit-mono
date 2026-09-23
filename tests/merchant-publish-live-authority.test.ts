import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("Merchant publish live account authority", () => {
  it("threads the route session predicate through invoice and product families", async () => {
    const [orders, products, eventProducts, pickup] = await Promise.all([
      source("apps/merchant/src/routes/orders.tsx"),
      source("apps/merchant/src/routes/products.tsx"),
      source("apps/merchant/src/lib/event-product-publishing.ts"),
      source("apps/merchant/src/lib/event-market-pickup.ts"),
    ])

    expect(orders).toContain(
      "authenticatedPubkey,\n            shouldContinue: () => isCurrentOrderAction(authority)"
    )
    expect(orders).toMatch(
      /signAndPublishProductWriteBundle\(\{\s*merchantPubkey: pubkey,\s*authenticatedPubkey,\s*shouldContinue: \(\) => isCurrentOrderAction\(authority\),\s*assertCurrentWriteBaseline,/
    )
    expect(orders).toMatch(
      /deliverQueuedProductListings\(queued\.id,\s*\{[\s\S]{0,180}shouldContinue: \(\) => isCurrentOrderAccount\(pubkey\)/
    )
    expect(products).toMatch(
      /ensureMerchantBoothPickup\(\{[\s\S]{0,260}shouldContinue: \(\) => \{\s*assertCurrentFamilyRevision\?\.\(\)/
    )
    expect(products).toMatch(
      /signAndPublishProductWriteBundle\(\{[\s\S]{0,100}shouldContinue,/
    )
    expect(products).toMatch(
      /deliverQueuedProductDeletion\([\s\S]{0,220}authenticatedPubkey: activeAuthenticatedPubkey,[\s\S]{0,40}shouldContinue,/
    )
    expect(products).toMatch(
      /deliverQueuedProductDeletion\([\s\S]{0,220}authenticatedPubkey:[\s\S]{0,80}shouldContinue: \(\) =>/
    )
    expect(eventProducts).toContain("shouldContinue: input.shouldContinue")
    expect(pickup.match(/shouldContinue: input\.shouldContinue/g)).toHaveLength(
      2
    )
  })

  it("rechecks only authority-dependent exact retries at socket creation", async () => {
    const [delivery, worker] = await Promise.all([
      source("apps/merchant/src/lib/product-deletion-delivery.ts"),
      source("apps/merchant/src/main.tsx"),
    ])

    expect(delivery).toContain("requiresAuthenticatedOwnerAuthority")
    expect(delivery).toContain("!normalizePublicWebSocketUrl(input.relayUrl)")
    expect(delivery).toMatch(
      /publishSignedEventToRelay\(\{[\s\S]{0,500}shouldContinue:/
    )
    expect(worker).toContain(
      'import { StrictMode, useLayoutEffect } from "react"'
    )
    expect(worker).toContain(
      "startProductListingDeliveryWorker(authenticatedPubkey)"
    )
    expect(worker).toContain(
      "startProductDeletionDeliveryWorker(authenticatedPubkey)"
    )
    expect(worker).toContain("stopListingWorker()")
    expect(worker).toContain("stopDeletionWorker()")
  })
})
