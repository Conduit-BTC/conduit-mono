import NDK, { type NDKSigner } from "@nostr-dev-kit/ndk"
import { config } from "../config"

export type NdkConnectionState = "idle" | "connecting" | "connected" | "error"

export interface NdkState {
  status: NdkConnectionState
  connectedRelays: string[]
  error: string | null
}

type Listener = () => void

let ndkInstance: NDK | null = null
let state: NdkState = {
  status: "idle",
  connectedRelays: [],
  error: null,
}
let connectPromise: Promise<void> | null = null
let requirePromise: Promise<NDK> | null = null
const listeners = new Set<Listener>()

function setState(partial: Partial<NdkState>): void {
  state = { ...state, ...partial }
  listeners.forEach((fn) => fn())
}

function getConnectedRelayUrls(ndk: NDK): string[] {
  return Array.from(ndk.pool?.relays?.entries() ?? [])
    .filter(([, r]) => r.status === 1)
    .map(([url]) => url)
}

export function subscribeNdkState(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getNdkState(): NdkState {
  return state
}

export function getNdk(): NDK {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: config.defaultRelays,
    })
  }
  return ndkInstance
}

export async function connectNdk(timeoutMs = 10_000): Promise<void> {
  const ndk = getNdk()

  // If already connected with live relays, skip
  if (state.status === "connected" && getConnectedRelayUrls(ndk).length > 0) {
    return
  }

  if (connectPromise) {
    await connectPromise
    return
  }

  setState({ status: "connecting", error: null })

  connectPromise = (async () => {
    try {
      await ndk.connect(timeoutMs)

      const connected = getConnectedRelayUrls(ndk)

      if (connected.length > 0) {
        setState({ status: "connected", connectedRelays: connected, error: null })
      } else {
        setState({
          status: "error",
          error: "No relays responded within timeout",
          connectedRelays: [],
        })
      }
    } catch (err) {
      setState({
        status: "error",
        error: err instanceof Error ? err.message : "Failed to connect to relays",
        connectedRelays: [],
      })
    } finally {
      connectPromise = null
    }
  })()

  await connectPromise
}

export async function requireNdkConnected(timeoutMs = 10_000): Promise<NDK> {
  // Deduplicate concurrent callers — only one retry path runs at a time
  if (requirePromise) {
    return requirePromise
  }

  requirePromise = (async () => {
    try {
      await connectNdk(timeoutMs)

      let ndk = getNdk()
      if (getConnectedRelayUrls(ndk).length > 0) {
        setState({ status: "connected", connectedRelays: getConnectedRelayUrls(ndk), error: null })
        return ndk
      }

      // First attempt failed — reset the NDK instance for fresh websocket connections and retry
      const savedSigner = ndk.signer
      ndkInstance = null
      connectPromise = null
      ndk = getNdk()
      if (savedSigner) ndk.signer = savedSigner

      await connectNdk(timeoutMs * 2)

      const retryRelays = getConnectedRelayUrls(ndk)
      if (retryRelays.length === 0) {
        throw new Error(state.error ?? "Failed to connect to relays")
      }

      setState({ status: "connected", connectedRelays: retryRelays, error: null })
      return ndk
    } finally {
      requirePromise = null
    }
  })()

  return requirePromise
}

export function setSigner(signer: NDKSigner): void {
  const ndk = getNdk()
  ndk.signer = signer
}

export function removeSigner(): void {
  const ndk = getNdk()
  ndk.signer = undefined
}

export function disconnectNdk(): void {
  if (ndkInstance) {
    ndkInstance.signer = undefined
    ndkInstance = null
  }
  connectPromise = null
  requirePromise = null
  setState({
    status: "idle",
    connectedRelays: [],
    error: null,
  })
}
