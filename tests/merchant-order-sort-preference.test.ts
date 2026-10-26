import { expect, test } from "bun:test"
import { emptyPrivateSettings } from "../packages/core/src/settings/documents"
import { rebaseSettings } from "../packages/core/src/settings/edits"
import { ORDER_SORT_OPTIONS } from "../apps/merchant/src/lib/order-phase"
test("all existing order-sort options use the private account settings contract", () => {
  const base = emptyPrivateSettings()
  for (const option of ORDER_SORT_OPTIONS) {
    const next = rebaseSettings(
      {
        baseline: base,
        changes: [{ path: "working.orderSort", value: option.value }],
      },
      base,
      "a".repeat(64)
    )
    expect(next.settings.working?.orderSort).toBe(option.value)
  }
})
