import { describe, expect, it } from "bun:test"
import { getVariationPanelPlacement } from "../apps/market/src/lib/variation-panel-placement"

describe("getVariationPanelPlacement", () => {
  const card = { cardTop: 400, cardHeight: 400, panelHeight: 150 }

  it("keeps the panel below the card when the vertical extension fits", () => {
    expect(getVariationPanelPlacement({ ...card, viewportHeight: 1200 })).toBe(
      "below"
    )
  })

  it("switches above at the unscaled viewport boundary", () => {
    expect(getVariationPanelPlacement({ ...card, viewportHeight: 950 })).toBe(
      "below"
    )
    expect(getVariationPanelPlacement({ ...card, viewportHeight: 949 })).toBe(
      "above"
    )
  })

  it("treats fixed bottom chrome as unavailable space", () => {
    expect(
      getVariationPanelPlacement({
        ...card,
        viewportHeight: 1040,
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
