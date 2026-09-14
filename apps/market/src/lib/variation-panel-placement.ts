export type VariationPanelPlacement = "below" | "above"

export const EXPANDED_PRODUCT_CARD_SCALE = 1.12

export interface VariationPanelPlacementInput {
  /** Unscaled card top edge relative to the viewport. */
  cardTop: number
  /** Unscaled card height. */
  cardHeight: number
  /** Unscaled panel height, including its padding. */
  panelHeight: number
  viewportHeight: number
  /** Fixed chrome covering the bottom of the viewport, such as the cart HUD. */
  bottomInset?: number
  scale?: number
}

/**
 * Place the joined variation panel where the expanded card still fits inside
 * the viewport. The card scales around its center, so both edges move.
 */
export function getVariationPanelPlacement(
  input: VariationPanelPlacementInput
): VariationPanelPlacement {
  const scale = input.scale ?? EXPANDED_PRODUCT_CARD_SCALE
  const center = input.cardTop + input.cardHeight / 2
  const scaledHalfHeight = (input.cardHeight * scale) / 2
  const scaledPanelHeight = input.panelHeight * scale
  const bottomLimit = input.viewportHeight - (input.bottomInset ?? 0)

  const fitsBelow = center + scaledHalfHeight + scaledPanelHeight <= bottomLimit
  if (fitsBelow) return "below"

  const fitsAbove = center - scaledHalfHeight - scaledPanelHeight >= 0
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
