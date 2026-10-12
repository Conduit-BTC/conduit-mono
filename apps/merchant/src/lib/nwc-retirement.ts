import type { LegacyNwcRetirement } from "@conduit/core/wallets/wallet-migration"
import { NWC_URI_STORAGE_KEY } from "./readiness"

interface NwcRetirementStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
}

/** Keep the account-owned copy until optional legacy cleanup has finished. */
export function retireAccountNwcUri(input: {
  storage: NwcRetirementStorage
  accountStorageKey: string | null
  currentAccountStorageKey(): string | null
  expectedUri: string
  notifyChange?(): void
}): LegacyNwcRetirement {
  const { accountStorageKey, storage, expectedUri } = input
  if (!accountStorageKey) return { status: "unchanged" }

  try {
    if (input.currentAccountStorageKey() !== accountStorageKey)
      return { status: "unchanged" }
    if (storage.getItem(accountStorageKey) !== expectedUri)
      return { status: "unchanged" }
    if (storage.getItem(NWC_URI_STORAGE_KEY) === expectedUri)
      storage.removeItem(NWC_URI_STORAGE_KEY)
    // A different account or URI can replace the candidate during cleanup.
    if (
      input.currentAccountStorageKey() !== accountStorageKey ||
      storage.getItem(accountStorageKey) !== expectedUri
    )
      return { status: "unchanged" }
  } catch {
    // No account-owned deletion has been attempted, so compensation is safe.
    return { status: "unchanged", error: "storage" }
  }

  let status: "completed" | "uncertain"
  try {
    storage.removeItem(accountStorageKey)
    status = "completed"
  } catch {
    // Storage may have changed before the exception. Keep the verified copy.
    status = "uncertain"
  }
  notifyChange(input.notifyChange)
  return { status }
}

function notifyChange(callback?: () => void): void {
  try {
    callback?.()
  } catch {
    // An advisory signal cannot turn completed retirement into failed storage.
    console.warn("Could not notify Merchant NWC storage change")
  }
}
