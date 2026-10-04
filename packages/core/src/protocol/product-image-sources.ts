import { getHashFromURL } from "nostr-tools/nipb7"
import type { ProductImage } from "../types"
import { normalizePublicMediaUrl } from "../network-target-safety"

/** Only same-hash public URLs may be used as copies of one image. */
export function getProductImageSources(image?: ProductImage): string[] {
  const primary = normalizePublicMediaUrl(image?.url)
  if (!primary) return []
  const hash = image?.sha256
  if (
    typeof hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    getProductImageUrlHash(primary) !== hash
  )
    return [primary]
  const alternates = (
    Array.isArray(image?.fallbackUrls) ? image.fallbackUrls : []
  )
    .slice(0, 9)
    .map(normalizePublicMediaUrl)
    .filter(
      (url): url is string => !!url && getProductImageUrlHash(url) === hash
    )
  return [...new Set([primary, ...alternates])]
}

export function getProductImageUrlHash(url: string): string | null {
  return getHashFromURL(url)?.toLowerCase() ?? null
}

/** NIP-92 metadata supplements the ordered Open Markets image tags. */
export function readProductImageMetadata(
  url: string,
  tags: readonly string[][]
): ProductImage {
  const metadata = tags.find(
    (tag) => tag[0] === "imeta" && tag.includes(`url ${url}`)
  )
  if (!metadata) return { url }
  const hash = metadata.find((field) => field.startsWith("x "))?.slice(2)
  const candidate = {
    url,
    sha256: hash,
    fallbackUrls: metadata
      .filter((field) => field.startsWith("fallback "))
      .map((field) => field.slice(9)),
  }
  const sources = getProductImageSources(candidate)
  return hash &&
    getProductImageUrlHash(url) === hash &&
    /^[0-9a-f]{64}$/.test(hash)
    ? { url, sha256: hash, fallbackUrls: sources.slice(1) }
    : { url }
}
