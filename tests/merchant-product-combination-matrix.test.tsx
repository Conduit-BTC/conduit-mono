import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ProductCombinationMatrix } from "../apps/merchant/src/components/ProductCombinationMatrix"
import {
  createEmptyProductVariationForm,
  createProductVariationAxis,
  generateProductVariationRows,
  getProductVariationMatrix,
} from "../apps/merchant/src/lib/productVariations"

describe("merchant product combination matrix", () => {
  it("renders arbitrary option columns with accessible availability controls", () => {
    const state = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis("option-a", "first, second", 0),
        createProductVariationAxis("option-b", "north, south", 1),
      ],
    })
    const matrix = getProductVariationMatrix(state)
    const markup = renderToStaticMarkup(
      <ProductCombinationMatrix
        axes={state.axes}
        combinations={matrix}
        onIncludeAll={() => undefined}
        onIncludedChange={() => undefined}
      />
    )

    expect(markup).toContain("Availability matrix")
    expect(markup).toContain('role="region"')
    expect(markup).toContain('aria-label="Combination availability matrix"')
    expect(markup).toContain("<table")
    expect(markup).toContain("<caption")
    expect(markup).toContain('scope="col"')
    expect(markup).toContain('scope="row"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain(
      'aria-label="Make option-a: first, option-b: north available"'
    )
    expect(markup.match(/type=\"checkbox\"/g)).toHaveLength(4)
  })
})
