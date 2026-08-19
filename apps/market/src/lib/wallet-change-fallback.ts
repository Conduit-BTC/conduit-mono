const WALLET_CHANGE_STORAGE_KEY = "conduit:wallets-change:v1"
const WALLET_CHANGE_BROADCAST_PROBE = "conduit:wallets-change-fallback-probe"

export interface WalletChangeFallbackRuntime {
  createBroadcastChannel?: () => Pick<BroadcastChannel, "close">
  eventTarget: {
    addEventListener(type: "storage", listener: (event: unknown) => void): void
    removeEventListener(
      type: "storage",
      listener: (event: unknown) => void
    ): void
  }
  storage?: Pick<Storage, "setItem">
  createToken(): string
}

export function subscribeToWalletChangeFallback(
  listener: () => void,
  runtime: WalletChangeFallbackRuntime | null = getBrowserWalletChangeFallbackRuntime()
): () => void {
  if (!runtime?.storage) {
    return () => undefined
  }

  const handleStorageChange = (event: unknown) => {
    const storageEvent = event as { key?: unknown; newValue?: unknown }
    if (
      storageEvent.key === WALLET_CHANGE_STORAGE_KEY &&
      typeof storageEvent.newValue === "string"
    ) {
      listener()
    }
  }
  runtime.eventTarget.addEventListener("storage", handleStorageChange)

  return () => {
    runtime.eventTarget.removeEventListener("storage", handleStorageChange)
  }
}

export function notifyWalletChangeFallback(
  runtime: WalletChangeFallbackRuntime | null = getBrowserWalletChangeFallbackRuntime()
): void {
  if (!runtime?.storage) return

  if (runtime.createBroadcastChannel) {
    try {
      runtime.createBroadcastChannel().close()
      return
    } catch {
      // Fall through when BroadcastChannel is exposed but unusable here.
    }
  }

  try {
    runtime.storage.setItem(WALLET_CHANGE_STORAGE_KEY, runtime.createToken())
  } catch {
    // The origin reload still runs when storage is unavailable.
  }
}

function getBrowserWalletChangeFallbackRuntime(): WalletChangeFallbackRuntime | null {
  if (typeof window === "undefined") return null

  let storage: Storage | undefined
  try {
    storage = window.localStorage
  } catch {
    storage = undefined
  }

  return {
    ...(typeof globalThis.BroadcastChannel === "function" && {
      createBroadcastChannel: () =>
        new globalThis.BroadcastChannel(WALLET_CHANGE_BROADCAST_PROBE),
    }),
    eventTarget: {
      addEventListener(type, listener) {
        window.addEventListener(type, listener as EventListener)
      },
      removeEventListener(type, listener) {
        window.removeEventListener(type, listener as EventListener)
      },
    },
    storage,
    createToken: () =>
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
  }
}
