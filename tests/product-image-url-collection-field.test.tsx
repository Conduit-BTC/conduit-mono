import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ProductImageUrlCollectionField } from "@conduit/ui"
import type { ProductImageUploadController } from "@conduit/core"

const uploadFile: ProductImageUploadController["uploadFile"] = async () => {
  throw new Error("render-only upload stub")
}
const uploadLifecycle = {
  uploadFile,
}

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
    expect(html).toContain("Add image")
    expect(html).not.toContain("Add another image")
    expect(html).toContain("up to 24")
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

  it("makes prepared file upload primary and URL entry secondary in configured mode", () => {
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="product-image"
        images={[]}
        onChange={() => {}}
        previewTitle="Configured product"
        upload={{
          isBusy: false,
          target: {
            kind: "configured",
            serverUrl: "https://media.conduit.market",
          },
          ...uploadLifecycle,
        }}
      />
    )

    expect(html).toContain("Add image")
    expect(html).not.toContain("Add another image")
    expect(html).toContain("Add by URL")
    expect(html).not.toContain("Primary image URL")
    expect(html).toContain("your configured media servers")
    expect(html).not.toContain("nostr.build")
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"')
    expect(html).toContain("multiple")
  })

  it("keeps file upload primary while exposing an empty required error", () => {
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="required-product-image"
        images={[]}
        onChange={() => {}}
        previewTitle="Required product"
        showRequiredError
        upload={{
          isBusy: false,
          target: {
            kind: "configured",
            serverUrl: "https://media.conduit.market",
          },
          ...uploadLifecycle,
        }}
      />
    )

    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('id="required-product-image-required-error"')
    expect(html).toContain("Add a product image before publishing.")
    expect(html).toContain(
      'aria-describedby="required-product-image-upload-help required-product-image-required-error"'
    )
    expect(html).not.toContain("Primary image URL")
  })

  it("offers batch uploads with a gentle hosting note and both links", () => {
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="default-images"
        images={[]}
        onChange={() => {}}
        previewTitle="Product"
        upload={{
          isBusy: false,
          target: { kind: "fallback", serverUrl: "https://blossom.ditto.pub" },
          ...uploadLifecycle,
        }}
      />
    )
    expect(html).toContain("multiple")
    expect(html).toContain("Add up to 24")
    expect(html).toContain("You’re using shared public media hosting.")
    expect(html).toContain("Compare nostr.build plans")
    expect(html).toContain('href="https://account.nostr.build/plans"')
    expect(html).toContain("Manage media servers")
    expect(html).toContain('href="/network"')
    expect(html).not.toContain("one uploaded image")
    expect(html).not.toContain("bg-[var(--warning)]")
  })
  it("allows additional uploads after a verified default image", () => {
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="default-images"
        images={[{ url: "https://cdn.example.com/one.png" }]}
        onChange={() => {}}
        previewTitle="Product"
        upload={{
          isBusy: false,
          target: { kind: "fallback", serverUrl: "https://blossom.ditto.pub" },
          ...uploadLifecycle,
        }}
      />
    )
    const index = html.indexOf("Add another image")
    expect(html.slice(html.lastIndexOf("<button", index), index)).not.toContain(
      'disabled=""'
    )
    expect(html).toContain("multiple")
  })

  it("keeps URL entry available while server authority is unresolved", () => {
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="pending-product-image"
        images={[]}
        onChange={() => {}}
        previewTitle="Pending product"
        upload={{
          isBusy: false,
          target: { kind: "pending", reason: "lookup_incomplete" },
          ...uploadLifecycle,
        }}
      />
    )
    const addImageIndex = html.indexOf("Add image")
    const addImageButtonStart = html.lastIndexOf("<button", addImageIndex)
    const addImageButton = html.slice(
      addImageButtonStart,
      html.indexOf(">", addImageButtonStart) + 1
    )
    expect(addImageButton).toContain('disabled=""')
    expect(html).toContain("Add by URL")
    expect(html).not.toContain("nostr.build")
  })

  it("lets a verified upload replace a blank URL row at the collection limit", () => {
    const html = renderToStaticMarkup(
      <ProductImageUrlCollectionField
        id="near-limit-product-image"
        images={[
          ...Array.from({ length: 11 }, (_, index) => ({
            url: `https://cdn.conduit.market/image-${index + 1}.png`,
          })),
          { url: "" },
        ]}
        onChange={() => {}}
        previewTitle="Near-limit product"
        upload={{
          isBusy: false,
          target: {
            kind: "configured",
            serverUrl: "https://media.conduit.market",
          },
          ...uploadLifecycle,
        }}
      />
    )
    const addLabelIndex = html.indexOf("Add another image")
    const addButtonStart = html.lastIndexOf("<button", addLabelIndex)
    const addButton = html.slice(
      addButtonStart,
      html.indexOf(">", addButtonStart) + 1
    )

    expect(addButtonStart).toBeGreaterThanOrEqual(0)
    expect(addButton).not.toContain('disabled=""')
  })
})
