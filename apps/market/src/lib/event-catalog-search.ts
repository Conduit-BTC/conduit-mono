import { normalizePubkey, pubkeyToNpub } from "@conduit/core"

export interface EventCatalogSearch {
  merchant?: string
  purchase?: "booth"
}

export function parseEventCatalogSearch(
  raw: Record<string, unknown>
): EventCatalogSearch {
  const merchant =
    typeof raw.merchant === "string"
      ? (normalizePubkey(raw.merchant) ?? undefined)
      : undefined
  return {
    ...(merchant ? { merchant: pubkeyToNpub(merchant) } : {}),
    ...(raw.purchase === "booth" ? { purchase: "booth" as const } : {}),
  }
}
