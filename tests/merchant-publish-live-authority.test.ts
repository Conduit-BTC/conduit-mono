import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return (await Bun.file(path).text()).replace(/\r\n/g, "\n")
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
      /signAndPublishProductWriteBundle\(\{\s*merchantPubkey: pubkey,\s*authenticatedPubkey,\s*shouldContinue: \(\) => isCurrentOrderAction\(authority\),\s*assertCurrentWriteBaseline,/
    )
    expect(orders).toMatch(
      /deliverQueuedProductListings\(queued\.id,\s*\{[\s\S]{0,180}shouldContinue: \(\) => isCurrentOrderAccount\(pubkey\)/
    )
    expect(products).toMatch(
      /signAndPublishProductWriteBundle\(\{[\s\S]{0,100}shouldContinue,/
    )
    expect(products).toMatch(
      /deliverQueuedProductDeletion\(payload\.deliveryJobId,\s*\{\s*authenticatedPubkey: authStatus === "connected" \? pubkey : null,\s*shouldContinue: \(\) => authGenerationRef\.current === authGeneration,/
    )
    expect(products).toMatch(
      /deleteProduct\(\s*payload\.merchantPubkey,\s*payload\.product,[\s\S]{0,1000}authStatus === "connected" \? pubkey : null,\s*\(\) => authGenerationRef\.current === authGeneration/
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
    expect(delivery).toContain("status: await publishSignedEventToRelay({")
    expect(delivery).toMatch(
      /shouldContinue:\s*requiresAuthenticatedOwnerAuthority && authenticatedPubkey\s*\? \(\) =>\s*input\.isAuthenticatedPubkeyCurrent\?\.\(authenticatedPubkey\) !==\s*false/
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
