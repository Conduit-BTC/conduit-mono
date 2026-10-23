import { useState } from "react"
import type { BreezAddressState } from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import { Button } from "../index"
import { walletAddressStatus } from "./wallet-address-status"

/** Default-address retry; branded names are approved through the request form. */
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
  const [pending, setPending] = useState(false)
  const unavailable =
    value?.status === "unavailable" &&
    [
      "unconfigured",
      "unsupported_network",
      "invalid_configuration",
      "locked",
    ].includes(value.reason)
  return (
    <div className="grid gap-2 text-sm">
      <p role="status" className="text-pretty">
        {walletAddressStatus(value)}
      </p>
      {value && value.status !== "registered" && !unavailable && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={async () => {
            setPending(true)
            onPendingChange(true)
            try {
              onChange(await resolve(walletId))
            } catch {
              onChange({
                status: "unavailable",
                reason: "provider_unavailable",
              })
            } finally {
              setPending(false)
              onPendingChange(false)
            }
          }}
        >
          {pending ? "Checking…" : "Retry receiving address"}
        </Button>
      )}
    </div>
  )
}
