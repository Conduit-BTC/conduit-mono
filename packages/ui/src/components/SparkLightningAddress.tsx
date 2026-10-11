import { useEffect, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { encodeLnurl, type BreezAddressState } from "@conduit/core"
import { Button } from "../index"

import { walletAddressStatus } from "./wallet-address-status"

export function SparkLightningAddress({
  walletId,
  resolve,
  disabled = false,
  onPendingChange,
}: {
  walletId: string | null
  disabled?: boolean
  onPendingChange?(pending: boolean): void
  resolve(walletId: string, register?: boolean): Promise<BreezAddressState>
}) {
  const [state, setState] = useState<{
    walletId: string
    value: BreezAddressState
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  )
  useEffect(() => {
    if (!walletId) return
    let active = true
    const lookup = async () => {
      let value: BreezAddressState
      try {
        value = await resolve(walletId)
      } catch {
        value = { status: "unavailable", reason: "provider_unavailable" }
      }
      if (active) setState({ walletId, value })
    }
    void lookup()
    return () => {
      active = false
    }
  }, [walletId, resolve])
  const value = state?.walletId === walletId ? state.value : null
  const setup = async () => {
    if (!walletId || pending || disabled) return
    const selected = walletId
    setPending(true)
    onPendingChange?.(true)
    setCopyStatus("idle")
    try {
      setState({ walletId: selected, value: await resolve(selected, true) })
    } catch {
      setState({
        walletId: selected,
        value: { status: "unavailable", reason: "provider_unavailable" },
      })
    } finally {
      setPending(false)
      onPendingChange?.(false)
    }
  }
  if (!walletId) return null
  const verified =
    value?.status === "registered" && value.publicLookup === "verified"
  const canRetry =
    value?.status === "absent" ||
    (value?.status === "registered" && !verified) ||
    (value?.status === "unavailable" &&
      ![
        "unconfigured",
        "unsupported_network",
        "invalid_configuration",
        "locked",
      ].includes(value.reason))
  return (
    <div className="grid gap-2 rounded-lg border border-[var(--border)] p-3">
      <p className="text-sm font-medium">Lightning address</p>
      <p role="status" className="text-sm text-[var(--text-secondary)]">
        {walletAddressStatus(value)}
      </p>
      <p className="text-xs text-[var(--text-secondary)]">
        You can create a Lightning invoice below while address setup is
        unavailable.
      </p>
      {verified && (
        <div role="img" aria-label="Reusable Lightning address QR code">
          <QRCodeSVG
            value={encodeLnurl(value.lnurl).toUpperCase()}
            size={160}
          />
        </div>
      )}
      {verified && (
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value.address)
              setCopyStatus("copied")
            } catch {
              setCopyStatus("error")
            }
          }}
        >
          {copyStatus === "copied" ? "Copied" : "Copy Lightning address"}
        </Button>
      )}
      {copyStatus === "error" && (
        <p role="alert">Could not copy the address. Try again.</p>
      )}
      {canRetry && (
        <Button
          variant="outline"
          disabled={pending || disabled}
          aria-busy={pending}
          onClick={() => void setup()}
        >
          {pending
            ? "Setting up address…"
            : value?.status === "absent"
              ? "Set up Lightning address"
              : "Retry address setup"}
        </Button>
      )}
    </div>
  )
}
