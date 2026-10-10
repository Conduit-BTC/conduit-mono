import { useState } from "react"
import type { BreezAddressState } from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import { Button, Input, Label } from "../index"
import { walletAddressStatus } from "./wallet-address-status"

/** One name-selection and retry surface for setup and existing wallet cards. */
export function WalletAddressSetup({
  walletId,
  value,
  resolve,
  onChange,
  onPendingChange,
}: {
  walletId: string
  value: BreezAddressState | null
  resolve: UseWalletsReturn["getSparkLightningAddress"]
  onChange(value: BreezAddressState): void
  onPendingChange(pending: boolean): void
}) {
  const [username, setUsername] = useState("")
  const [pending, setPending] = useState(false)
  const unavailable =
    value?.status === "unavailable" &&
    [
      "unconfigured",
      "unsupported_network",
      "invalid_configuration",
      "locked",
    ].includes(value.reason)
  const register = async () => {
    setPending(true)
    onPendingChange(true)
    try {
      onChange(await resolve(walletId, true, username.trim() || undefined))
    } catch {
      onChange({ status: "unavailable", reason: "provider_unavailable" })
    } finally {
      setPending(false)
      onPendingChange(false)
    }
  }
  return (
    <div className="grid gap-2 text-sm">
      <p role="status" className="text-pretty">
        {walletAddressStatus(value)}
      </p>
      {value && value.status !== "registered" && !unavailable && (
        <>
          <Label htmlFor={`wallet-address-name-${walletId}`}>
            Conduit address name
          </Label>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id={`wallet-address-name-${walletId}`}
              aria-label="Conduit address name"
              value={username}
              placeholder="Choose a name"
              autoCapitalize="none"
              autoCorrect="off"
              disabled={
                pending ||
                (value.status === "unavailable" &&
                  value.reason === "registration_pending")
              }
              onChange={(event) => setUsername(event.target.value)}
            />
            <span className="shrink-0">@conduit.cash</span>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Leave blank for an available generated name. Your wallet also
            receives one-off invoices.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={pending}
            onClick={() => void register()}
          >
            {pending
              ? "Checking…"
              : value.status === "unavailable" &&
                  value.reason === "registration_pending"
                ? "Retry address setup"
                : "Get conduit.cash address"}
          </Button>
        </>
      )}
    </div>
  )
}
