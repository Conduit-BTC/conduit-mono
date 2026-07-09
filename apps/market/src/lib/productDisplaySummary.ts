import type { Product, ProductImage } from "@conduit/core"

export const PRODUCT_SUMMARY_FALLBACK =
  "This listing does not include a merchant-written summary yet. Product pricing, identity, and the order flow are still available."

type ProductSummarySource = Pick<Product, "summary" | "images">

const MARKDOWN_IMAGE_TITLE_PATTERN = String.raw`(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?`

function getProductImageUrls(images: readonly ProductImage[]): Set<string> {
  return new Set(
    images.map((image) => image.url.trim()).filter((url) => url.length > 0)
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isStandaloneMarkdownImageLineForUrl(
  line: string,
  imageUrl: string
): boolean {
  const escapedImageUrl = escapeRegExp(imageUrl)
  const pattern = new RegExp(
    String.raw`^!\[[^\]\n]*\]\(\s*(?:<${escapedImageUrl}>|${escapedImageUrl})${MARKDOWN_IMAGE_TITLE_PATTERN}\s*\)$`
  )

  return pattern.test(line)
}

function isStandaloneProductImageReference(
  line: string,
  imageUrls: ReadonlySet<string>
): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false

  if (imageUrls.has(trimmed)) return true

  for (const imageUrl of imageUrls) {
    if (isStandaloneMarkdownImageLineForUrl(trimmed, imageUrl)) return true
  }

  return false
}

function removeStandaloneProductImageReferences(
  summary: string,
  imageUrls: ReadonlySet<string>
): string {
  if (imageUrls.size === 0) return summary

  return summary
    .split(/\r?\n/)
    .filter((line) => !isStandaloneProductImageReference(line, imageUrls))
    .join("\n")
}

export function getProductDisplaySummary(
  product: ProductSummarySource
): string {
  const imageUrls = getProductImageUrls(product.images)
  const summary = removeStandaloneProductImageReferences(
    product.summary?.trim() ?? "",
    imageUrls
  )

  return (
    summary
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || PRODUCT_SUMMARY_FALLBACK
  )
}
