import { describe, expect, it } from "bun:test"

describe("merchant booth authorization UI contract", () => {
  it("gates the deliberate action on merchant-present order context", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const helper = await Bun.file(
      "apps/merchant/src/lib/merchant-present-sale-authorization.ts"
    ).text()

    expect(source).toContain(
      "{selectedIsMerchantPresentSale && selectedOrder && ("
    )
    expect(helper).toContain(
      'order.purchaseContext?.type !== "merchant_present"'
    )
    expect(source).toContain("Confirm items at booth")
    expect(source).toContain("Exact order total")
    expect(source).toContain("authorization covers physical availability")
    expect(source).toContain("does not approve a price")
  })

  it("rechecks current signed evidence before composing the authorization", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const mutationStart = source.indexOf(
      "const merchantPresentAuthorizationMutation"
    )
    const currentEvidenceCheck = source.indexOf(
      "verifyMerchantPickupOrderAuthorization({",
      mutationStart
    )
    const authorizationBuild = source.indexOf(
      "prepareMerchantPresentSaleAuthorization({",
      mutationStart
    )
    const delivery = source.indexOf(
      "deliverMerchantPresentSaleAuthorization({",
      mutationStart
    )

    expect(mutationStart).toBeGreaterThan(-1)
    expect(currentEvidenceCheck).toBeGreaterThan(mutationStart)
    expect(authorizationBuild).toBeGreaterThan(currentEvidenceCheck)
    expect(delivery).toBeGreaterThan(authorizationBuild)
  })

  it("keeps immediate guest booth transfer out of remote contact and inbox UI", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toMatch(
      /communicationState === "guest_out_of_band" &&\s+!selectedIsMerchantPresentSale/
    )
    expect(source).toContain("Nothing is published to a guest inbox.")
    expect(source).toContain("Copy encrypted wrap")
    expect(source).toContain("This encrypted wrap is too large for one")
  })
})
