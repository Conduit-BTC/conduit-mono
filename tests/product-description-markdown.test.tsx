import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ProductDescriptionMarkdown,
  sanitizeMarketplaceMarkdownHref,
} from "../apps/market/src/components/ProductDescriptionMarkdown"

describe("ProductDescriptionMarkdown", () => {
  it("renders common marketplace markdown formatting", () => {
    const html = renderToStaticMarkup(
      <ProductDescriptionMarkdown
        text={[
          "### Sun Smile Joy",
          "",
          "Soft **pluche** with _bright_ stitching.",
          "",
          "- handmade",
          "- ready to ship",
          "",
          "[Store](https://bitpopart.com/products/sun-smile)",
        ].join("\n")}
      />
    )

    expect(html).toContain("<h3")
    expect(html).toContain("<strong>pluche</strong>")
    expect(html).toContain("<em>bright</em>")
    expect(html).toContain("<ul")
    expect(html).toContain('href="https://bitpopart.com/products/sun-smile"')
  })

  it("drops raw HTML, unsafe links, and markdown images", () => {
    const html = renderToStaticMarkup(
      <ProductDescriptionMarkdown
        text={[
          "Safe copy",
          "",
          '<script>alert("xss")</script>',
          "[bad](javascript:alert(1))",
          "![tracking pixel](https://example.com/pixel.png)",
        ].join("\n")}
      />
    )

    expect(html).toContain("Safe copy")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("https://example.com/pixel.png")
  })

  it("keeps product pricing as display markdown instead of structured data", () => {
    const html = renderToStaticMarkup(
      <ProductDescriptionMarkdown text="**Price:** 14.95 EUR" />
    )

    expect(html).toContain("<strong>Price:</strong>")
    expect(html).toContain("14.95 EUR")
  })

  it("only permits marketplace-safe markdown hrefs", () => {
    expect(sanitizeMarketplaceMarkdownHref("https://example.com/a")).toBe(
      "https://example.com/a"
    )
    expect(sanitizeMarketplaceMarkdownHref("http://example.com/a")).toBe(
      "http://example.com/a"
    )
    expect(sanitizeMarketplaceMarkdownHref("note1abc")).toBe(
      "https://njump.me/note1abc"
    )
    expect(sanitizeMarketplaceMarkdownHref("javascript:alert(1)")).toBeNull()
    expect(sanitizeMarketplaceMarkdownHref("/products/local")).toBeNull()
    expect(sanitizeMarketplaceMarkdownHref("data:text/html,owned")).toBeNull()
  })
})
