import { useEffect, useRef, useState } from "react"
import {
  config,
  getWalletNetworkFromLightningConfig,
  isPricingRateQuoteFresh,
  isLightningPaymentPreimageForInvoice,
  prepareProjectTip,
  useAuth,
  useBtcUsdRate,
  useProjectTipReceipt,
  validateLightningInvoiceForPayment,
  type PreparedProjectTip,
} from "@conduit/core"
import { createNdkNostrEventSigner } from "@conduit/core/protocol/ndk-nostr-event-signer"
import { ProjectTip, type ProjectTipPayResult } from "@conduit/ui"
import { useWallets } from "../hooks/useWallets"
import { prepareAnonymousProjectTip } from "../lib/project-tip"
import {
  getNwcPaymentReadiness,
  marketWalletPaymentCoordinator,
} from "../lib/wallet-payment-coordinator"

export function MarketProjectTip({ className }: { className?: string }) {
  const auth = useAuth()
  const rateQuery = useBtcUsdRate()
  const [open, setOpen] = useState(false)
  const [receiptTip, setReceiptTip] = useState<PreparedProjectTip | null>(null)
  const confirmedZapRequestId = useProjectTipReceipt(receiptTip)
  const wallets = useWallets({ enabled: open })
  const network = getWalletNetworkFromLightningConfig(config.lightningNetwork)
  const readyNwc = wallets.connectedWallets.filter((wallet) => {
    const snapshot = wallets.nwcSnapshots[wallet.id]
    return (
      wallet.network === network &&
      wallet.capabilities.includes("pay_invoice") &&
      !!snapshot &&
      getNwcPaymentReadiness({
        snapshot,
        walletNetwork: wallet.network,
        configuredNetwork: network,
      }).ready
    )
  })
  const selectedNwc =
    readyNwc.find((wallet) => wallet.defaultIntents.includes("pay_invoice")) ??
    (readyNwc.length === 1 ? readyNwc[0] : null)
  const selectedNwcRef = useRef(selectedNwc)
  useEffect(() => {
    selectedNwcRef.current = selectedNwc
  }, [selectedNwc])

  async function prepare(amountSats: number): Promise<PreparedProjectTip> {
    if (
      auth.status === "connected" &&
      auth.pubkey &&
      auth.signer &&
      auth.method &&
      auth.capabilities.signEvent
    ) {
      return prepareProjectTip({
        amountSats,
        signer: createNdkNostrEventSigner(
          auth.signer,
          auth.pubkey,
          auth.method
        ),
      })
    }
    return prepareAnonymousProjectTip(amountSats)
  }

  async function payInvoice(
    tip: PreparedProjectTip
  ): Promise<ProjectTipPayResult> {
    const paymentWallet = selectedNwcRef.current
    if (!paymentWallet) return { status: "manual" }
    const result = await marketWalletPaymentCoordinator.payInvoice(
      { walletId: paymentWallet.id, providerId: "nwc" },
      {
        invoice: tip.invoice,
        amountMsats: tip.amountMsats,
        idempotencyKey: crypto.randomUUID(),
        timeoutMs: 60_000,
        appId: "market",
        beforeSend: async () => {
          const result = validateLightningInvoiceForPayment({
            invoice: tip.invoice,
            expectedAmountMsats: tip.amountMsats,
          })
          if (!result.ok) throw new Error(result.reason)
        },
      }
    )
    if (result.status === "paid") {
      return isLightningPaymentPreimageForInvoice(tip.invoice, result.preimage)
        ? { status: "paid" }
        : {
            status: "ambiguous",
            reason:
              "The wallet response did not prove payment of this tip. Check the wallet before trying again.",
          }
    }
    if (result.status === "ambiguous") {
      return { status: "ambiguous", reason: result.reason }
    }
    return { status: "manual", reason: result.reason }
  }

  return (
    <ProjectTip
      className={className}
      prepare={prepare}
      payInvoice={payInvoice}
      onOpenChange={(next) => {
        setOpen(next)
        if (
          next &&
          !rateQuery.isFetching &&
          !isPricingRateQuoteFresh(rateQuery.data)
        ) {
          void rateQuery.refetch()
        }
      }}
      onReceiptWatchChange={setReceiptTip}
      confirmedZapRequestId={confirmedZapRequestId}
      anonymous={auth.status !== "connected" || !auth.capabilities.signEvent}
      rateQuote={rateQuery.data ?? null}
      rateIsFetching={rateQuery.isFetching}
      onRefreshRate={() => void rateQuery.refetch()}
    />
  )
}
