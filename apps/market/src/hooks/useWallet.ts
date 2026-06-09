/**
 * useWallet - buyer NWC wallet state for Market zap out payments.
 *
 * Stores the NWC connection locally (localStorage) only.
 * The NWC URI is a private secret and must never be published,
 * sent to merchants, or included in order payloads.
 */
import { useCallback, useEffect, useState } from "react"
import {
  getInvalidNwcUriDiagnostic,
  getNwcConnectionDiagnostics,
  parseNwcUri,
  type NwcDiagnostic,
  type NwcConnection,
  type NwcGetInfoResult,
} from "@conduit/core"
import {
  getBuyerNwcSession,
  type NwcSessionSnapshot,
} from "../lib/buyer-nwc-session"

const WALLET_STORAGE_KEY = "conduit:buyer-wallet-nwc"
const WALLET_CAPABILITY_STORAGE_KEY = "conduit:buyer-wallet-nwc-capability"
const WALLET_RETRY_POLL_MS = 12_000

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
  /** Plain-language reason the wallet cannot be used to zap out, if any. */
  unavailableReason: string | null
  /** Sanitized diagnostics. Never includes the full NWC URI or secret. */
  diagnostics: NwcDiagnostic[]
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
  retry: () => Promise<void>
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

function isSameConnection(a: NwcConnection | null, b: NwcConnection): boolean {
  return (
    !!a &&
    a.walletPubkey === b.walletPubkey &&
    a.secret === b.secret &&
    a.relays.length === b.relays.length &&
    a.relays.every((relay, index) => relay === b.relays[index])
  )
}

function writeSnapshotCapabilityIfCurrent(
  connection: NwcConnection,
  snapshot: NwcSessionSnapshot
): void {
  if (snapshot.info && isSameConnection(snapshot.connection, connection)) {
    writeStoredCapability(connection, snapshot.info)
  }
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
      return "Connect a wallet to zap out."
    case "connecting":
      return "Checking wallet capabilities..."
    case "error":
      return "Could not connect to wallet. Check the connection string."
    case "unreachable":
      return "Wallet saved, but its NWC relay is currently unreachable. Conduit will retry when you pay."
    case "unsupported":
      return "Your wallet does not support outgoing payments via NWC."
    case "connected":
      return "Verifying wallet payment support..."
    case "pay-capable":
      return null
  }
}

function getStatusFromSessionSnapshot(
  snapshot: NwcSessionSnapshot
): WalletConnectionStatus {
  switch (snapshot.status) {
    case "disconnected":
      return "disconnected"
    case "warming":
      return "connecting"
    case "reachable":
      return "pay-capable"
    case "unsupported":
      return "unsupported"
    case "unreachable":
      return "unreachable"
    case "error":
      return "error"
  }
}

function getReachabilityFromSessionSnapshot(
  snapshot: NwcSessionSnapshot
): NwcReachability {
  switch (snapshot.status) {
    case "warming":
      return "checking"
    case "reachable":
    case "unsupported":
      return "reachable"
    case "unreachable":
    case "error":
      return "unreachable"
    case "disconnected":
      return "unchecked"
  }
}

function getStateFromSessionSnapshot(
  snapshot: NwcSessionSnapshot,
  fallbackInfo: NwcGetInfoResult | null = null
): Omit<WalletState, "unavailableReason"> {
  const info = snapshot.info ?? fallbackInfo
  const status = getStatusFromSessionSnapshot(snapshot)
  const error =
    snapshot.status === "error" || snapshot.status === "unreachable"
      ? (snapshot.error ??
        "Wallet saved, but its NWC relay is currently unreachable.")
      : null

  return {
    connection: snapshot.connection,
    info,
    status,
    reachability: getReachabilityFromSessionSnapshot(snapshot),
    lastProbeAt: snapshot.lastWarmAt,
    diagnostics: snapshot.connection
      ? getNwcConnectionDiagnostics({
          connection: snapshot.connection,
          info,
          status,
          error,
        })
      : [],
    error,
  }
}

