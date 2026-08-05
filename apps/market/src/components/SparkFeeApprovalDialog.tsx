import { useCallback, useEffect, useRef, useState } from "react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@conduit/ui"

import type { SparkInvoicePaymentQuote } from "../lib/spark-wallet"

export interface SparkFeeApprovalController {
  quote: SparkInvoicePaymentQuote | null
  requestApproval(quote: SparkInvoicePaymentQuote): Promise<boolean>
  approve(): void
  decline(): void
}

export function useSparkFeeApproval(): SparkFeeApprovalController {
  const [quote, setQuote] = useState<SparkInvoicePaymentQuote | null>(null)
  const resolverRef = useRef<((approved: boolean) => void) | null>(null)
  const focusReturnRef = useRef<HTMLElement | null>(null)

  const settle = useCallback((approved: boolean) => {
    const resolve = resolverRef.current
    const focusTarget = focusReturnRef.current
    resolverRef.current = null
    focusReturnRef.current = null
    setQuote(null)
    resolve?.(approved)
    const restoreFocus = () => {
      if (focusTarget?.isConnected) focusTarget.focus()
    }
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(restoreFocus)
    } else {
      queueMicrotask(restoreFocus)
    }
  }, [])

  const requestApproval = useCallback((nextQuote: SparkInvoicePaymentQuote) => {
    resolverRef.current?.(false)
    focusReturnRef.current =
      typeof document !== "undefined" &&
      typeof HTMLElement !== "undefined" &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setQuote(nextQuote)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  useEffect(
    () => () => {
      resolverRef.current?.(false)
      resolverRef.current = null
      focusReturnRef.current = null
    },
    []
  )

  return {
    quote,
    requestApproval,
    approve: () => settle(true),
    decline: () => settle(false),
  }
}

export function SparkFeeApprovalDialog({
  controller,
  walletLabel,
}: {
  controller: SparkFeeApprovalController
  walletLabel?: string
}) {
  const quote = controller.quote
  return (
    <Dialog
      open={quote !== null}
      onOpenChange={(open) => {
        if (!open) controller.decline()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review maximum Lightning fee</DialogTitle>
          <DialogDescription>
            Spark prepared this Lightning payment. No bitcoin will be sent until
            you confirm. The final fee may be lower than this approved maximum.
          </DialogDescription>
        </DialogHeader>
        {quote && (
          <dl className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm">
            {walletLabel && (
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[var(--text-secondary)]">Wallet</dt>
                <dd className="font-medium text-[var(--text-primary)]">
                  {walletLabel}
                </dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-4">
              <dt className="text-[var(--text-secondary)]">Payment</dt>
              <dd className="font-medium text-[var(--text-primary)]">
                {quote.amountSats.toLocaleString()} sats
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-[var(--text-secondary)]">
                Maximum Lightning fee
              </dt>
              <dd className="font-medium text-[var(--text-primary)]">
                {quote.feeSats.toLocaleString()} sats
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-[var(--border)] pt-3">
              <dt className="font-medium text-[var(--text-primary)]">
                Maximum total
              </dt>
              <dd className="font-semibold text-[var(--text-primary)]">
                {quote.totalSats.toLocaleString()} sats
              </dd>
            </div>
          </dl>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={controller.decline}>
            Cancel
          </Button>
          <Button type="button" onClick={controller.approve}>
            Send payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
