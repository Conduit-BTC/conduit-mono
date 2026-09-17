import { normalizePubkey, pubkeyToNpub } from "@conduit/core"

export interface EventCatalogSearch {
  merchant?: string
}

export function parseEventCatalogSearch(
  raw: Record<string, unknown>
): EventCatalogSearch {
  const merchant =
    typeof raw.merchant === "string"
      ? (normalizePubkey(raw.merchant) ?? undefined)
      : undefined
  return merchant ? { merchant: pubkeyToNpub(merchant) } : {}
}