export function useWallet(): UseWalletReturn {
  const [state, setState] = useState<Omit<WalletState, "unavailableReason">>({
    status: "disconnected",
    connection: null,
    info: null,
    reachability: "unchecked",
    lastProbeAt: null,
    diagnostics: [],
    error: null,
  })

  useEffect(() => {
    const session = getBuyerNwcSession()
    return session.subscribe((snapshot) => {
      setState(getStateFromSessionSnapshot(snapshot))
    })
  }, [])

  const retry = useCallback(async () => {
    const connection = readStoredConnection() ?? state.connection
    if (!connection) return

    const cached = readStoredCapability(connection)
    const session = getBuyerNwcSession()
    session.setConnection(connection)

    setState((s) => ({
      ...s,
      connection,
      info: s.info ?? cached?.info ?? null,
      status: "connecting",
      reachability: "checking",
      error: null,
    }))

    const snapshot = await session.warm()
    writeSnapshotCapabilityIfCurrent(connection, snapshot)
    setState(getStateFromSessionSnapshot(snapshot, cached?.info ?? null))
  }, [state.connection])

  useEffect(() => {
    if (
      !state.connection ||
      (state.status !== "unreachable" && state.status !== "error")
    ) {
      return
    }

    const intervalId = window.setInterval(() => {
      void retry().catch((error: unknown) => {
        console.warn("Failed to retry NWC wallet session", error)
      })
    }, WALLET_RETRY_POLL_MS)

    return () => window.clearInterval(intervalId)
  }, [retry, state.connection, state.status])

  // Probe an existing stored connection on mount
  useEffect(() => {
    const stored = readStoredConnection()
    if (!stored) return

    const cached = readStoredCapability(stored)
    const session = getBuyerNwcSession()
    session.setConnection(stored)

    setState((s) => ({
      ...s,
      connection: stored,
      info: cached?.info ?? null,
      status: "connecting",
      reachability: "checking",
      diagnostics: getNwcConnectionDiagnostics({
        connection: stored,
        info: cached?.info ?? null,
        status: "connecting",
      }),
      error: null,
    }))

    session
      .warm()
      .then((snapshot) => {
        writeSnapshotCapabilityIfCurrent(stored, snapshot)
        setState(getStateFromSessionSnapshot(snapshot, cached?.info ?? null))
      })
      .catch((error: unknown) => {
        // Keep cached capability visible as historical metadata, but do not
        // advertise the wallet as live when the current probe fails.
        setState((s) => ({
          ...s,
          info: cached?.info ?? null,
          error: "Wallet saved, but its NWC relay is currently unreachable.",
          status: "unreachable",
          reachability: "unreachable",
          lastProbeAt: Date.now(),
          diagnostics: getNwcConnectionDiagnostics({
            connection: stored,
            info: cached?.info ?? null,
            status: "unreachable",
            error: "Wallet saved, but its NWC relay is currently unreachable.",
          }),
        }))
        console.warn("Failed to warm NWC wallet session", error)
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
    setState((s) => ({
      ...s,
      status: "connecting",
      diagnostics: [],
      error: null,
    }))

    let conn: NwcConnection
    try {
      conn = parseNwcUri(uri)
    } catch (e) {
      setState((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : "Invalid NWC URI",
        diagnostics: [getInvalidNwcUriDiagnostic()],
      }))
      return
    }

    const session = getBuyerNwcSession()
    session.setConnection(conn)

    try {
      const snapshot = await session.warm()
      writeSnapshotCapabilityIfCurrent(conn, snapshot)
      writeStoredConnection(conn)
      setState(getStateFromSessionSnapshot(snapshot))
    } catch {
      // Capability probe failed but URI parsed - store without advertising it
      // as ready. The order flow can still fall back to WebLN or the invoice.
      writeStoredConnection(conn)
      const snapshot = session.getSnapshot()
      setState({
        connection: conn,
        info: snapshot.info,
        status: "unreachable",
        reachability: "unreachable",
        lastProbeAt: Date.now(),
        error: "Wallet saved, but its NWC relay is currently unreachable.",
        diagnostics: getNwcConnectionDiagnostics({
          connection: conn,
          info: null,
          status: "unreachable",
          error: "Wallet saved, but its NWC relay is currently unreachable.",
        }),
      })
    }
  }, [])

  const disconnect = useCallback(() => {
    clearStoredConnection()
    getBuyerNwcSession().setConnection(null)
    setState({
      status: "disconnected",
      connection: null,
      info: null,
      reachability: "unchecked",
      lastProbeAt: null,
      diagnostics: [],
      error: null,
    })
  }, [])

  const unavailableReason = deriveUnavailableReason(status)
  const diagnostics = connection
    ? getNwcConnectionDiagnostics({
        connection,
        info,
        status,
        error,
      })
    : state.diagnostics

  return {
    status,
    connection,
    info,
    reachability: state.reachability,
    lastProbeAt: state.lastProbeAt,
    diagnostics,
    error,
    unavailableReason,
    connect,
    retry,
    disconnect,
  }
}
