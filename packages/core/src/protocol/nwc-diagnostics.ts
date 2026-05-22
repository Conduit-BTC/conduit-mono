import type { NwcConnection, NwcGetInfoResult } from "./nwc"

export type NwcDiagnosticCode =
  | "invalid_uri"
  | "private_relay"
  | "non_wss_relay"
  | "relay_unreachable"
  | "unsupported_pay_invoice"
  | "permission_or_budget"
  | "invoice_amount_mismatch"
  | "network_mismatch"
  | "ambiguous_timeout"
  | "unknown"

export type NwcDiagnosticSeverity = "info" | "warning" | "error"

export interface NwcDiagnostic {
  code: NwcDiagnosticCode
  severity: NwcDiagnosticSeverity
  title: string
  detail: string
  action: string
  relayHosts?: string[]
  safeManualFallback: boolean
}

export function sanitizeNwcRelayHosts(
  relays: readonly string[] | undefined
): string[] {
  return Array.from(
    new Set(
      (relays ?? [])
        .map((relay) => {
          try {
            return new URL(relay).host
          } catch {
            return null
          }
        })
        .filter(Boolean) as string[]
    )
  )
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true
  }
  if (normalized === "::1" || normalized === "[::1]") return true

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4) return false

  const first = Number(ipv4[1])
  const second = Number(ipv4[2])
  if (first === 10 || first === 127) return true
  if (first === 169 && second === 254) return true
  if (first === 192 && second === 168) return true
  if (first === 172 && second >= 16 && second <= 31) return true

  return false
}

export function getNwcRelayDiagnostics(
  connection: Pick<NwcConnection, "relays"> | null | undefined
): NwcDiagnostic[] {
  const diagnostics: NwcDiagnostic[] = []

  for (const relay of connection?.relays ?? []) {
    try {
      const url = new URL(relay)
      const relayHost = url.host
      if (url.protocol !== "wss:") {
        diagnostics.push({
          code: "non_wss_relay",
          severity: "warning",
          title: "NWC relay is not a secure websocket",
          detail:
            "Browser checkout should use a public wss:// NWC relay. Non-secure or unsupported relay URLs often fail from deployed previews.",
          action:
            "Create a new wallet app connection that uses a public wss:// NWC relay.",
          relayHosts: [relayHost],
          safeManualFallback: true,
        })
      }
      if (isPrivateHostname(url.hostname)) {
        diagnostics.push({
          code: "private_relay",
          severity: "warning",
          title: "NWC relay is local or private",
          detail:
            "This wallet connection points at a localhost or private-network relay. It may work only on the machine running the wallet, not from a deployed Market preview.",
          action:
            "For Alby Hub or local wallets, create a fresh app connection that uses a public NWC relay.",
          relayHosts: [relayHost],
          safeManualFallback: true,
        })
      }
    } catch {
      diagnostics.push({
        code: "invalid_uri",
        severity: "error",
        title: "NWC relay URL is invalid",
        detail:
          "The saved wallet connection includes a relay URL Conduit cannot parse.",
        action: "Replace this wallet connection with a new NWC app connection.",
        safeManualFallback: true,
      })
    }
  }

  return dedupeDiagnostics(diagnostics)
}

export function getInvalidNwcUriDiagnostic(): NwcDiagnostic {
  return {
    code: "invalid_uri",
    severity: "error",
    title: "Invalid NWC connection string",
    detail:
      "Conduit could not parse this nostr+walletconnect:// connection string.",
    action: "Copy a fresh NWC app connection from your Lightning wallet.",
    safeManualFallback: true,
  }
}

export function classifyNwcPaymentError(
  error: unknown,
  connection?: NwcConnection | null
): NwcDiagnostic {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  const relayHosts = sanitizeNwcRelayHosts(connection?.relays)

  if (normalized.includes("amount in invoice does not match")) {
    return {
      code: "invoice_amount_mismatch",
      severity: "error",
      title: "Invoice amount mismatch",
      detail:
        "The Lightning invoice amount did not match the checkout quote, so Conduit did not ask the wallet to pay it.",
      action: "Refresh checkout and request a new invoice before paying.",
      safeManualFallback: true,
    }
  }

  if (
    normalized.includes("permission") ||
    normalized.includes("budget") ||
    normalized.includes("unauthorized") ||
    normalized.includes("not authorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("insufficient")
  ) {
    return {
      code: "permission_or_budget",
      severity: "warning",
      title: "Wallet app connection rejected payment",
      detail:
        "The wallet or app connection appears to be missing payment permission, budget, or balance for this invoice.",
      action:
        "Update the wallet app connection permissions or budget, then retry or pay the invoice manually.",
      relayHosts,
      safeManualFallback: true,
    }
  }

  if (normalized.includes("network") && normalized.includes("mismatch")) {
    return {
      code: "network_mismatch",
      severity: "error",
      title: "Wallet network mismatch",
      detail:
        "The wallet appears to be on a different Lightning or Bitcoin network than this checkout.",
      action: "Switch to a wallet on the correct network before paying.",
      relayHosts,
      safeManualFallback: true,
    }
  }

  if (
    normalized.includes("failed to connect to nwc relay") ||
    (normalized.includes("relay") && normalized.includes("unreachable"))
  ) {
    return {
      code: "relay_unreachable",
      severity: "warning",
      title: "NWC relay unreachable",
      detail: "Conduit could not reach the wallet relay before payment moved.",
      action:
        "Retry after the wallet relay is online, replace the wallet connection, or pay the invoice manually.",
      relayHosts,
      safeManualFallback: true,
    }
  }

  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return {
      code: "ambiguous_timeout",
      severity: "warning",
      title: "Wallet payment timed out",
      detail:
        "The wallet request timed out after Conduit asked the wallet to pay. The payment may still have moved.",
      action:
        "Check your wallet before retrying or paying another invoice to avoid duplicate payment.",
      relayHosts,
      safeManualFallback: false,
    }
  }

  return {
    code: "unknown",
    severity: "warning",
    title: "Wallet payment failed",
    detail: "The connected wallet could not complete this payment.",
    action:
      "Check your wallet, then retry or use the manual invoice fallback if no payment moved.",
    relayHosts,
    safeManualFallback: false,
  }
}

export function getNwcConnectionDiagnostics({
  connection,
  info,
  status,
  error,
}: {
  connection: NwcConnection | null
  info: NwcGetInfoResult | null
  status?: string
  error?: string | null
}): NwcDiagnostic[] {
  const diagnostics = [...getNwcRelayDiagnostics(connection)]

  if (connection && info && !info.methods.includes("pay_invoice")) {
    diagnostics.push({
      code: "unsupported_pay_invoice",
      severity: "warning",
      title: "Wallet cannot pay invoices through NWC",
      detail:
        "This app connection does not advertise pay_invoice support, so fast checkout cannot use it for outgoing payments.",
      action:
        "Create a wallet app connection with outgoing payment permission enabled.",
      safeManualFallback: true,
    })
  }

  if (connection && (status === "unreachable" || error)) {
    diagnostics.push(classifyNwcPaymentError(error ?? "", connection))
  }

  return dedupeDiagnostics(diagnostics)
}

function dedupeDiagnostics(diagnostics: NwcDiagnostic[]): NwcDiagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.relayHosts?.join(",") ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
