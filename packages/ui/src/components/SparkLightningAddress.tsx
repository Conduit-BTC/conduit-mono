import { useEffect, useRef, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import { encodeLnurl } from "@conduit/core"
import type {
  WalletLightningAddressState,
  SavedLightningAddressState,
} from "@conduit/core/wallets/resolve-spark-lightning-address"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
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
  resolve: UseWalletsReturn["getSparkLightningAddress"]
}) {
  const [state, setState] = useState<{
    walletId: string
    value: WalletLightningAddressState
  } | null>(null)
  const [pending, setPending] = useState(false)
  const observation = useRef<AbortController | null>(null)
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  )
  useEffect(() => {
    if (!walletId) return
    let active = true
    const controller = new AbortController()
    observation.current = controller
    const preview: { saved?: SavedLightningAddressState } = {}
    const accept = (value: WalletLightningAddressState) => {
      if (active && !controller.signal.aborted) setState({ walletId, value })
    }
    void resolve(walletId, false, undefined, undefined, {
      signal: controller.signal,
      onSavedAddress: (saved) => {
        preview.saved = saved
        accept(saved)
      },
    }).then(accept, () =>
      accept(
        preview.saved
          ? { ...preview.saved, availability: "unavailable" }
          : { status: "unavailable", reason: "provider_unavailable" }
      )
    )
    return () => {
      active = false
      observation.current?.abort()
    }
  }, [walletId, resolve])
  const value = state?.walletId === walletId ? state.value : null
  const setup = async () => {
    if (!walletId || pending || disabled) return
    const selected = walletId
    observation.current?.abort()
    const controller = new AbortController()
    observation.current = controller
    setPending(true)
    onPendingChange?.(true)
    setCopyStatus("idle")
    try {
      const result = await resolve(selected, true, undefined, undefined, {
        priority: "foreground",
        signal: controller.signal,
        onSavedAddress: (saved) => {
          if (!controller.signal.aborted)
            setState({ walletId: selected, value: saved })
        },
      })
      if (!controller.signal.aborted)
        setState({ walletId: selected, value: result })
    } catch {
      if (!controller.signal.aborted)
        setState((previous) => ({
          walletId: selected,
          value:
            previous?.walletId === selected && previous.value.status === "saved"
              ? { ...previous.value, availability: "unavailable" }
              : { status: "unavailable", reason: "provider_unavailable" },
        }))
    } finally {
      setPending(false)
      onPendingChange?.(false)
    }
  }
  if (!walletId) return null
  const verified =
    value?.status === "registered" && value.publicLookup === "verified"
  const canRetry =
    (value?.status === "saved" && value.availability !== "checking") ||
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
    <div className="grid min-w-0 gap-3 text-center">
      {verified && (
        <div
          role="img"
          aria-label="Reusable Lightning address QR code"
          className="mx-auto size-56 max-w-full"
        >
          <QRCodeSVG
            value={encodeLnurl(value.lnurl).toUpperCase()}
            size={224}
            marginSize={4}
            className="!size-full"
          />
        </div>
      )}
      <div>
        {value?.status === "saved" && (
          <p className="break-all text-base">{value.address}</p>
        )}
        {!verified && (
          <p className="text-sm text-[var(--text-secondary)]">
            Lightning address
          </p>
        )}
        <p role="status" className="mt-1 break-words text-sm">
          {walletAddressStatus(value)}
        </p>
      </div>
      {value && !verified && (
        <p className="text-sm text-[var(--text-secondary)]">
          You can still receive with a Lightning invoice.
        </p>
      )}
      {verified && (
        <p className="text-sm text-[var(--text-secondary)]">
          Scan with a Lightning wallet to send sats.
        </p>
      )}
      {(verified || value?.status === "saved") && (
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
          {copyStatus === "copied" ? "Copied" : "Copy address"}
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
          {value?.status === "saved"
            ? pending
              ? "Checking…"
              : "Retry receiving address"
            : pending
              ? "Setting up address…"
              : value?.status === "absent"
                ? "Set up Lightning address"
                : "Retry address setup"}
        </Button>
      )}
    </div>
  )
}
