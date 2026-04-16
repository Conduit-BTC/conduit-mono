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
import { NDKEvent, NDKUser, giftWrap } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  formatPubkey,
  getNdk,
  useAuth,
  useProfile,
  type ShippingAddressSchema,
} from "@conduit/core"
import { Button, Input, Label } from "@conduit/ui"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { type CartItem, useCart } from "../hooks/useCart"
import { requireAuth } from "../lib/auth"
import { getProductPriceDisplay } from "../lib/pricing"

type CheckoutStep = "shipping" | "payment" | "signing" | "sending" | "sent"
type PaymentMethod = "lightning"

type CheckoutSearch = {
  merchant?: string
}

type ShippingFormState = ShippingAddressSchema & {
  firstName: string
  lastName: string
  line2: string
  phone: string
  email: string
}

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

type ShippingFieldKey =
  | "country"
  | "firstName"
  | "lastName"
  | "street"
  | "postalCode"
  | "city"

function getMissingShippingFields(
  shipping: ShippingFormState
): ShippingFieldKey[] {
  const missing: ShippingFieldKey[] = []

  if (shipping.country.trim().length < 2) missing.push("country")
  if (shipping.firstName.trim() === "") missing.push("firstName")
  if (shipping.lastName.trim() === "") missing.push("lastName")
  if (shipping.street.trim() === "") missing.push("street")
  if (shipping.postalCode.trim() === "") missing.push("postalCode")
  if (shipping.city.trim() === "") missing.push("city")

  return missing
}

function shippingFieldLabel(field: ShippingFieldKey): string {
  switch (field) {
    case "country":
      return "Country"
    case "firstName":
      return "First name"
    case "lastName":
      return "Last name"
    case "street":
      return "Street address"
    case "postalCode":
      return "Postal code"
    case "city":
      return "City"
  }
}

export const Route = createFileRoute("/checkout")({
  beforeLoad: () => {
    requireAuth()
  },
  validateSearch: (search: Record<string, unknown>): CheckoutSearch => ({
    merchant: typeof search.merchant === "string" ? search.merchant : undefined,
  }),
  component: CheckoutPage,
})

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

function readStoredShipping(): ShippingFormState {
  if (typeof window === "undefined") return DEFAULT_SHIPPING_FORM

  try {
    const raw = localStorage.getItem(CHECKOUT_STORAGE_KEY)
    if (!raw) return DEFAULT_SHIPPING_FORM
    const parsed = JSON.parse(raw) as Partial<ShippingFormState>
    return {
      ...DEFAULT_SHIPPING_FORM,
      ...parsed,
    }
  } catch {
    return DEFAULT_SHIPPING_FORM
  }
}

function writeStoredShipping(value: ShippingFormState): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // ignore
  }
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

