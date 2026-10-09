import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("Merchant publish live account authority", () => {
  it("threads the route session predicate through invoice and product families", async () => {
    const [orders, products, enrollment, manager] = await Promise.all([
      source("apps/merchant/src/routes/orders.tsx"),
      source("apps/merchant/src/routes/products.tsx"),
      source("apps/merchant/src/hooks/useEventMarketEnrollment.ts"),
      source("apps/merchant/src/components/FutureEventMarketManager.tsx"),
    ])

    expect(orders).toContain(
      "authenticatedPubkey,\n            shouldContinue: () => isCurrentOrderAction(authority)"
    )
    expect(orders).toMatch(
      /signAndPublishProductListing\(\{[\s\S]{0,180}shouldContinue: \(\) => isCurrentOrderAction\(authority\)/
    )
    expect(orders).toMatch(
      /deliverSignedProductEvent\([\s\S]{0,220}shouldContinue: \(\) => isCurrentOrderAccount\(pubkey\)/
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
    expect(enrollment).toContain("publishEventMarketEnrollment")
    expect(enrollment).toContain("retryEventMarketEnrollmentDelivery")
    expect(
      enrollment.match(
        /shouldContinue: \(\) => isAuthGenerationCurrent\(authGeneration\)/g
      )
    ).toHaveLength(3)
    expect(manager).toContain("publishEventMarketMerchantDecision")
    expect(manager).toContain(
      "const shouldContinue = () => isAuthGenerationCurrent(authGeneration)"
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
      /publishSignedEventToRelay\(\{[\s\S]*?shouldContinue:/
    )
    expect(worker).toContain(
      'import { StrictMode, useLayoutEffect } from "react"'
    )
    expect(worker).toContain(
      "useLayoutEffect(\n    () => startProductDeletionDeliveryWorker(authenticatedPubkey)"
    )
  })
})
