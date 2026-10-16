import type { MerchantOrderSort } from "./order-phase"

const STORAGE_KEY = "conduit:merchant:order-sort:v1"

function isMerchantOrderSort(value: unknown): value is MerchantOrderSort {
  return value === "newest" || value === "recent" || value === "priority"
}

/** Device UI preference only: no account, order, or payment data is stored. */
export function readMerchantOrderSort(
  storage?: Pick<Storage, "getItem"> | null
): MerchantOrderSort {
  try {
    const source =
      storage === undefined
        ? typeof localStorage === "undefined"
          ? null
          : localStorage
        : storage
    const value = source?.getItem(STORAGE_KEY)
    return isMerchantOrderSort(value) ? value : "newest"
  } catch {
    return "newest"
  }
}

export function saveMerchantOrderSort(
  sort: MerchantOrderSort,
  storage?: Pick<Storage, "setItem"> | null
): void {
  if (!isMerchantOrderSort(sort)) return
  try {
    const target =
      storage === undefined
        ? typeof localStorage === "undefined"
          ? null
          : localStorage
        : storage
    target?.setItem(STORAGE_KEY, sort)
  } catch {
    // Preference storage is optional; the current screen still uses the choice.
  }
}
