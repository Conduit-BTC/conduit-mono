import { Copy } from "lucide-react"
import { useState } from "react"
import { Button } from "@conduit/ui"

import {
  formatSparkRecoveryBundleForClipboard,
  type SparkRecoveryBundle,
} from "../lib/spark-recovery-bundle"
import { getWalletNetworkLabel } from "../lib/wallet-provider-label"

export function SparkRecoveryBundleDetails({
  mnemonic,
  accountNumber,
  network,
}: SparkRecoveryBundle) {
  const [copyState, setCopyState] = useState<
    | { status: "idle" }
    | { status: "copied" }
    | { status: "error"; message: string }
  >({ status: "idle" })

  const copy = async () => {
    setCopyState({ status: "idle" })
    try {
      await navigator.clipboard.writeText(
        formatSparkRecoveryBundleForClipboard({
          mnemonic,
          accountNumber,
          network,
        })
      )
      setCopyState({ status: "copied" })
    } catch (caught) {
      setCopyState({
        status: "error",
        message: getErrorMessage(
          caught,
          "Could not copy the recovery details."
        ),
      })
    }
  }

  return (
    <>
      <div className="rounded-2xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4">
        <p className="select-all font-mono text-sm leading-7 text-[var(--text-primary)]">
          {mnemonic}
        </p>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          Spark account number: {accountNumber}
        </p>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Spark network: {getWalletNetworkLabel(network)}
        </p>
      </div>
      <Button type="button" variant="outline" onClick={() => void copy()}>
        <Copy className="h-4 w-4" />
        Copy recovery details
      </Button>
      <p className="text-sm leading-5 text-[var(--text-muted)]">
        Your clipboard may be readable by other apps or synced between devices.
        Clear it after saving this backup somewhere private.
      </p>
      {copyState.status === "copied" && (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          Copied. Clear your clipboard after saving the backup.
        </p>
      )}
      {copyState.status === "error" && (
        <p role="alert" className="text-sm text-[var(--text-secondary)]">
          {copyState.message}
        </p>
      )}
    </>
  )
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