function OrderSummary({
  items,
  merchantPubkey,
  step,
  btcUsdRate,
}: {
  items: CartItem[]
  merchantPubkey: string
  step: Exclude<CheckoutStep, "signing" | "sending" | "sent">
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

function CheckoutPage() {
  const { pubkey } = useAuth()
  const cart = useCart()
  const search = Route.useSearch()
  const btcUsdRateQuery = useBtcUsdRate()

  const [step, setStep] = useState<CheckoutStep>("shipping")
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("lightning")
  const [needsShipping, setNeedsShipping] = useState(true)
  const [shipping, setShipping] = useState<ShippingFormState>(() =>
    readStoredShipping()
  )
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [shippingAttempted, setShippingAttempted] = useState(false)
  const [sentOrderId, setSentOrderId] = useState<string | null>(null)
  const [showSentGlow, setShowSentGlow] = useState(false)

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

  const total = useMemo(
    () =>
      checkoutItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [checkoutItems]
  )

  const missingShippingFields = useMemo(
    () => (needsShipping ? getMissingShippingFields(shipping) : []),
    [needsShipping, shipping]
  )
  const shippingValid = !needsShipping || missingShippingFields.length === 0
  const summaryStep: Exclude<CheckoutStep, "signing" | "sending" | "sent"> =
    step === "payment" ? "payment" : "shipping"

  function updateShipping<K extends keyof ShippingFormState>(
    field: K,
    value: ShippingFormState[K]
  ): void {
    setShipping((current) => {
      const next = { ...current, [field]: value }
      writeStoredShipping(next)
      return next
    })
  }

  function continueToPayment(): void {
    setShippingAttempted(true)
    if (!shippingValid) {
      setError("Fill in the required shipping fields to continue.")
      return
    }
    setError(null)
    setStep("payment")
  }

  useEffect(() => {
    if (!showSentGlow) return

    const timeoutId = window.setTimeout(() => setShowSentGlow(false), 650)
    return () => window.clearTimeout(timeoutId)
  }, [showSentGlow])

  useEffect(() => {
    if (!shippingAttempted || !needsShipping) return
    if (
      missingShippingFields.length === 0 &&
      error === "Fill in the required shipping fields to continue."
    ) {
      setError(null)
    }
  }, [error, missingShippingFields.length, needsShipping, shippingAttempted])

  async function placeOrder(): Promise<void> {
    if (!pubkey || !selectedMerchant || checkoutItems.length === 0) return

    setError(null)
    setStep("signing")

    try {
      const orderId = crypto.randomUUID()
      const currency = checkoutItems[0]?.currency ?? "USD"
      const items = checkoutItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        priceAtPurchase: item.price,
        currency: item.currency,
      }))

      const contactLines = [
        note.trim() || undefined,
        shipping.phone.trim() ? `Phone: ${shipping.phone.trim()}` : undefined,
        shipping.email.trim() ? `Email: ${shipping.email.trim()}` : undefined,
      ].filter(Boolean)

      const shippingAddress = needsShipping
        ? {
            name: `${shipping.firstName.trim()} ${shipping.lastName.trim()}`.trim(),
            street: [shipping.street.trim(), shipping.line2.trim()]
              .filter(Boolean)
              .join(", "),
            city: shipping.city.trim(),
            state: (shipping.state ?? "").trim() || undefined,
            postalCode: shipping.postalCode.trim(),
            country: shipping.country.trim().toUpperCase(),
          }
        : undefined

      const payload = {
        id: orderId,
        merchantPubkey: selectedMerchant,
        buyerPubkey: pubkey,
        items,
        subtotal: total,
        currency,
        shippingAddress,
        note: contactLines.length > 0 ? contactLines.join("\n") : undefined,
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

  if (step === "sending") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="w-full max-w-3xl rounded-[2rem] bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--tertiary-500)_35%,transparent),transparent_55%),linear-gradient(180deg,var(--primary-500),var(--primary-600))] px-8 py-14 text-center text-white shadow-[0_24px_60px_color-mix(in_srgb,var(--primary-500)_40%,transparent)] sm:px-12">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text-inverse)_20%,transparent)] bg-[color-mix(in_srgb,var(--text-inverse)_10%,transparent)]">
            <SpinnerIcon className="h-8 w-8 animate-spin" />
          </div>
          <h1 className="mt-8 text-4xl font-semibold tracking-tight">
            Sending your order…
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
            Awaiting signature…
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
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    Delivery details
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={needsShipping}
                      onChange={(e) => setNeedsShipping(e.target.checked)}
                      className="rounded border-[var(--border)]"
                    />
                    Requires shipping
                  </label>
                </div>

                {needsShipping ? (
                  <div className="mt-5 grid gap-4">
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                      Required fields: Country, First name, Last name, Street
                      address, Postal code, and City.
                    </div>

                    {shippingAttempted && missingShippingFields.length > 0 && (
                      <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
                        Missing:{" "}
                        {missingShippingFields
                          .map(shippingFieldLabel)
                          .join(", ")}
                      </div>
                    )}

                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-country">
                        Country <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-country"
                        value={shipping.country}
                        onChange={(e) =>
                          updateShipping(
                            "country",
                            e.target.value.toUpperCase()
                          )
                        }
                        placeholder="US"
                        maxLength={2}
                        aria-invalid={
                          shippingAttempted &&
                          missingShippingFields.includes("country")
                        }
                        className={
                          shippingAttempted &&
                          missingShippingFields.includes("country")
                            ? "border-error/50 focus:border-error focus:ring-error/30"
                            : undefined
                        }
                      />
                    </div>

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
                          aria-invalid={
                            shippingAttempted &&
                            missingShippingFields.includes("firstName")
                          }
                          className={
                            shippingAttempted &&
                            missingShippingFields.includes("firstName")
                              ? "border-error/50 focus:border-error focus:ring-error/30"
                              : undefined
                          }
                        />
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
                          aria-invalid={
                            shippingAttempted &&
                            missingShippingFields.includes("lastName")
                          }
                          className={
                            shippingAttempted &&
                            missingShippingFields.includes("lastName")
                              ? "border-error/50 focus:border-error focus:ring-error/30"
                              : undefined
                          }
                        />
                      </div>
                    </div>

                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-street">
                        Street address <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-street"
                        value={shipping.street}
                        onChange={(e) =>
                          updateShipping("street", e.target.value)
                        }
                        placeholder="123 Main St"
                        aria-invalid={
                          shippingAttempted &&
                          missingShippingFields.includes("street")
                        }
                        className={
                          shippingAttempted &&
                          missingShippingFields.includes("street")
                            ? "border-error/50 focus:border-error focus:ring-error/30"
                            : undefined
                        }
                      />
                    </div>

                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-line2">
                        Apt, suite, etc. (optional)
                      </Label>
                      <Input
                        id="ship-line2"
                        value={shipping.line2}
                        onChange={(e) =>
                          updateShipping("line2", e.target.value)
                        }
                        placeholder="Unit 4B"
                      />
                    </div>

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
                          aria-invalid={
                            shippingAttempted &&
                            missingShippingFields.includes("postalCode")
                          }
                          className={
                            shippingAttempted &&
                            missingShippingFields.includes("postalCode")
                              ? "border-error/50 focus:border-error focus:ring-error/30"
                              : undefined
                          }
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ship-city">
                          City <span className="text-error">*</span>
                        </Label>
                        <Input
                          id="ship-city"
                          value={shipping.city}
                          onChange={(e) =>
                            updateShipping("city", e.target.value)
                          }
                          placeholder="Austin"
                          aria-invalid={
                            shippingAttempted &&
                            missingShippingFields.includes("city")
                          }
                          className={
                            shippingAttempted &&
                            missingShippingFields.includes("city")
                              ? "border-error/50 focus:border-error focus:ring-error/30"
                              : undefined
                          }
                        />
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
                          />
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
                          />
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
                      Your order details will be sent to the merchant through
                      your signed Nostr account so they can follow up with
                      payment and fulfillment.
                    </p>
                  </div>
                ) : (
                  <div className="mt-5 space-y-4">
                    <p className="text-sm leading-7 text-[var(--text-secondary)]">
                      No shipping details are needed for this order. You can
                      continue directly to payment method selection.
                    </p>
                    <Button
                      className="h-11 w-full text-sm"
                      onClick={continueToPayment}
                    >
                      Continue to payment method
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          {step === "payment" && (
            <>
              <div>
                <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
                  Payment method
                </h1>
                <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                  Orders are sent to the merchant first. Lightning is available
                  now, and the merchant will reply with payment details after
                  reviewing your order.
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                <div className="flex flex-wrap gap-3">
                  <PaymentMethodButton
                    label="Lightning"
                    icon={<LightningIcon className="h-4 w-4" />}
                    active={paymentMethod === "lightning"}
                    onClick={() => setPaymentMethod("lightning")}
                  />
                  <PaymentMethodButton
                    label="USDT"
                    icon={<span className="text-base">₮</span>}
                    disabled
                    subtitle="Coming soon"
                  />
                  {/*
                  <PaymentMethodButton label="On-Chain" icon={<span className="text-base">⛓</span>} disabled subtitle="Coming soon" />
                  <PaymentMethodButton label="Minipay" icon={<span className="text-base">◔</span>} disabled subtitle="Coming soon" />
                  <PaymentMethodButton label="Fiat" icon={<span className="text-base">$</span>} disabled subtitle="Coming soon" />
                  */}
                </div>

                <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    What happens next
                  </div>
                  <ul className="mt-4 space-y-3 text-sm leading-7 text-[var(--text-secondary)]">
                    <li>
                      1. Your order is sent to the merchant through Nostr.
                    </li>
                    <li>
                      2. The merchant reviews the order and replies with payment
                      details.
                    </li>
                    <li>
                      3. You track order updates from the merchant in your order
                      history.
                    </li>
                  </ul>
                </div>

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

                <div className="mt-6 flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    className="h-11 px-4 text-sm"
                    onClick={() => setStep("shipping")}
                  >
                    Back to shipping
                  </Button>
                  <Button className="h-11 px-5 text-sm" onClick={placeOrder}>
                    <LightningIcon className="h-4 w-4" />
                    Send order
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
