import { Check, Copy, ExternalLink, Zap } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  config,
  getProductSupportZapDisclosure,
  normalizeLightningInvoice,
  prepareProductSupportZapInvoice,
  PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS,
  useAuth,
} from "@conduit/core"
import { createNdkNostrEventSigner } from "@conduit/core/protocol/ndk-nostr-event-signer"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  QRCodeSVG,
  Textarea,
} from "@conduit/ui"

type ProductSupportZapProps = {
  productAddress: string
  productTitle: string
  merchantPubkey: string
  merchantName: string
  lud16?: string | null
}

function limitNoteInput(value: string): string {
  return Array.from(value)
    .slice(0, PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS)
    .join("")
}

export function ProductSupportZap({
  productAddress,
  productTitle,
  merchantPubkey,
  merchantName,
  lud16,
}: ProductSupportZapProps) {
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const [amountInput, setAmountInput] = useState("21")
  const [note, setNote] = useState("")
  const [invoice, setInvoice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [copied, setCopied] = useState(false)
  const noteLength = Array.from(note).length
  const disclosure = getProductSupportZapDisclosure({ note })
  const lightningAddress = lud16?.trim() ?? ""
  const signerReady =
    auth.status === "connected" &&
    !!auth.pubkey &&
    !!auth.signer &&
    !!auth.method &&
    auth.capabilities.signEvent
  const currentTargetRef = useRef({
    shopperPubkey: auth.pubkey,
    signer: auth.signer,
    authMethod: auth.method,
    merchantPubkey,
    productAddress,
    lightningAddress,
  })
  const preparationSequenceRef = useRef(0)
  currentTargetRef.current = {
    shopperPubkey: auth.pubkey,
    signer: auth.signer,
    authMethod: auth.method,
    merchantPubkey,
    productAddress,
    lightningAddress,
  }

  function closeDialog() {
    preparationSequenceRef.current += 1
    setPreparing(false)
    setInvoice(null)
    setError(null)
    setCopied(false)
    setOpen(false)
  }

  useEffect(() => {
    preparationSequenceRef.current += 1
    setPreparing(false)
    setInvoice(null)
    setError(null)
    setCopied(false)
  }, [
    auth.method,
    auth.pubkey,
    auth.signer,
    lightningAddress,
    merchantPubkey,
    productAddress,
  ])

  if (!lightningAddress) return null

  async function connectSigner() {
    setError(null)
    try {
      await auth.connect()
    } catch {
      setError("The Nostr signer could not connect. Unlock it and try again.")
    }
  }

  async function prepareInvoice() {
    if (!signerReady || !auth.pubkey || !auth.signer || !auth.method) {
      setError("Connect a Nostr signer before creating a public support zap.")
      return
    }

    const amountSats = Number(amountInput)
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      setError("Enter a positive whole number of sats.")
      return
    }

    const shopperPubkey = auth.pubkey
    const signer = auth.signer
    const authMethod = auth.method
    const selectedMerchantPubkey = merchantPubkey
    const selectedProductAddress = productAddress
    const selectedLightningAddress = lightningAddress
    const preparationSequence = preparationSequenceRef.current + 1
    preparationSequenceRef.current = preparationSequence
    const isCurrent = () => {
      const current = currentTargetRef.current
      return (
        preparationSequenceRef.current === preparationSequence &&
        current.shopperPubkey === shopperPubkey &&
        current.signer === signer &&
        current.authMethod === authMethod &&
        current.merchantPubkey === selectedMerchantPubkey &&
        current.productAddress === selectedProductAddress &&
        current.lightningAddress === selectedLightningAddress
      )
    }

    setPreparing(true)
    setError(null)
    setInvoice(null)
    setCopied(false)
    try {
      const preparedInvoice = await prepareProductSupportZapInvoice({
        signer: createNdkNostrEventSigner(signer, shopperPubkey, authMethod),
        shopperPubkey,
        recipientPubkey: selectedMerchantPubkey,
        productAddress: selectedProductAddress,
        amountSats,
        note,
        relayUrls: config.zapRelayUrls,
        isCurrent: isCurrent,
      })
      if (isCurrent()) setInvoice(preparedInvoice)
    } catch (cause) {
      if (isCurrent()) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The support invoice could not be prepared."
        )
      }
    } finally {
      if (isCurrent()) setPreparing(false)
    }
  }

  async function copyInvoice() {
    if (!invoice) return
    try {
      await navigator.clipboard.writeText(invoice)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
      setError("The invoice could not be copied from this browser.")
    }
  }

  const bolt11 = invoice ? normalizeLightningInvoice(invoice) : null

  return (
    <>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
        <div className="flex items-start gap-3">
          <Zap className="mt-0.5 size-4 shrink-0 text-secondary-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--text-primary)]">
              Support this product
            </div>
            <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
              Send a public Lightning zap to {merchantName}. This is separate
              from buying the product and never changes cart or order status.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              onClick={() => setOpen(true)}
            >
              <Zap className="size-4" />
              Support product
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setOpen(true)
            return
          }
          closeDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Support {productTitle}</DialogTitle>
            <DialogDescription>
              Create a public Lightning zap linked to this product. An optional
              note is public on Nostr. No purchase or order is created.
            </DialogDescription>
          </DialogHeader>

          {!signerReady ? (
            <div className="space-y-4">
              <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm leading-6 text-[var(--text-secondary)]">
                Connect your Nostr signer so the product support request is
                publicly attributed to you.
              </p>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  onClick={() => void connectSigner()}
                  disabled={
                    auth.status === "connecting" || auth.status === "restoring"
                  }
                >
                  {auth.status === "connecting" || auth.status === "restoring"
                    ? "Connecting…"
                    : "Connect signer"}
                </Button>
              </DialogFooter>
            </div>
          ) : bolt11 ? (
            <div className="space-y-4">
              <div
                role="status"
                className="flex items-start gap-2 rounded-xl border border-[var(--success)]/35 bg-[color-mix(in_srgb,var(--success)_10%,transparent)] p-3 text-sm text-[var(--text-primary)]"
              >
                <Check className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
                <span>
                  Invoice ready. Conduit has not sent or confirmed a payment.
                </span>
              </div>
              <div className="flex flex-col items-start gap-4 sm:flex-row">
                <div className="rounded-xl bg-white p-3">
                  <QRCodeSVG value={bolt11} size={156} level="M" />
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Button asChild>
                      <a href={`lightning:${bolt11}`}>
                        <ExternalLink className="size-4" />
                        Open in wallet
                      </a>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void copyInvoice()}
                    >
                      {copied ? (
                        <Check className="size-4" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                      {copied ? "Copied" : "Copy invoice"}
                    </Button>
                  </div>
                  <div className="max-h-24 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs leading-5 break-all text-[var(--text-secondary)]">
                    {invoice}
                  </div>
                </div>
              </div>
              <p className="text-xs leading-5 text-[var(--text-secondary)]">
                If you pay, the recipient wallet may publish the matching public
                receipt to the requested relays. This dialog does not monitor or
                claim settlement.
              </p>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setInvoice(null)}
                >
                  Create another invoice
                </Button>
                <Button type="button" onClick={closeDialog}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                void prepareInvoice()
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="product-support-amount">Amount (sats)</Label>
                <Input
                  id="product-support-amount"
                  inputMode="numeric"
                  autoComplete="off"
                  value={amountInput}
                  onChange={(event) => setAmountInput(event.target.value)}
                  disabled={preparing}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="product-support-note">
                    Public note (optional)
                  </Label>
                  <span className="text-xs text-[var(--text-muted)]">
                    {noteLength}/{PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS}
                  </span>
                </div>
                <Textarea
                  id="product-support-note"
                  value={note}
                  onChange={(event) =>
                    setNote(limitNoteInput(event.target.value))
                  }
                  placeholder="Say something public about this product"
                  disabled={preparing}
                />
                <p className="text-xs leading-5 text-[var(--text-secondary)]">
                  {disclosure.preSubmitCopy}
                </p>
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button type="submit" disabled={preparing}>
                  {preparing ? "Preparing invoice…" : "Create zap invoice"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
