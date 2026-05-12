import {
  Check,
  KeyRound,
  LoaderCircle,
  ShoppingCart,
  Store,
  Zap,
} from "lucide-react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { NDKEvent, NDKUser, giftWrap } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  formatPubkey,
  getNdk,
  getShippingOptions,
  isBuyerCountryEligible,
  isInvoiceCompatibleWithCurrentNetwork,
  nwcPayInvoice,
  useAuth,
  useProfile,
  type ShippingAddressSchema,
} from "@conduit/core"
import { Button, Input, Label } from "@conduit/ui"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { type CartItem, useCart } from "../hooks/useCart"
import { useWallet } from "../hooks/useWallet"
import { requireAuth } from "../lib/auth"
import {
  isFastCheckoutEligible,
  getValidationErrorFields,
  shippingFieldLabel,
  validateShippingFields,
  type ShippingFormState,
  type ShippingFieldKey,
  type ShippingValidationError,
} from "../lib/checkout-validation"
import { getProductPriceDisplay } from "../lib/pricing"

type CheckoutStep =
  | "shipping"
  | "payment"
  | "signing"
  | "sending"
  | "sent"
  | "paying"
  | "paid"

type CheckoutSearch = {
  merchant?: string
}

// Shipping is session-scoped: pre-fills within a browser session, never
// persisted permanently to localStorage.
const CHECKOUT_STORAGE_KEY = "conduit:checkout-shipping"

const DEFAULT_SHIPPING_FORM: ShippingFormState = {
  firstName: "",
  lastName: "",
  street: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
  name: "",
  phone: "",
  email: "",
}

// ─── Session storage ──────────────────────────────────────────────────────────

function readSessionShipping(): ShippingFormState {
  if (typeof window === "undefined") return DEFAULT_SHIPPING_FORM
  try {
    const raw = sessionStorage.getItem(CHECKOUT_STORAGE_KEY)
    if (!raw) return DEFAULT_SHIPPING_FORM
    return {
      ...DEFAULT_SHIPPING_FORM,
      ...(JSON.parse(raw) as Partial<ShippingFormState>),
    }
  } catch {
    return DEFAULT_SHIPPING_FORM
  }
}

function writeSessionShipping(value: ShippingFormState): void {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // ignore
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/checkout")({
  beforeLoad: () => {
    requireAuth()
  },
  validateSearch: (search: Record<string, unknown>): CheckoutSearch => ({
    merchant: typeof search.merchant === "string" ? search.merchant : undefined,
  }),
  component: CheckoutPage,
})

// ─── Small presentational helpers ────────────────────────────────────────────

function CartIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <ShoppingCart className={className} />
}

function LightningIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Zap className={className} />
}

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Check className={className} />
}

function SpinnerIcon({ className = "h-5 w-5" }: { className?: string }) {
  return <LoaderCircle className={className} />
}

function PaymentMethodButton({
  label,
  icon,
  active = false,
  disabled = false,
  subtitle,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  active?: boolean
  disabled?: boolean
  subtitle?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors",
        active
          ? "border-secondary-400 bg-secondary-500/12 text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]"
          : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)] hover:border-[var(--text-secondary)]",
        disabled ? "cursor-not-allowed opacity-70" : "",
      ].join(" ")}
    >
      {icon}
      {label}
      {subtitle && (
        <span
          className={
            active ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]"
          }
        >
          {subtitle}
        </span>
      )}
    </button>
  )
}

// ─── Order summary sidebar ────────────────────────────────────────────────────

