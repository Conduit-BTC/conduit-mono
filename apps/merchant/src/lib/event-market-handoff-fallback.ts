const HANDOFF_FALLBACK_STORAGE_PREFIX =
  "conduit:merchant:event-handoff-fallback:v1"

export interface CoordinatedMerchantHandoffFallback {
  merchantPubkey: string
  orderCorrelationRef: string
  readyReceiptId: string
  confirmedAt: number
}

type FallbackStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function browserStorage(): FallbackStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage
}

function storageKey(
  merchantPubkey: string,
  orderCorrelationRef: string
): string {
  return `${HANDOFF_FALLBACK_STORAGE_PREFIX}:${merchantPubkey.trim().toLowerCase()}:${orderCorrelationRef.trim().toLowerCase()}`
}

function normalizeFallback(
  value: unknown
): CoordinatedMerchantHandoffFallback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Partial<CoordinatedMerchantHandoffFallback>
  const merchantPubkey = candidate.merchantPubkey?.trim().toLowerCase() ?? ""
  const orderCorrelationRef =
    candidate.orderCorrelationRef?.trim().toLowerCase() ?? ""
  const readyReceiptId = candidate.readyReceiptId?.trim().toLowerCase() ?? ""
  if (
    !/^[0-9a-f]{64}$/.test(merchantPubkey) ||
    !/^[0-9a-f]{64}$/.test(orderCorrelationRef) ||
    !/^[0-9a-f]{64}$/.test(readyReceiptId) ||
    typeof candidate.confirmedAt !== "number" ||
    !Number.isFinite(candidate.confirmedAt)
  ) {
    return null
  }
  return {
    merchantPubkey,
    orderCorrelationRef,
    readyReceiptId,
    confirmedAt: candidate.confirmedAt,
  }
}

export function loadCoordinatedMerchantHandoffFallback(
  input: {
    merchantPubkey: string
    orderCorrelationRef: string
    readyReceiptId: string
  },
  storage: Pick<Storage, "getItem"> | null = browserStorage()
): CoordinatedMerchantHandoffFallback | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(
      storageKey(input.merchantPubkey, input.orderCorrelationRef)
    )
    const parsed = raw ? normalizeFallback(JSON.parse(raw)) : null
    return parsed &&
      parsed.merchantPubkey === input.merchantPubkey.trim().toLowerCase() &&
      parsed.orderCorrelationRef ===
        input.orderCorrelationRef.trim().toLowerCase() &&
      parsed.readyReceiptId === input.readyReceiptId.trim().toLowerCase()
      ? parsed
      : null
  } catch {
    return null
  }
}

export function rememberCoordinatedMerchantHandoffFallback(
  input: Omit<CoordinatedMerchantHandoffFallback, "confirmedAt"> & {
    confirmedAt?: number
  },
  storage: Pick<Storage, "getItem" | "setItem"> | null = browserStorage()
): CoordinatedMerchantHandoffFallback | null {
  if (!storage) return null
  const marker = normalizeFallback({
    ...input,
    confirmedAt: input.confirmedAt ?? Date.now(),
  })
  if (!marker) return null
  try {
    storage.setItem(
      storageKey(marker.merchantPubkey, marker.orderCorrelationRef),
      JSON.stringify(marker)
    )
    return marker
  } catch {
    return null
  }
}

export function clearCoordinatedMerchantHandoffFallback(
  merchantPubkey: string,
  orderCorrelationRef: string,
  storage: Pick<Storage, "removeItem"> | null = browserStorage()
): boolean {
  if (!storage) return false
  try {
    storage.removeItem(storageKey(merchantPubkey, orderCorrelationRef))
    return true
  } catch {
    return false
  }
}
