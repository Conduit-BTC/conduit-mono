import { useEffect, useState } from "react"
import {
  PROJECT_TIP_RECIPIENT_PUBKEY,
  type PreparedProjectTip,
} from "../protocol/project-tip"
import { waitForZapReceipt } from "../protocol/lightning"

/** Observe only the exact prepared tip while its invoice is available. */
export function useProjectTipReceipt(
  tip: PreparedProjectTip | null
): string | null {
  const [confirmedRequestId, setConfirmedRequestId] = useState<string | null>(
    null
  )

  useEffect(() => {
    if (!tip || confirmedRequestId === tip.zapRequestId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiresAt = Date.now() + 5 * 60_000
    const check = async () => {
      try {
        const receipt = await waitForZapReceipt({
          zapRequestId: tip.zapRequestId,
          requestCreatedAt: tip.requestCreatedAt,
          recipientPubkey: PROJECT_TIP_RECIPIENT_PUBKEY,
          expectedAmountMsats: tip.amountMsats,
          expectedLnurl: tip.lnurl,
          expectedInvoice: tip.invoice,
          lnurlNostrPubkey: tip.lnurlNostrPubkey,
          relayUrls: tip.relayUrls,
          timeoutMs: 5_000,
        })
        if (active && receipt) {
          setConfirmedRequestId(tip.zapRequestId)
          return
        }
      } catch {
        // A relay read is partial evidence; keep the invoice available.
      }
      if (active && Date.now() < expiresAt) timer = setTimeout(check, 8_000)
    }
    void check()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [tip, confirmedRequestId])

  return tip?.zapRequestId === confirmedRequestId ? confirmedRequestId : null
}
