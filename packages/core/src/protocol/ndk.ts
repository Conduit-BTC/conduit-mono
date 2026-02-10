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
const listeners = new Set<Listener>()

function setState(partial: Partial<NdkState>): void {
  state = { ...state, ...partial }
  listeners.forEach((fn) => fn())
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

export async function connectNdk(timeoutMs = 5000): Promise<void> {
  const ndk = getNdk()

  if (state.status === "connecting" || state.status === "connected") {
    return
  }

  setState({ status: "connecting", error: null })

  try {
    await ndk.connect(timeoutMs)

    const connected = Array.from(ndk.pool?.relays?.entries() ?? [])
      .filter(([, r]) => r.status === 1)
      .map(([url]) => url)

    setState({
      status: "connected",
      connectedRelays: connected,
    })
  } catch (err) {
    setState({
      status: "error",
      error: err instanceof Error ? err.message : "Failed to connect to relays",
      connectedRelays: [],
    })
  }
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
  setState({
    status: "idle",
    connectedRelays: [],
    error: null,
  })
}
