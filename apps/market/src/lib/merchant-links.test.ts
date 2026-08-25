import { inferMerchantOrigin } from "./merchant-links"

declare function test(name: string, fn: () => void): void
declare function expect(actual: unknown): {
  toBe(expected: unknown): void
}

test("uses the Merchant app as the canonical production origin", () => {
  expect(inferMerchantOrigin(undefined)).toBe("https://sell.conduit.market")
})

test("pairs production previews and signet previews", () => {
  expect(
    inferMerchantOrigin({
      hostname: "branch.conduit-market-coo.pages.dev",
      protocol: "https:",
      port: "",
    })
  ).toBe("https://branch.conduit-merchant-33n.pages.dev")
  expect(
    inferMerchantOrigin({
      hostname: "branch.conduit-market-signet.pages.dev",
      protocol: "https:",
      port: "",
    })
  ).toBe("https://branch.conduit-merchant-signet.pages.dev")
})

test("pairs supported local Market and Merchant ports", () => {
  expect(
    inferMerchantOrigin({
      hostname: "127.0.0.1",
      protocol: "http:",
      port: "7000",
    })
  ).toBe("http://127.0.0.1:7001")
  expect(
    inferMerchantOrigin({
      hostname: "localhost",
      protocol: "http:",
      port: "5173",
    })
  ).toBe("http://localhost:5174")
})