function OrderSummary({
  items,
  merchantPubkey,
  step,
  btcUsdRate,
}: {
  items: CartItem[]
  merchantPubkey: string
  step: Exclude<
    CheckoutStep,
    "signing" | "sending" | "sent" | "paying" | "paid"
  >
  btcUsdRate: number | null
}) {
  const { data: merchantProfile } = useProfile(merchantPubkey)
  const merchantName =
    merchantProfile?.displayName ||
    merchantProfile?.name ||
    formatPubkey(merchantPubkey, 8)
  const totalPrice = getProductPriceDisplay(
    {
      price: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
      currency: items[0]?.currency ?? "USD",
    },
    btcUsdRate
  )

  return (
    <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] pb-4">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]">
            Order summary
          </h2>
          <div className="mt-1 text-sm text-[var(--text-secondary)]">
            {step === "shipping" ? "Shipping" : "Payment method"}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-[var(--text-secondary)]">Merchant</div>
          <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">
            {merchantName}
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {items.map((item) => {
          const linePrice = getProductPriceDisplay(
            { price: item.price * item.quantity, currency: item.currency },
            btcUsdRate
          )
          return (
            <div
              key={item.productId}
              className="grid grid-cols-[72px_minmax(0,1fr)_auto] gap-3 border-b border-[var(--border)] pb-4 last:border-b-0 last:pb-0"
            >
              <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]">
                <img
                  src={item.image ?? "/images/placeholders/product.png"}
                  alt={item.title}
                  className="aspect-square h-full w-full object-cover"
                  loading="lazy"
                  onError={(e) => {
                    ;(e.currentTarget as HTMLImageElement).src =
                      "/images/placeholders/product.png"
                  }}
                />
              </div>
              <div className="min-w-0">
                <div className="line-clamp-2 text-base font-medium leading-7 text-[var(--text-primary)]">
                  {item.title}
                </div>
                {item.tags && item.tags.length > 0 && (
                  <div className="mt-1 line-clamp-1 text-xs text-[var(--text-muted)]">
                    {item.tags.slice(0, 4).join(", ")}
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  {linePrice.primary}
                </div>
                <div className="mt-2 text-sm text-[var(--text-secondary)]">
                  Qty {item.quantity}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
        <div className="flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)]">
          <span>
            Subtotal ({items.reduce((sum, item) => sum + item.quantity, 0)} item
            {items.reduce((sum, item) => sum + item.quantity, 0) === 1
              ? ""
              : "s"}
            )
          </span>
          <span>{totalPrice.primary}</span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)]">
          <span>Shipping</span>
          <span>Coordinated with merchant</span>
        </div>
        <div className="mt-5 flex items-end justify-between gap-3">
          <div className="text-lg font-semibold text-[var(--text-primary)]">
            Due to merchant
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold text-secondary-400">
              {totalPrice.primary}
            </div>
            {totalPrice.secondary && (
              <div className="mt-1 text-sm text-[var(--text-muted)]">
                {totalPrice.secondary}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

// ─── Fast checkout eligibility ────────────────────────────────────────────────

/**
 * Returns true when all preconditions for the fast zap path are met:
 *   - buyer has a pay-capable NWC wallet
 *   - merchant profile has a lud16 address
 *   - the LNURL endpoint declares allowsNostr (zap support)
 *
 * The `lnurlAllowsNostr` flag must be resolved ahead of time (async probe).
 */
// ─── Checkout page ────────────────────────────────────────────────────────────

function CheckoutPage() {
  const { pubkey } = useAuth()
  const cart = useCart()
  const search = Route.useSearch()
  const btcUsdRateQuery = useBtcUsdRate()
  const wallet = useWallet()

  const [step, setStep] = useState<CheckoutStep>("shipping")
  const [shipping, setShipping] = useState<ShippingFormState>(() =>
    readSessionShipping()
  )
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [shippingAttempted, setShippingAttempted] = useState(false)
  const [shippingErrors, setShippingErrors] = useState<
    ShippingValidationError[]
  >([])
  const [sentOrderId, setSentOrderId] = useState<string | null>(null)
  const [showSentGlow, setShowSentGlow] = useState(false)

  // LNURL probe state
  const [lnurlAllowsNostr, setLnurlAllowsNostr] = useState(false)
  const [lnurlProbing, setLnurlProbing] = useState(false)

  const selectedMerchant =
    search.merchant ??
    (Array.from(new Set(cart.items.map((item) => item.merchantPubkey)))
      .length === 1
      ? cart.items[0]?.merchantPubkey
      : undefined)

  const checkoutItems = useMemo(() => {
    if (!selectedMerchant) return []
    return cart.items.filter((item) => item.merchantPubkey === selectedMerchant)
  }, [cart.items, selectedMerchant])

  // True when every item in the cart is a digital product (no shipping needed)
  const isAllDigital = useMemo(
    () =>
      checkoutItems.length > 0 &&
      checkoutItems.every((item) => item.format === "digital"),
    [checkoutItems]
  )

  // Fetch merchant's published shipping zones (kind-30406)
  const { data: merchantShippingOptions = [] } = useQuery({
    queryKey: ["shippingOptions", selectedMerchant],
    queryFn: () => getShippingOptions(selectedMerchant!),
    enabled: !!selectedMerchant && !isAllDigital,
    staleTime: 5 * 60 * 1000,
  })

  const total = useMemo(
    () =>
      checkoutItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [checkoutItems]
  )

  const currency = checkoutItems[0]?.currency ?? "USD"

  const { data: merchantProfile } = useProfile(selectedMerchant ?? null)
  const merchantLud16 = merchantProfile?.lud16

  // Probe merchant's LNURL for Nostr zap support when merchant profile arrives
  useEffect(() => {
    if (!merchantLud16 || wallet.status !== "pay-capable") return

    let cancelled = false
    setLnurlProbing(true)

    fetchLnurlPayMetadata(merchantLud16)
      .then((meta) => {
        if (!cancelled) setLnurlAllowsNostr(meta.allowsNostr)
      })
      .catch(() => {
        if (!cancelled) setLnurlAllowsNostr(false)
      })
      .finally(() => {
        if (!cancelled) setLnurlProbing(false)
      })

    return () => {
      cancelled = true
    }
  }, [merchantLud16, wallet.status])

  const fastEligible = isFastCheckoutEligible({
    walletPayCapable: wallet.status === "pay-capable",
    merchantLud16,
    lnurlAllowsNostr,
  })

  const summaryStep: Exclude<
    CheckoutStep,
    "signing" | "sending" | "sent" | "paying" | "paid"
  > = step === "payment" ? "payment" : "shipping"

  function updateShipping<K extends keyof ShippingFormState>(
    field: K,
    value: ShippingFormState[K]
  ): void {
    setShipping((current) => {
      const next = { ...current, [field]: value }
      writeSessionShipping(next)
      return next
    })
    // Re-validate on field change if an attempt has been made
    if (shippingAttempted) {
      setShippingErrors(validateShippingFields({ ...shipping, [field]: value }))
    }
  }

  function continueToPayment(): void {
    setShippingAttempted(true)
    const errors = validateShippingFields(shipping)
    setShippingErrors(errors)
    if (errors.length > 0) {
      setError("Fix the highlighted fields to continue.")
      return
    }
    // Validate buyer country against merchant's published shipping zones
    if (
      merchantShippingOptions.length > 0 &&
      !isBuyerCountryEligible(shipping.country, merchantShippingOptions)
    ) {
      setError(
        `This merchant doesn't ship to ${shipping.country}. Please check the country code or contact the merchant.`
      )
      return
    }
    setError(null)
    setStep("payment")
  }

  useEffect(() => {
    if (!showSentGlow) return
    const id = window.setTimeout(() => setShowSentGlow(false), 650)
    return () => window.clearTimeout(id)
  }, [showSentGlow])

  // Clear inline error when all validation errors are resolved
  useEffect(() => {
    if (
      shippingAttempted &&
      shippingErrors.length === 0 &&
      error === "Fix the highlighted fields to continue."
    ) {
      setError(null)
    }
  }, [error, shippingAttempted, shippingErrors.length])

  // Skip shipping step for all-digital carts
  useEffect(() => {
    if (isAllDigital && step === "shipping") {
      setStep("payment")
    }
  }, [isAllDigital, step])

  // ─── Build shipping address from form state ──────────────────────────────

  function buildShippingAddress(): ShippingAddressSchema | undefined {
    if (isAllDigital) return undefined
    return {
      name: `${shipping.firstName.trim()} ${shipping.lastName.trim()}`.trim(),
      street: [shipping.street.trim(), shipping.line2.trim()]
        .filter(Boolean)
        .join(", "),
      city: shipping.city.trim(),
      state: (shipping.state ?? "").trim() || undefined,
      postalCode: shipping.postalCode.trim(),
      country: shipping.country.trim().toUpperCase(),
    }
  }

  function buildContactNote(): string | undefined {
    const lines = [
      note.trim() || undefined,
      shipping.phone.trim() ? `Phone: ${shipping.phone.trim()}` : undefined,
      shipping.email.trim() ? `Email: ${shipping.email.trim()}` : undefined,
    ].filter(Boolean) as string[]
    return lines.length > 0 ? lines.join("\n") : undefined
  }

  // ─── Order-first path (existing flow) ───────────────────────────────────

  async function placeOrder(): Promise<void> {
    if (!pubkey || !selectedMerchant || checkoutItems.length === 0) return

    setError(null)
    setStep("signing")

    try {
      const orderId = crypto.randomUUID()
      const items = checkoutItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        priceAtPurchase: item.price,
        currency: item.currency,
      }))

      const payload = {
        id: orderId,
        merchantPubkey: selectedMerchant,
        buyerPubkey: pubkey,
        items,
        subtotal: total,
        currency,
        shippingAddress: buildShippingAddress(),
        note: buildContactNote(),
        createdAt: Date.now(),
      }

      const ndk = getNdk()
      const rumor = new NDKEvent(ndk)
      rumor.kind = EVENT_KINDS.ORDER
      rumor.created_at = Math.floor(Date.now() / 1000)
      rumor.tags = [
        ["p", selectedMerchant],
        ["type", "order"],
        ["order", orderId],
      ]
      rumor.tags = appendConduitClientTag(rumor.tags, "market")
      rumor.content = JSON.stringify(payload)

      const merchantUser = new NDKUser({ pubkey: selectedMerchant })
      const wrappedToMerchant = await giftWrap(
        rumor,
        merchantUser,
        ndk.signer,
        {
          rumorKind: EVENT_KINDS.ORDER,
        }
      )

      const buyerUser = new NDKUser({ pubkey })
      const wrappedToSelf = await giftWrap(rumor, buyerUser, ndk.signer, {
        rumorKind: EVENT_KINDS.ORDER,
      })

      setStep("sending")

      await Promise.all([
        wrappedToMerchant.publish(),
        wrappedToSelf.publish(),
        new Promise((resolve) => window.setTimeout(resolve, 900)),
      ])

      cart.clearMerchant(selectedMerchant)
      setSentOrderId(orderId)
      setShowSentGlow(true)
      setStep("sent")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send order")
      setStep("payment")
    }
  }

  // ─── Fast zap path ───────────────────────────────────────────────────────

  async function payNow(): Promise<void> {
    if (!pubkey || !selectedMerchant || checkoutItems.length === 0) return
    if (!wallet.connection) {
      setError("Wallet not connected.")
      return
    }
    if (!merchantLud16) {
      setError("Merchant does not have a Lightning address.")
      return
    }

    setError(null)
    setStep("paying")

    try {
      // 1. Fetch merchant LNURL metadata
      const lnurlMeta = await fetchLnurlPayMetadata(merchantLud16)

      // 2. Convert order total to msats
      const btcUsdRate = btcUsdRateQuery.data?.rate ?? null
      let amountMsats: number
      if (currency.toUpperCase() === "SATS") {
        amountMsats = Math.round(total * 1000)
      } else if (currency.toUpperCase() === "USD" && btcUsdRate) {
        const sats = Math.round((total / btcUsdRate) * 100_000_000)
        amountMsats = sats * 1000
      } else {
        throw new Error(
          `Cannot convert ${currency} amount to msats without a BTC/USD rate.`
        )
      }

      if (
        amountMsats < lnurlMeta.minSendable ||
        amountMsats > lnurlMeta.maxSendable
      ) {
        throw new Error(
          `Order amount (${amountMsats} msats) is outside merchant's accepted range ` +
            `(${lnurlMeta.minSendable}-${lnurlMeta.maxSendable} msats).`
        )
      }

      const orderId = crypto.randomUUID()

      // 3. Build and sign the NIP-57 zap request (kind 9734)
      const ndk = getNdk()
      const zapRequest = new NDKEvent(ndk)
      zapRequest.kind = 9734
      zapRequest.created_at = Math.floor(Date.now() / 1000)
      zapRequest.content = note.trim() || "Conduit order payment"
      zapRequest.tags = [
        ["p", selectedMerchant],
        ["amount", String(amountMsats)],
        ["lnurl", lnurlMeta.callback],
        ["relays", ...(ndk.explicitRelayUrls ?? [])],
        ["order", orderId],
      ]
      zapRequest.tags = appendConduitClientTag(zapRequest.tags, "market")

      // Sign without publishing
      await zapRequest.sign(ndk.signer)
      const zapRequestJson = JSON.stringify(zapRequest.rawEvent())

      // 4. Fetch BOLT11 invoice from merchant's LNURL callback
      const { invoice } = await fetchZapInvoice(
        lnurlMeta.callback,
        amountMsats,
        zapRequestJson
      )

      // 5. Validate the invoice is for the right network
      if (!isInvoiceCompatibleWithCurrentNetwork(invoice)) {
        throw new Error(
          "The invoice returned by the merchant is for a different Lightning network."
        )
      }

      // 6. Pay the invoice via NWC
      const payResult = await nwcPayInvoice(
        wallet.connection,
        { invoice, amountMsats },
        60_000,
        "market"
      )

      // 7. Send order message (so merchant has shipping info)
      const orderPayload = {
        id: orderId,
        merchantPubkey: selectedMerchant,
        buyerPubkey: pubkey,
        items: checkoutItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          priceAtPurchase: item.price,
          currency: item.currency,
        })),
        subtotal: total,
        currency,
        shippingAddress: buildShippingAddress(),
        note: buildContactNote(),
        createdAt: Date.now(),
      }

      const orderRumor = new NDKEvent(ndk)
      orderRumor.kind = EVENT_KINDS.ORDER
      orderRumor.created_at = Math.floor(Date.now() / 1000)
      orderRumor.tags = [
        ["p", selectedMerchant],
        ["type", "order"],
        ["order", orderId],
      ]
      orderRumor.tags = appendConduitClientTag(orderRumor.tags, "market")
      orderRumor.content = JSON.stringify(orderPayload)

      // 8. Send payment proof message
      const proofPayload = {
        invoice,
        preimage: payResult.preimage,
        paymentHash: payResult.paymentHash,
        feeMsats: payResult.feeMsats,
        note: `Payment for order ${orderId}`,
      }

      const proofRumor = new NDKEvent(ndk)
      proofRumor.kind = EVENT_KINDS.ORDER
      proofRumor.created_at = Math.floor(Date.now() / 1000)
      proofRumor.tags = [
        ["p", selectedMerchant],
        ["type", "payment_proof"],
        ["order", orderId],
      ]
      proofRumor.tags = appendConduitClientTag(proofRumor.tags, "market")
      proofRumor.content = JSON.stringify(proofPayload)

      const merchantUser = new NDKUser({ pubkey: selectedMerchant })
      const buyerUser = new NDKUser({ pubkey })

      const [orderToMerchant, orderToSelf, proofToMerchant, proofToSelf] =
        await Promise.all([
          giftWrap(orderRumor, merchantUser, ndk.signer, {
            rumorKind: EVENT_KINDS.ORDER,
          }),
          giftWrap(orderRumor, buyerUser, ndk.signer, {
            rumorKind: EVENT_KINDS.ORDER,
          }),
          giftWrap(proofRumor, merchantUser, ndk.signer, {
            rumorKind: EVENT_KINDS.ORDER,
          }),
          giftWrap(proofRumor, buyerUser, ndk.signer, {
            rumorKind: EVENT_KINDS.ORDER,
          }),
        ])

      await Promise.all([
        orderToMerchant.publish(),
        orderToSelf.publish(),
        proofToMerchant.publish(),
        proofToSelf.publish(),
        new Promise((resolve) => window.setTimeout(resolve, 600)),
      ])

      cart.clearMerchant(selectedMerchant)
      setSentOrderId(orderId)
      setShowSentGlow(true)
      setStep("paid")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed")
      setStep("payment")
    }
  }

  // ─── Full-screen transition states ──────────────────────────────────────

  if (step === "paying") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="w-full max-w-3xl rounded-[2rem] bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--secondary-500)_35%,transparent),transparent_55%),linear-gradient(180deg,var(--primary-500),var(--primary-600))] px-8 py-14 text-center text-white shadow-[0_24px_60px_color-mix(in_srgb,var(--primary-500)_40%,transparent)] sm:px-12">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text-inverse)_20%,transparent)] bg-[color-mix(in_srgb,var(--text-inverse)_10%,transparent)]">
            <SpinnerIcon className="h-8 w-8 animate-spin" />
          </div>
          <h1 className="mt-8 text-4xl font-semibold tracking-tight">
            Paying...
          </h1>
          <div className="mx-auto mt-8 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-black/15">
            <div className="h-full w-2/3 animate-pulse rounded-full bg-white" />
          </div>
          <p className="mx-auto mt-8 max-w-md text-sm leading-7 text-white/85">
            Authorising your Lightning payment and sending the order to the
            merchant. This usually takes a few seconds.
          </p>
        </section>
      </div>
    )
  }

  if (step === "sending") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="w-full max-w-3xl rounded-[2rem] bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--tertiary-500)_35%,transparent),transparent_55%),linear-gradient(180deg,var(--primary-500),var(--primary-600))] px-8 py-14 text-center text-white shadow-[0_24px_60px_color-mix(in_srgb,var(--primary-500)_40%,transparent)] sm:px-12">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text-inverse)_20%,transparent)] bg-[color-mix(in_srgb,var(--text-inverse)_10%,transparent)]">
            <SpinnerIcon className="h-8 w-8 animate-spin" />
          </div>
          <h1 className="mt-8 text-4xl font-semibold tracking-tight">
            Sending your order...
          </h1>
          <div className="mx-auto mt-8 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-black/15">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-white" />
          </div>
          <p className="mx-auto mt-8 max-w-md text-sm leading-7 text-white/85">
            Your order is being delivered to the merchant through Nostr. This
            may take a few seconds depending on your signer and relay
            connection.
          </p>
        </section>
      </div>
    )
  }

  if (step === "signing") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="w-full max-w-3xl rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] px-8 py-14 text-center shadow-[var(--shadow-xl)] sm:px-12">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-secondary-500/30 bg-secondary-500/10 text-secondary-300">
            <KeyRound className="h-8 w-8" />
          </div>
          <h1 className="mt-8 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Awaiting signature...
          </h1>
          <div className="mx-auto mt-8 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-[var(--surface-elevated)]">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-secondary-400" />
          </div>
          <p className="mx-auto mt-8 max-w-md text-sm leading-7 text-[var(--text-secondary)]">
            Confirm this order in your signer to continue. Once the signature is
            approved, Conduit will send the order request to the merchant.
          </p>
        </section>
      </div>
    )
  }

  if (step === "paid") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="relative w-full max-w-3xl overflow-hidden rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] px-8 py-14 text-center sm:px-12">
          <div
            aria-hidden="true"
            className={[
              "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--secondary-500)_35%,transparent),transparent_55%),linear-gradient(180deg,color-mix(in_srgb,var(--primary-500)_22%,transparent),color-mix(in_srgb,var(--primary-600)_18%,transparent))] transition-opacity duration-700",
              showSentGlow ? "opacity-100" : "opacity-0",
            ].join(" ")}
          />
          <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-secondary-500/30 bg-secondary-500/10 text-secondary-300">
            <CheckIcon className="h-8 w-8" />
          </div>
          <h1 className="relative mt-8 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Payment sent
          </h1>
          <div className="relative mx-auto mt-8 h-1 w-full max-w-sm rounded-full bg-secondary-500/50" />
          <p className="relative mx-auto mt-8 max-w-xl text-lg leading-9 text-[var(--text-primary)]">
            Your Lightning payment was sent and the order has been delivered to
            the merchant.
          </p>
          <p className="relative mx-auto mt-4 max-w-lg text-sm leading-7 text-[var(--text-secondary)]">
            The merchant will confirm receipt and send fulfillment updates
            through your Nostr messages.
          </p>
          {sentOrderId && (
            <div className="relative mt-6 text-xs font-mono text-[var(--text-muted)]">
              {sentOrderId}
            </div>
          )}
          <div className="relative mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild variant="outline" className="h-11 px-5 text-sm">
              <Link to="/cart">
                <CartIcon className="h-4 w-4" />
                Back to cart
              </Link>
            </Button>
            <Button asChild className="h-11 px-5 text-sm">
              <Link to="/products">
                <Store className="h-4 w-4" />
                Browse more products
              </Link>
            </Button>
          </div>
        </section>
      </div>
    )
  }

  if (step === "sent") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="relative w-full max-w-3xl overflow-hidden rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] px-8 py-14 text-center sm:px-12">
          <div
            aria-hidden="true"
            className={[
              "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--tertiary-500)_35%,transparent),transparent_55%),linear-gradient(180deg,color-mix(in_srgb,var(--primary-500)_22%,transparent),color-mix(in_srgb,var(--primary-600)_18%,transparent))] transition-opacity duration-700",
              showSentGlow ? "opacity-100" : "opacity-0",
            ].join(" ")}
          />
          <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-secondary-500/30 bg-secondary-500/10 text-secondary-300">
            <CheckIcon className="h-8 w-8" />
          </div>
          <h1 className="relative mt-8 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Order request submitted
          </h1>
          <div className="relative mx-auto mt-8 h-1 w-full max-w-sm rounded-full bg-secondary-500/50" />
          <p className="relative mx-auto mt-8 max-w-xl text-lg leading-9 text-[var(--text-primary)]">
            Your order request has been sent to the merchant. They will review
            it and follow up with confirmation and payment details.
          </p>
          <p className="relative mx-auto mt-4 max-w-lg text-sm leading-7 text-[var(--text-secondary)]">
            You can return to your cart, keep browsing products, or check back
            later for the merchant response.
          </p>
          {sentOrderId && (
            <div className="relative mt-6 text-xs font-mono text-[var(--text-muted)]">
              {sentOrderId}
            </div>
          )}
          <div className="relative mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild variant="outline" className="h-11 px-5 text-sm">
              <Link to="/cart">
                <CartIcon className="h-4 w-4" />
                Back to cart
              </Link>
            </Button>
            <Button asChild className="h-11 px-5 text-sm">
              <Link to="/products">
                <Store className="h-4 w-4" />
                Browse more products
              </Link>
            </Button>
          </div>
        </section>
      </div>
    )
  }

  // ─── Empty / multi-merchant guards ──────────────────────────────────────

  if (!selectedMerchant && cart.items.length > 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Link
            to="/cart"
            className="transition-colors hover:text-[var(--text-primary)]"
          >
            Cart
          </Link>
          <span>/</span>
          <span className="text-[var(--text-primary)]">Checkout</span>
        </div>
        <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 sm:p-10">
          <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Choose a cart before checkout
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            Checkout continues one store at a time. Head back to your cart and
            pick the store you want to review first.
          </p>
          <div className="mt-6">
            <Button asChild className="h-11 px-4 text-sm">
              <Link to="/cart">
                <CartIcon className="h-4 w-4" />
                Back to cart
              </Link>
            </Button>
          </div>
        </section>
      </div>
    )
  }

  if (checkoutItems.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Link
            to="/cart"
            className="transition-colors hover:text-[var(--text-primary)]"
          >
            Cart
          </Link>
          <span>/</span>
          <span className="text-[var(--text-primary)]">Checkout</span>
        </div>
        <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 sm:p-10">
          <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Nothing to check out
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            This cart is empty now. Head back to the marketplace and add
            products before starting checkout again.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild className="h-11 px-4 text-sm">
              <Link to="/products">Continue shopping</Link>
            </Button>
            <Button asChild variant="outline" className="h-11 px-4 text-sm">
              <Link to="/cart">Back to cart</Link>
            </Button>
          </div>
        </section>
      </div>
    )
  }

  // ─── Field-level error helpers ───────────────────────────────────────────

  const errorFields = getValidationErrorFields(shippingErrors)

  function fieldError(field: ShippingFieldKey): string | undefined {
    return shippingErrors.find((e) => e.field === field)?.message
  }

  function fieldInvalid(field: ShippingFieldKey): boolean {
    return shippingAttempted && errorFields.includes(field)
  }

  function fieldClassName(field: ShippingFieldKey): string | undefined {
    return fieldInvalid(field)
      ? "border-error/50 focus:border-error focus:ring-error/30"
      : undefined
  }

  // ─── Main checkout form ──────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Link
          to="/cart"
          className="transition-colors hover:text-[var(--text-primary)]"
        >
          Cart
        </Link>
        <span>/</span>
        <span
          className={step === "shipping" ? "text-[var(--text-primary)]" : ""}
        >
          Shipping
        </span>
        <span>/</span>
        <span
          className={
            step === "payment"
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-muted)]"
          }
        >
          Payment method
        </span>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,520px)]">
        <section className="space-y-5">
          {/* ── Shipping step ─────────────────────────────────────────────── */}
          {step === "shipping" && (
            <>
              <div>
                <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
                  Shipping
                </h1>
                <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                  Add delivery details for this order. Merchant follow-up and
                  payment requests are sent through your Nostr account after
                  checkout.
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Delivery details
                </div>

                <div className="mt-5 grid gap-4">
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                    Required: Country, First name, Last name, Street address,
                    Postal code, and City.
                  </div>

                  {shippingAttempted && shippingErrors.length > 0 && (
                    <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
                      {shippingErrors.length === 1
                        ? shippingErrors[0]!.message
                        : `${shippingErrors.length} fields need attention: ${shippingErrors.map((e) => shippingFieldLabel(e.field)).join(", ")}`}
                    </div>
                  )}

                  {/* Country */}
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-country">
                      Country <span className="text-error">*</span>
                    </Label>
                    <Input
                      id="ship-country"
                      value={shipping.country}
                      onChange={(e) =>
                        updateShipping("country", e.target.value.toUpperCase())
                      }
                      placeholder="US"
                      maxLength={2}
                      aria-invalid={fieldInvalid("country")}
                      className={fieldClassName("country")}
                    />
                    {fieldInvalid("country") && (
                      <p className="text-xs text-error">
                        {fieldError("country")}
                      </p>
                    )}
                  </div>

                  {/* Name */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-first-name">
                        First name <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-first-name"
                        value={shipping.firstName}
                        onChange={(e) =>
                          updateShipping("firstName", e.target.value)
                        }
                        placeholder="Jane"
                        aria-invalid={fieldInvalid("firstName")}
                        className={fieldClassName("firstName")}
                      />
                      {fieldInvalid("firstName") && (
                        <p className="text-xs text-error">
                          {fieldError("firstName")}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-last-name">
                        Last name <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-last-name"
                        value={shipping.lastName}
                        onChange={(e) =>
                          updateShipping("lastName", e.target.value)
                        }
                        placeholder="Doe"
                        aria-invalid={fieldInvalid("lastName")}
                        className={fieldClassName("lastName")}
                      />
                      {fieldInvalid("lastName") && (
                        <p className="text-xs text-error">
                          {fieldError("lastName")}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Street */}
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-street">
                      Street address <span className="text-error">*</span>
                    </Label>
                    <Input
                      id="ship-street"
                      value={shipping.street}
                      onChange={(e) => updateShipping("street", e.target.value)}
                      placeholder="123 Main St"
                      aria-invalid={fieldInvalid("street")}
                      className={fieldClassName("street")}
                    />
                    {fieldInvalid("street") && (
                      <p className="text-xs text-error">
                        {fieldError("street")}
                      </p>
                    )}
                  </div>

                  {/* Line 2 */}
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-line2">
                      Apt, suite, etc. (optional)
                    </Label>
                    <Input
                      id="ship-line2"
                      value={shipping.line2}
                      onChange={(e) => updateShipping("line2", e.target.value)}
                      placeholder="Unit 4B"
                    />
                  </div>

                  {/* Postal / City / State */}
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-postal">
                        Postal code <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-postal"
                        value={shipping.postalCode}
                        onChange={(e) =>
                          updateShipping("postalCode", e.target.value)
                        }
                        placeholder="78701"
                        aria-invalid={fieldInvalid("postalCode")}
                        className={fieldClassName("postalCode")}
                      />
                      {fieldInvalid("postalCode") && (
                        <p className="text-xs text-error">
                          {fieldError("postalCode")}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-city">
                        City <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-city"
                        value={shipping.city}
                        onChange={(e) => updateShipping("city", e.target.value)}
                        placeholder="Austin"
                        aria-invalid={fieldInvalid("city")}
                        className={fieldClassName("city")}
                      />
                      {fieldInvalid("city") && (
                        <p className="text-xs text-error">
                          {fieldError("city")}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-state">Region</Label>
                      <Input
                        id="ship-state"
                        value={shipping.state}
                        onChange={(e) =>
                          updateShipping("state", e.target.value)
                        }
                        placeholder="TX"
                      />
                    </div>
                  </div>

                  {/* Contact */}
                  <div className="border-t border-[var(--border)] pt-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        Contact
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        (optional)
                      </div>
                    </div>
                    <div className="mt-4 grid gap-4">
                      <div className="grid gap-1.5">
                        <Label htmlFor="ship-phone">Phone</Label>
                        <Input
                          id="ship-phone"
                          value={shipping.phone}
                          onChange={(e) =>
                            updateShipping("phone", e.target.value)
                          }
                          placeholder="+1 555 123 4567"
                          aria-invalid={fieldInvalid("phone")}
                          className={fieldClassName("phone")}
                        />
                        {fieldInvalid("phone") && (
                          <p className="text-xs text-error">
                            {fieldError("phone")}
                          </p>
                        )}
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ship-email">Email</Label>
                        <Input
                          id="ship-email"
                          value={shipping.email}
                          onChange={(e) =>
                            updateShipping("email", e.target.value)
                          }
                          placeholder="jane@example.com"
                          aria-invalid={fieldInvalid("email")}
                          className={fieldClassName("email")}
                        />
                        {fieldInvalid("email") && (
                          <p className="text-xs text-error">
                            {fieldError("email")}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  <Button
                    className="mt-2 h-11 w-full text-sm"
                    onClick={continueToPayment}
                  >
                    Continue to payment method
                  </Button>

                  <p className="text-xs leading-6 text-[var(--text-muted)]">
                    Your order details will be sent to the merchant through your
                    signed Nostr account so they can follow up with payment and
                    fulfillment.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ── Payment step ──────────────────────────────────────────────── */}
          {step === "payment" && (
            <>
              <div>
                <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
                  Payment method
                </h1>
                <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                  {fastEligible
                    ? "Your wallet is connected and ready. Pay now or send the order first and pay later."
                    : "Orders are sent to the merchant first. The merchant will reply with payment details after reviewing your order."}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                {/* Payment method picker */}
                <div className="flex flex-wrap gap-3">
                  <PaymentMethodButton
                    label="Lightning"
                    icon={<LightningIcon className="h-4 w-4" />}
                    active
                  />
                  <PaymentMethodButton
                    label="USDT"
                    icon={<span className="text-base">₮</span>}
                    disabled
                    subtitle="Coming soon"
                  />
                </div>

                {/* Fast checkout banner */}
                {lnurlProbing && (
                  <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
                    <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                      <SpinnerIcon className="h-4 w-4 animate-spin" />
                      Checking merchant payment capabilities...
                    </div>
                  </div>
                )}

                {!lnurlProbing && fastEligible && (
                  <div className="mt-5 rounded-2xl border border-secondary-500/30 bg-secondary-500/8 p-5">
                    <div className="flex items-center gap-2">
                      <LightningIcon className="h-4 w-4 text-secondary-400" />
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        Pay now with your connected wallet
                      </div>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                      Your wallet supports instant Lightning payments. Tap{" "}
                      <strong>Pay now</strong> to complete this order
                      immediately - the payment and order details will both be
                      delivered to the merchant.
                    </p>
                  </div>
                )}

                {/* What happens next (order-first) */}
                {!fastEligible && !lnurlProbing && (
                  <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      What happens next
                    </div>
                    <ul className="mt-4 space-y-3 text-sm leading-7 text-[var(--text-secondary)]">
                      <li>
                        1. Your order is sent to the merchant through Nostr.
                      </li>
                      <li>
                        2. The merchant reviews the order and replies with
                        payment details.
                      </li>
                      <li>
                        3. You track order updates from the merchant in your
                        order history.
                      </li>
                    </ul>
                    {wallet.status === "disconnected" && (
                      <div className="mt-4 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">
                        <Link
                          to="/wallet"
                          className="underline underline-offset-2 hover:text-[var(--text-secondary)]"
                        >
                          Connect a Lightning wallet
                        </Link>{" "}
                        to unlock instant checkout on future orders.
                      </div>
                    )}
                  </div>
                )}

                {/* Order note */}
                <div className="mt-6 grid gap-1.5">
                  <Label htmlFor="order-note">Order note (optional)</Label>
                  <textarea
                    id="order-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Anything the merchant should know before they confirm the order?"
                    rows={4}
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
                  />
                </div>

                {error && (
                  <div className="mt-5 rounded-xl border border-error/30 bg-error/10 p-3 text-sm text-error">
                    {error}
                  </div>
                )}

                {/* Action buttons */}
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    className="h-11 px-4 text-sm"
                    onClick={() => setStep("shipping")}
                  >
                    Back to shipping
                  </Button>

                  {fastEligible && (
                    <Button className="h-11 px-5 text-sm" onClick={payNow}>
                      <LightningIcon className="h-4 w-4" />
                      Pay now
                    </Button>
                  )}

                  <Button
                    variant={fastEligible ? "outline" : "primary"}
                    className="h-11 px-5 text-sm"
                    onClick={placeOrder}
                  >
                    {fastEligible ? (
                      "Send order (pay later)"
                    ) : (
                      <>
                        <LightningIcon className="h-4 w-4" />
                        Send order
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>

        <OrderSummary
          items={checkoutItems}
          merchantPubkey={selectedMerchant!}
          step={summaryStep}
          btcUsdRate={btcUsdRateQuery.data?.rate ?? null}
        />
      </div>
    </div>
  )
}
