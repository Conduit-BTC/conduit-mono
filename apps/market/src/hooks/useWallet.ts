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

export type WalletConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "pay-capable"
  | "unsupported"
  | "unreachable"
  | "error"

export type NwcReachability =
  | "unchecked"
  | "checking"
  | "reachable"
  | "unreachable"

export interface WalletState {
  status: WalletConnectionStatus
  connection: NwcConnection | null
  info: NwcGetInfoResult | null
  reachability: NwcReachability
  lastProbeAt: number | null
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
    case "unreachable":
      return "Wallet saved, but its NWC relay is currently unreachable."
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
    reachability: "unchecked",
    lastProbeAt: null,
    error: null,
  })

  // Probe an existing stored connection on mount
  useEffect(() => {
    const stored = readStoredConnection()
    if (!stored) return

    const cached = readStoredCapability(stored)

    setState((s) => ({
      ...s,
      connection: stored,
      info: cached?.info ?? null,
      status: "connecting",
      reachability: "checking",
      error: null,
    }))

    nwcGetInfo(stored, 10_000, "market")
      .then((info) => {
        const resolved = writeStoredCapability(stored, info)
        setState((s) => ({
          ...s,
          info,
          error: null,
          status: resolved.status,
          reachability: "reachable",
          lastProbeAt: Date.now(),
        }))
      })
      .catch(() => {
        // Keep cached capability visible as historical metadata, but do not
        // advertise the wallet as live when the current probe fails.
        setState((s) => ({
          ...s,
          info: cached?.info ?? null,
          error: "Wallet saved, but its NWC relay is currently unreachable.",
          status: "unreachable",
          reachability: "unreachable",
          lastProbeAt: Date.now(),
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
    state.status === "unsupported" ||
    state.status === "unreachable"
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
        reachability: "reachable",
        lastProbeAt: Date.now(),
        error: null,
      })
    } catch {
      // Capability probe failed but URI parsed - store without advertising it
      // as ready. Checkout can still fall back to WebLN or the invoice.
      writeStoredConnection(conn)
      setState({
        connection: conn,
        info: null,
        status: "unreachable",
        reachability: "unreachable",
        lastProbeAt: Date.now(),
        error: "Wallet saved, but its NWC relay is currently unreachable.",
      })
    }
  }, [])

  const disconnect = useCallback(() => {
    clearStoredConnection()
    setState({
      status: "disconnected",
      connection: null,
      info: null,
      reachability: "unchecked",
      lastProbeAt: null,
      error: null,
    })
  }, [])

  const unavailableReason = deriveUnavailableReason(status)

  return {
    status,
    connection,
    info,
    reachability: state.reachability,
    lastProbeAt: state.lastProbeAt,
    error,
    unavailableReason,
    connect,
    disconnect,
  }
}
