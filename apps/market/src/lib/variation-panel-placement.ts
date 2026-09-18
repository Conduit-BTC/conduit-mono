export type VariationPanelPlacement = "below" | "above"

export interface VariationPanelPlacementInput {
  /** Card top edge relative to the viewport. */
  cardTop: number
  /** Card height. */
  cardHeight: number
  /** Panel height, including its padding. */
  panelHeight: number
  viewportHeight: number
  /** Fixed chrome covering the bottom of the viewport, such as the cart HUD. */
  bottomInset?: number
}

/**
 * Place the joined variation panel where its vertical extension still fits
 * inside the viewport.
 */
export function getVariationPanelPlacement(
  input: VariationPanelPlacementInput
): VariationPanelPlacement {
  const bottomLimit = input.viewportHeight - (input.bottomInset ?? 0)

  const fitsBelow =
    input.cardTop + input.cardHeight + input.panelHeight <= bottomLimit
  if (fitsBelow) return "below"

  const fitsAbove = input.cardTop - input.panelHeight >= 0
  return fitsAbove ? "above" : "below"
}

export function readRootPixelVariable(name: string): number {
  if (typeof document === "undefined") return 0
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    name
  )
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}
