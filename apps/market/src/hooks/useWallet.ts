/**
 * useWallet - buyer NWC wallet state for Market fast checkout.
 *
 * Stores the NWC connection locally (localStorage) only.
 * The NWC URI is a private secret and must never be published,
 * sent to merchants, or included in order payloads.
 */
import { useCallback, useEffect, useState } from "react"
import {
  parseNwcUri,
  nwcGetInfo,
  type NwcConnection,
  type NwcGetInfoResult,
} from "@conduit/core"

const WALLET_STORAGE_KEY = "conduit:buyer-wallet-nwc"
const WALLET_CAPABILITY_STORAGE_KEY = "conduit:buyer-wallet-nwc-capability"
const WALLET_CAPABILITY_STALE_MS = 60 * 60_000

export type WalletConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "pay-capable"
  | "unsupported"
  | "error"

export interface WalletState {
  status: WalletConnectionStatus
  connection: NwcConnection | null
  info: NwcGetInfoResult | null
  /** Plain-language reason the wallet cannot be used for fast checkout, if any. */
  unavailableReason: string | null
  error: string | null
}

type StoredWalletCapability = {
  walletPubkey: string
  info: NwcGetInfoResult | null
  status: Extract<WalletConnectionStatus, "pay-capable" | "unsupported">
  checkedAt: number
}

export interface UseWalletReturn extends WalletState {
  connect: (uri: string) => Promise<void>
  disconnect: () => void
}

function readStoredConnection(): NwcConnection | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(WALLET_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as NwcConnection
  } catch {
    return null
  }
}

function writeStoredConnection(conn: NwcConnection): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(conn))
  } catch {
    // ignore
  }
}

function clearStoredConnection(): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(WALLET_STORAGE_KEY)
    localStorage.removeItem(WALLET_CAPABILITY_STORAGE_KEY)
  } catch {
    // ignore
  }
}

function readStoredCapability(
  connection: NwcConnection
): StoredWalletCapability | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(WALLET_CAPABILITY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredWalletCapability>
    if (
      parsed.walletPubkey !== connection.walletPubkey ||
      typeof parsed.checkedAt !== "number" ||
      (parsed.status !== "pay-capable" && parsed.status !== "unsupported")
    ) {
      return null
    }
    return {
      walletPubkey: parsed.walletPubkey,
      info: parsed.info ?? null,
      status: parsed.status,
      checkedAt: parsed.checkedAt,
    }
  } catch {
    return null
  }
}

function writeStoredCapability(
  connection: NwcConnection,
  info: NwcGetInfoResult
): StoredWalletCapability {
  const status = info.methods.includes("pay_invoice")
    ? "pay-capable"
    : "unsupported"
  const next: StoredWalletCapability = {
    walletPubkey: connection.walletPubkey,
    info,
    status,
    checkedAt: Date.now(),
  }
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(WALLET_CAPABILITY_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // ignore
    }
  }
  return next
}

function deriveStatus(
  info: NwcGetInfoResult | null,
  error: string | null,
  connection: NwcConnection | null
): WalletConnectionStatus {
  if (!connection) return "disconnected"
  if (error) return "error"
  if (!info) return "connected"
  if (info.methods.includes("pay_invoice")) return "pay-capable"
  return "unsupported"
}

function deriveUnavailableReason(
  status: WalletConnectionStatus
): string | null {
  switch (status) {
    case "disconnected":
      return "Connect a wallet to use fast checkout."
    case "connecting":
      return "Checking wallet capabilities..."
    case "error":
      return "Could not connect to wallet. Check the connection string."
    case "unsupported":
      return "Your wallet does not support outgoing payments via NWC."
    case "connected":
      return "Verifying wallet payment support..."
    case "pay-capable":
      return null
  }
}

export function useWallet(): UseWalletReturn {
  const [state, setState] = useState<Omit<WalletState, "unavailableReason">>({
    status: "disconnected",
    connection: null,
    info: null,
    error: null,
  })

  // Probe an existing stored connection on mount
  useEffect(() => {
    const stored = readStoredConnection()
    if (!stored) return

    const cached = readStoredCapability(stored)
    const cachedFresh =
      cached && Date.now() - cached.checkedAt < WALLET_CAPABILITY_STALE_MS

    setState((s) => ({
      ...s,
      connection: stored,
      info: cached?.info ?? null,
      status: cached ? cached.status : "connecting",
      error: null,
    }))

    if (cachedFresh) return

    nwcGetInfo(stored, 10_000, "market")
      .then((info) => {
        const resolved = writeStoredCapability(stored, info)
        setState((s) => ({
          ...s,
          info,
          error: null,
          status: resolved.status,
        }))
      })
      .catch(() => {
        // Keep stale pay-capable state usable if we had it; otherwise the
        // wallet is connected but payment support is unconfirmed.
        setState((s) => ({
          ...s,
          info: cached?.info ?? null,
          error: null,
          status: cached?.status ?? "connected",
        }))
      })
  }, [])

  // Recompute status when info or error changes
  const connection = state.connection
  const info = state.info
  const error = state.error

  const status =
    state.status === "connecting" ||
    state.status === "pay-capable" ||
    state.status === "unsupported"
      ? state.status
      : deriveStatus(info, error, connection)

  const connect = useCallback(async (uri: string) => {
    setState((s) => ({ ...s, status: "connecting", error: null }))

    let conn: NwcConnection
    try {
      conn = parseNwcUri(uri)
    } catch (e) {
      setState((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : "Invalid NWC URI",
      }))
      return
    }

    try {
      const info = await nwcGetInfo(conn, 10_000, "market")
      const resolved = writeStoredCapability(conn, info)
      writeStoredConnection(conn)
      setState({
        connection: conn,
        info,
        status: resolved.status,
        error: null,
      })
    } catch {
      // Capability probe failed but URI parsed - store and mark connected
      writeStoredConnection(conn)
      setState({
        connection: conn,
        info: null,
        status: "connected",
        error: null,
      })
    }
  }, [])

  const disconnect = useCallback(() => {
    clearStoredConnection()
    setState({
      status: "disconnected",
      connection: null,
      info: null,
      error: null,
    })
  }, [])

  const unavailableReason = deriveUnavailableReason(status)

  return {
    status,
    connection,
    info,
    error,
    unavailableReason,
    connect,
    disconnect,
  }
}
