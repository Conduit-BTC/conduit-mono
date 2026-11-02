import { expect, it } from "bun:test"

it("manual native finalization keeps its invocation checkpoint in the final notice", async () => {
  const source = await Bun.file(
    "apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx"
  ).text()
  const native = source.slice(
    source.indexOf("async function finalizeNativeTreasury"),
    source.indexOf("async function reviewPayout")
  )
  expect(native).toContain("let recoveryCheckpoint: unknown")
  expect(native).toContain(
    "recoveryCheckpoint = observation.recoveryCheckpoint"
  )
  expect(native).toMatch(
    /formatMerchantCheckoutSparkPayoutObservation\(\s*continued\.payout,\s*recoveryCheckpoint\s*\)/
  )
})
