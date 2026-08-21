export type ShopperPresetsUnlockPolicy = "device" | "session" | "always"

const LEGACY_PRESETS_STORAGE_KEY_PREFIX = "conduit:market-shopper-presets:v1"
const UNLOCK_STORAGE_KEY_PREFIX = "conduit:market-shopper-presets-unlock:v1"
const POLICY_STORAGE_KEY_PREFIX = "conduit:market-shopper-presets-policy:v1"

type StorageRead = Pick<Storage, "getItem">
type StorageWrite = Pick<Storage, "setItem" | "removeItem">

type StoredUnlock = {
  version: 1
  password: string
}

function readStorageItem(storage: StorageRead, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function setStorageItem(
  storage: StorageWrite,
  key: string,
  value: string
): void {
  try {
    storage.setItem(key, value)
  } catch {
    // Local unlock persistence must not affect relay preset operations.
  }
}

function removeStorageItem(storage: StorageWrite, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // Cleanup remains best-effort when browser storage is unavailable.
  }
}

export function getLegacyShopperPresetsStorageKey(pubkey: string): string {
  return `${LEGACY_PRESETS_STORAGE_KEY_PREFIX}:${pubkey}`
}

export function getShopperPresetsUnlockStorageKey(pubkey: string): string {
  return `${UNLOCK_STORAGE_KEY_PREFIX}:${pubkey}`
}

export function getShopperPresetsPolicyStorageKey(pubkey: string): string {
  return `${POLICY_STORAGE_KEY_PREFIX}:${pubkey}`
}

export function readShopperPresetsUnlockPolicy(
  pubkey: string,
  storage: StorageRead
): ShopperPresetsUnlockPolicy {
  const value = readStorageItem(
    storage,
    getShopperPresetsPolicyStorageKey(pubkey)
  )
  return value === "device" || value === "session" ? value : "always"
}

export function readRememberedShopperPresetsPassword(
  pubkey: string,
  localStorage: StorageRead,
  sessionStorage: StorageRead
): {
  password: string
  policy: Exclude<ShopperPresetsUnlockPolicy, "always">
} | null {
  const candidates = [
    { storage: sessionStorage, policy: "session" as const },
    { storage: localStorage, policy: "device" as const },
  ]
  for (const candidate of candidates) {
    try {
      const raw = readStorageItem(
        candidate.storage,
        getShopperPresetsUnlockStorageKey(pubkey)
      )
      if (!raw) continue
      const parsed = JSON.parse(raw) as Partial<StoredUnlock>
      if (
        parsed.version === 1 &&
        typeof parsed.password === "string" &&
        parsed.password.length > 0
      ) {
        return { password: parsed.password, policy: candidate.policy }
      }
    } catch {
      continue
    }
  }
  return null
}

export function persistShopperPresetsUnlock(
  pubkey: string,
  password: string,
  policy: ShopperPresetsUnlockPolicy,
  localStorage: StorageWrite,
  sessionStorage: StorageWrite
): void {
  const unlockKey = getShopperPresetsUnlockStorageKey(pubkey)
  const policyKey = getShopperPresetsPolicyStorageKey(pubkey)
  removeStorageItem(localStorage, unlockKey)
  removeStorageItem(sessionStorage, unlockKey)
  setStorageItem(localStorage, policyKey, policy)
  if (policy === "always") return
  const target = policy === "device" ? localStorage : sessionStorage
  setStorageItem(
    target,
    unlockKey,
    JSON.stringify({ version: 1, password } satisfies StoredUnlock)
  )
}

export function clearShopperPresetsUnlock(
  pubkey: string,
  localStorage: StorageWrite,
  sessionStorage: StorageWrite
): void {
  const key = getShopperPresetsUnlockStorageKey(pubkey)
  removeStorageItem(localStorage, key)
  removeStorageItem(sessionStorage, key)
}

export function removeLegacyPlaintextShopperPresets(
  pubkey: string,
  storage: StorageWrite
): void {
  removeStorageItem(storage, getLegacyShopperPresetsStorageKey(pubkey))
}

export function getBrowserShopperPresetsStorage(): {
  local: Storage
  session: Storage
} | null {
  if (typeof window === "undefined") return null
  try {
    return { local: window.localStorage, session: window.sessionStorage }
  } catch {
    return null
  }
}
