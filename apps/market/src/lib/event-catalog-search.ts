import {
  normalizePubkey,
  parseAddressableCoordinate,
  pubkeyToNpub,
} from "@conduit/core"

export interface EventCatalogSearch {
  merchant?: string
  occurrence?: string
}

export function parseEventCatalogSearch(
  raw: Record<string, unknown>
): EventCatalogSearch {
  const merchant =
    typeof raw.merchant === "string"
      ? (normalizePubkey(raw.merchant) ?? undefined)
      : undefined
  const occurrence =
    typeof raw.occurrence === "string"
      ? parseAddressableCoordinate(raw.occurrence, [31922, 31923])?.coordinate
      : undefined
  return {
    ...(merchant ? { merchant: pubkeyToNpub(merchant) } : {}),
    ...(occurrence ? { occurrence } : {}),
  }
}
