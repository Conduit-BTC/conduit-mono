import { useState } from "react"
import {
  config,
  getWalletNetworkFromLightningConfig,
  isLightningPaymentPreimageForInvoice,
  isPricingRateQuoteFresh,
  nwcGetInfo,
  nwcPayInvoice,
  prepareProjectTip,
  useAuth,
  useBtcUsdRate,
  useProjectTipReceipt,
  validateLightningInvoiceForPayment,
  type PreparedProjectTip,
} from "@conduit/core"
import { createNdkNostrEventSigner } from "@conduit/core/protocol/ndk-nostr-event-signer"
import { ProjectTip, type ProjectTipPayResult } from "@conduit/ui"
import { useNwcConnection } from "../hooks/useNwcConnection"
import { classifyMerchantTipPaymentError } from "../lib/project-tip-payment"

export function MerchantProjectTip({ className }: { className?: string }) {
  const auth = useAuth()
  const rateQuery = useBtcUsdRate()
  const nwc = useNwcConnection()
  const [receiptTip, setReceiptTip] = useState<PreparedProjectTip | null>(null)
  const confirmedZapRequestId = useProjectTipReceipt(receiptTip)

  async function prepare(amountSats: number): Promise<PreparedProjectTip> {
    if (
      auth.status !== "connected" ||
      !auth.pubkey ||
      !auth.signer ||
      !auth.method ||
      !auth.capabilities.signEvent
    ) {
      throw new Error("Connect your Nostr signer before leaving a tip.")
    }
    return prepareProjectTip({
      amountSats,
      signer: createNdkNostrEventSigner(auth.signer, auth.pubkey, auth.method),
    })
  }

  async function payInvoice(
    tip: PreparedProjectTip
  ): Promise<ProjectTipPayResult> {
    if (!nwc.connection) return { status: "manual" }
    let info: Awaited<ReturnType<typeof nwcGetInfo>>
    try {
      info = await nwcGetInfo(nwc.connection, 10_000, "merchant")
    } catch {
      return {
        status: "manual",
        reason: "Connected wallet unavailable. Use another Lightning wallet.",
      }
    }
    if (
      !info.methods.includes("pay_invoice") ||
      info.network !==
        getWalletNetworkFromLightningConfig(config.lightningNetwork)
    ) {
      return {
        status: "manual",
        reason:
          "Connected wallet is not ready for this Lightning network. Use another wallet.",
      }
    }
    const invoice = validateLightningInvoiceForPayment({
      invoice: tip.invoice,
      expectedAmountMsats: tip.amountMsats,
    })
    if (!invoice.ok) return { status: "manual", reason: invoice.reason }
    try {
      const result = await nwcPayInvoice(
        nwc.connection,
        { invoice: tip.invoice, amountMsats: tip.amountMsats },
        60_000,
        "merchant"
      )
      return isLightningPaymentPreimageForInvoice(tip.invoice, result.preimage)
        ? { status: "paid" }
        : {
            status: "ambiguous",
            reason:
              "The wallet response did not prove payment of this tip. Check the wallet before trying again.",
          }
    } catch (error) {
      return classifyMerchantTipPaymentError(error, nwc.connection)
    }
  }

  return (
    <ProjectTip
      className={className}
      prepare={prepare}
      payInvoice={payInvoice}
      onOpenChange={(next) => {
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
      rateQuote={rateQuery.data ?? null}
      rateIsFetching={rateQuery.isFetching}
      onRefreshRate={() => void rateQuery.refetch()}
    />
  )
}
