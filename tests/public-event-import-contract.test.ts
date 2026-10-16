import { expect, it } from "bun:test"

it("keeps migrated public projections free of direct cryptography and copied trust flags", async () => {
  const files = [
    "products",
    "profiles",
    "follows",
    "shopper-trust",
    "relay-list",
    "profile-search",
    "owner-relay-list-evidence",
    "inbox-declaration-evidence",
    "event-market",
    "event-market-roster",
    "event-market-schedule",
    "event-market-merchandise",
    "product-deletion",
    "merchant-shipping-settings",
  ]
  for (const name of files) {
    const source = await Bun.file(
      `packages/core/src/protocol/${name}.ts`
    ).text()
    expect(source, name).not.toMatch(
      /\b(isValidSignedPublicNostrEvent|verifySignature|inheritVerifiedPublicEvent|hasVerifiedPublicEvent)\s*\(/
    )
    expect(source, name).not.toMatch(/\.eventsVerified\b/)
  }
  const barrel = await Bun.file("packages/core/src/protocol/index.ts").text()
  expect(barrel).not.toContain("FieldsForPrivateOrder")
  expect(barrel).not.toContain("AuthorizationForPrivateOrder")
  expect(barrel).not.toContain("parsePrivateOrderProductFields")
})
