import { expect, test } from "bun:test"
import { emptyPrivateSettings } from "../packages/core/src/settings/documents"
import { rebaseSettings } from "../packages/core/src/settings/edits"
import { normalizeShopperPricePreference } from "../packages/core/src/pricing"
test("account settings drive price display without legacy device overrides", async () => {
  const base = emptyPrivateSettings()
  const next = rebaseSettings(
    {
      baseline: base,
      changes: [
        { path: "display.currency", value: "BTC" },
        { path: "display.bitcoinUnit", value: "sats" },
      ],
    },
    base,
    "a".repeat(64)
  )
  expect(
    normalizeShopperPricePreference({
      ...next.settings.display,
      currency: "BITCOIN",
    })
  ).toEqual({ currency: "BITCOIN", bitcoinUnit: "sats" })
  const source = await Bun.file(
    "apps/market/src/hooks/useShopperPricePreference.ts"
  ).text()
  expect(source).toContain("useShoppingSettings().preset.display")
  expect(source).not.toContain("localStorage")
  expect(source).not.toContain("DevicePriceOverride")
})
