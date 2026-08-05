import type { WalletDescriptor, WalletProviderId } from "@conduit/core"

const WALLET_CHANGE_EVENT = "conduit:wallets-changed"
const WALLET_CHANGE_CHANNEL = "conduit:wallets:v1"
const WALLET_CHANGE_STORAGE_KEY = "conduit:wallets-change:v1"

export interface WalletChangeBroadcastChannel {
  postMessage(message: unknown): void
  addEventListener(type: "message", listener: (event: unknown) => void): void
  removeEventListener(type: "message", listener: (event: unknown) => void): void
  close(): void
}

export interface WalletChangeRuntime {
  sourceId: string
  eventTarget: {
    addEventListener(type: string, listener: (event: unknown) => void): void
    removeEventListener(type: string, listener: (event: unknown) => void): void
    dispatchEvent(event: unknown): boolean | void
  }
  createEvent(type: string): unknown
  createBroadcastChannel?: () => WalletChangeBroadcastChannel
  storage?: Pick<Storage, "setItem">
  createToken(): string
}

export interface WalletChangeListenerObserver {
  onSuccess?(): void
  onError?(error: unknown): void
}

export function subscribeToWalletChanges(
  listener: () => void | Promise<void>,
  runtime: WalletChangeRuntime | null = getBrowserWalletChangeRuntime(),
  observer: WalletChangeListenerObserver = {}
): () => void {
  if (!runtime) return () => undefined

  const reportListenerError = (error: unknown) => {
    try {
      observer.onError?.(error)
    } catch {
      // Error reporting must not create an unhandled channel rejection.
    }
  }
  const reportListenerSuccess = () => {
    try {
      observer.onSuccess?.()
    } catch {
      // Completion reporting must not create an unhandled channel rejection.
    }
  }
  const invokeListener = () => {
    try {
      void Promise.resolve(listener()).then(
        reportListenerSuccess,
        reportListenerError
      )
    } catch (error) {
      reportListenerError(error)
    }
  }
  const handleLocalChange = () => invokeListener()
  runtime.eventTarget.addEventListener(WALLET_CHANGE_EVENT, handleLocalChange)

  let channel: WalletChangeBroadcastChannel | null = null
  const handleBroadcastChange = (event: unknown) => {
    const sourceId = (event as { data?: { sourceId?: unknown } }).data?.sourceId
    if (sourceId !== runtime.sourceId) invokeListener()
  }
  if (runtime.createBroadcastChannel) {
    try {
      channel = runtime.createBroadcastChannel()
      channel.addEventListener("message", handleBroadcastChange)
    } catch {
      channel = null
    }
  }

  const handleStorageChange = (event: unknown) => {
    const storageEvent = event as { key?: unknown; newValue?: unknown }
    if (
      storageEvent.key === WALLET_CHANGE_STORAGE_KEY &&
      typeof storageEvent.newValue === "string"
    ) {
      invokeListener()
    }
  }
  if (runtime.storage) {
    runtime.eventTarget.addEventListener("storage", handleStorageChange)
  }

  return () => {
    runtime.eventTarget.removeEventListener(
      WALLET_CHANGE_EVENT,
      handleLocalChange
    )
    runtime.eventTarget.removeEventListener("storage", handleStorageChange)
    if (channel) {
      channel.removeEventListener("message", handleBroadcastChange)
      channel.close()
    }
  }
}

export function notifyWalletsChanged(
  runtime: WalletChangeRuntime | null = getBrowserWalletChangeRuntime()
): void {
  if (!runtime) return

  runtime.eventTarget.dispatchEvent(runtime.createEvent(WALLET_CHANGE_EVENT))
  if (runtime.createBroadcastChannel) {
    try {
      const channel = runtime.createBroadcastChannel()
      channel.postMessage({
        type: "wallets_changed",
        sourceId: runtime.sourceId,
      })
      channel.close()
      return
    } catch {
      // Fall through to the storage-event transport.
    }
  }

  try {
    runtime.storage?.setItem(WALLET_CHANGE_STORAGE_KEY, runtime.createToken())
  } catch {
    // The same-document event already ran; storage may be unavailable.
  }
}

export function getRemovedWalletIdsForProvider(
  previousWallets: readonly WalletDescriptor[],
  nextWallets: readonly WalletDescriptor[],
  providerId: WalletProviderId
): string[] {
  return previousWallets
    .filter(
      (wallet) =>
        wallet.providerId === providerId &&
        !nextWallets.some(
          (candidate) =>
            candidate.id === wallet.id &&
            candidate.providerId === wallet.providerId
        )
    )
    .map((wallet) => wallet.id)
}

function getBrowserWalletChangeRuntime(): WalletChangeRuntime | null {
  if (typeof window === "undefined") return null

  let storage: Storage | undefined
  try {
    storage = window.localStorage
  } catch {
    storage = undefined
  }

  const BroadcastChannelConstructor =
    typeof globalThis.BroadcastChannel === "function"
      ? globalThis.BroadcastChannel
      : null

  return {
    sourceId: getBrowserWalletChangeSourceId(),
    eventTarget: {
      addEventListener(type, listener) {
        window.addEventListener(type, listener as EventListener)
      },
      removeEventListener(type, listener) {
        window.removeEventListener(type, listener as EventListener)
      },
      dispatchEvent(event) {
        return window.dispatchEvent(event as Event)
      },
    },
    createEvent: (type) => new Event(type),
    ...(BroadcastChannelConstructor && {
      createBroadcastChannel: () =>
        new BroadcastChannelConstructor(
          WALLET_CHANGE_CHANNEL
        ) as WalletChangeBroadcastChannel,
    }),
    storage,
    createToken: () => createBrowserWalletChangeToken(),
  }
}

let browserWalletChangeSourceId: string | null = null

function getBrowserWalletChangeSourceId(): string {
  browserWalletChangeSourceId ??= createBrowserWalletChangeToken()
  return browserWalletChangeSourceId
}

function createBrowserWalletChangeToken(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}
