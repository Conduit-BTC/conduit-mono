import { useState } from "react"
import type { WalletLightningAddressState } from "@conduit/core/wallets/resolve-spark-lightning-address"
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
  value: WalletLightningAddressState | null
  resolve: UseWalletsReturn["getSparkLightningAddress"]
  onChange(value: WalletLightningAddressState): void
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
      {value?.status === "saved" && (
        <p className="break-all">{value.address}</p>
      )}
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
              onChange(
                await resolve(walletId, false, undefined, undefined, {
                  priority: "foreground",
                })
              )
            } catch {
              onChange(
                value?.status === "saved"
                  ? { ...value, availability: "unavailable" }
                  : {
                      status: "unavailable",
                      reason: "provider_unavailable",
                    }
              )
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
