import {
  normalizeProductJsonDisplaySummary,
  type Product,
  type ProductImage,
} from "@conduit/core"

export const PRODUCT_SUMMARY_FALLBACK =
  "This listing does not include a merchant-written summary yet. Product pricing, identity, and the order flow are still available."

type ProductSummarySource = Pick<Product, "summary" | "images">

const MARKDOWN_IMAGE_TITLE_PATTERN = /^(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))$/

function getProductImageUrls(images: readonly ProductImage[]): Set<string> {
  return new Set(
    images.map((image) => image.url.trim()).filter((url) => url.length > 0)
  )
}

function getStandaloneMarkdownImageUrl(line: string): string | null {
  const prefix = line.match(/^!\[[^\]\n]*\]\(\s*/)?.[0]
  if (!prefix || !line.endsWith(")")) return null

  const body = line.slice(prefix.length, -1).trim()
  if (!body) return null

  if (body.startsWith("<")) {
    const closingBracketIndex = body.indexOf(">")
    if (closingBracketIndex < 1) return null

    const url = body.slice(1, closingBracketIndex)
    const title = body.slice(closingBracketIndex + 1).trim()
    return !title || MARKDOWN_IMAGE_TITLE_PATTERN.test(title) ? url : null
  }

  let parenthesisDepth = 0
  let destinationEnd = body.length
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === "(") parenthesisDepth += 1
    if (character === ")" && parenthesisDepth > 0) parenthesisDepth -= 1
    if (/\s/.test(character) && parenthesisDepth === 0) {
      destinationEnd = index
      break
    }
  }

  const url = body.slice(0, destinationEnd)
  const title = body.slice(destinationEnd).trim()
  return url && (!title || MARKDOWN_IMAGE_TITLE_PATTERN.test(title))
    ? url
    : null
}

function isStandaloneProductImageReference(
  line: string,
  imageUrls: ReadonlySet<string>
): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false

  if (imageUrls.has(trimmed)) return true

  const markdownImageUrl = getStandaloneMarkdownImageUrl(trimmed)
  return markdownImageUrl !== null && imageUrls.has(markdownImageUrl)
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
  const rawSummary = product.summary?.trim() ?? ""
  const normalizedSummary = normalizeProductJsonDisplaySummary(rawSummary) ?? ""
  const summary = removeStandaloneProductImageReferences(
    normalizedSummary,
    imageUrls
  )

  return (
    summary
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || PRODUCT_SUMMARY_FALLBACK
  )
}
