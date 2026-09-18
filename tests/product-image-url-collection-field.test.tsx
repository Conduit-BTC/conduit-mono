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

  it("uses a whitespace-padded public URL for preview and add readiness", () => {
    const imageUrl = "https://cdn.jsdelivr.net/product-cover.png"
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="product-image"
        images={[{ url: `  ${imageUrl}  ` }]}
        onChange={() => {}}
        previewTitle="Padded URL product"
      />
    )
    const addLabelIndex = html.indexOf("Add another image")
    const addButtonStart = html.lastIndexOf("<button", addLabelIndex)
    const addButton = html.slice(
      addButtonStart,
      html.indexOf(">", addButtonStart) + 1
    )

    expect(html).toContain(`src="${imageUrl}"`)
    expect(addButtonStart).toBeGreaterThanOrEqual(0)
    expect(addButton).not.toContain('disabled=""')
  })
})
