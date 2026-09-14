import { describe, expect, it } from "bun:test"
import { getVariationPanelPlacement } from "../apps/market/src/lib/variation-panel-placement"

describe("getVariationPanelPlacement", () => {
  const card = { cardTop: 400, cardHeight: 400, panelHeight: 150 }

  it("keeps the panel below the card when the expanded card fits", () => {
    expect(getVariationPanelPlacement({ ...card, viewportHeight: 1200 })).toBe(
      "below"
    )
  })

  it("accounts for the centered scale growth and the scaled panel", () => {
    // Center 600, scaled half height 224, scaled panel 168: bottom at 992.
    expect(getVariationPanelPlacement({ ...card, viewportHeight: 992 })).toBe(
      "below"
    )
    expect(getVariationPanelPlacement({ ...card, viewportHeight: 991 })).toBe(
      "above"
    )
  })

  it("treats fixed bottom chrome as unavailable space", () => {
    expect(
      getVariationPanelPlacement({
        ...card,
        viewportHeight: 1060,
        bottomInset: 100,
      })
    ).toBe("above")
  })

  it("stays below when the panel would not fit above either", () => {
    expect(
      getVariationPanelPlacement({
        cardTop: 10,
        cardHeight: 400,
        panelHeight: 150,
        viewportHeight: 500,
      })
    ).toBe("below")
  })
})
