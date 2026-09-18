import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ProductImageUrlCollectionField } from "@conduit/ui"

describe("ProductImageUrlCollectionField", () => {
  it("starts with one primary field and a progressive add action", () => {
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="product-image"
        images={[]}
        onChange={() => {}}
        previewTitle="New product"
      />
    )

    expect(html).toContain("Primary image URL")
    expect(html).not.toContain("Image 2 URL")
    expect(html).toContain("Add another image")
    expect(html).toContain("up to 12")
    expect(html).toContain("Conduit Market card preview")
    expect(html).toContain("centered 4:3 crop")
  })

  it("renders only the image rows the merchant has opened", () => {
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="product-image"
        images={[
          { url: "https://cdn.conduit.market/cover.jpg" },
          { url: "https://cdn.conduit.market/detail.jpg" },
          { url: "https://cdn.conduit.market/back.jpg" },
        ]}
        onChange={() => {}}
        previewTitle="Three-image product"
      />
    )

    expect(html).toContain("Primary image URL")
    expect(html).toContain("Image 2 URL")
    expect(html).toContain("Image 3 URL")
    expect(html).not.toContain("Image 4 URL")
    expect(html).toContain(">Cover<")
    expect(html).toContain('aria-label="Move image 2 up"')
    expect(html).toContain('aria-label="Remove image 3"')
  })
})
