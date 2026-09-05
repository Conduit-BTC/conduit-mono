import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { Copy, Loader2, PackagePlus } from "lucide-react"
import { SUPPORTED_PRODUCT_PRICE_CURRENCIES } from "@conduit/core"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SignedActionStatus,
  Textarea,
  cn,
  type SignedActionStatusState,
} from "@conduit/ui"
import type {
  MerchantOrganizerEventMarket,
  MerchantOrganizerRecordDelivery,
} from "../lib/event-market"
import { acceptOwnEventProduct } from "../lib/event-product-acceptance"
import {
  createEmptyEventProductForm,
  eventProductFormFromTemplate,
  listEventProductTemplates,
  publishEventProduct,
  retryEventProductDelivery,
  validateEventProductPublishForm,
  type EventProductPublishFormValues,
} from "../lib/event-product-publishing"
import {
  getProductSignerRequestMessage,
  type ProductSignerRequestProgress,
} from "../lib/product-publishing"

const BLANK_TEMPLATE = "__blank__"

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-xs leading-5 text-error" role="alert">
      {message}
    </p>
  ) : null
}

export function EventProductPublisherDialog({
  open,
  merchantPubkey,
  market,
  onOpenChange,
  onPublished,
}: {
  open: boolean
  merchantPubkey: string
  market: MerchantOrganizerEventMarket
  onOpenChange: (open: boolean) => void
  onPublished: (
    productCoordinate: string,
    accepted: boolean
  ) => void | Promise<void>
}) {
  const [form, setForm] = useState<EventProductPublishFormValues>(() =>
    createEmptyEventProductForm(market)
  )
  const [submitted, setSubmitted] = useState(false)
  const [actionState, setActionState] =
    useState<SignedActionStatusState>("dirty")
  const [actionError, setActionError] = useState("")
  const [signedEvent, setSignedEvent] = useState<NDKEvent | null>(null)
  const [publishedCoordinate, setPublishedCoordinate] = useState<string | null>(
    null
  )
  const [signedAcceptance, setSignedAcceptance] =
    useState<MerchantOrganizerRecordDelivery | null>(null)
  const [accepting, setAccepting] = useState(false)
  const ownsMarket = merchantPubkey === market.organizerPubkey
  const [signerProgress, setSignerProgress] =
    useState<ProductSignerRequestProgress | null>(null)

  const templatesQuery = useQuery({
    queryKey: ["merchant-event-product-templates", merchantPubkey],
    enabled: open && !!merchantPubkey,
    queryFn: () => listEventProductTemplates(merchantPubkey),
  })
  const templates = useMemo(
    () => templatesQuery.data ?? [],
    [templatesQuery.data]
  )
  const validation = useMemo(
    () => validateEventProductPublishForm(form),
    [form]
  )
  const errors = submitted ? validation.product.errors : {}
  const pickupError = submitted ? validation.pickupError : null

  async function completeAcceptance(productCoordinate: string) {
    setPublishedCoordinate(productCoordinate)
    setSignerProgress(null)
    if (ownsMarket) {
      setAccepting(true)
      setActionState("awaiting_signature")
    }
    const accepted = await acceptOwnEventProduct({
      merchantPubkey,
      marketReference: market.naddr,
      productCoordinate,
      signedAcceptance,
      onSignedAcceptance: (record) => {
        setSignedAcceptance(record)
        setActionState("publishing")
      },
    })
    return { productCoordinate, accepted }
  }

  async function finishPublication(result: {
    productCoordinate: string
    accepted: boolean
  }) {
    setAccepting(false)
    setSignerProgress(null)
    setActionState("success")
    await onPublished(result.productCoordinate, result.accepted)
    onOpenChange(false)
  }

  const publishMutation = useMutation({
    mutationFn: async () => {
      const result = await publishEventProduct({
        merchantPubkey,
        marketReference: market.naddr,
        form,
        onSignerRequest: setSignerProgress,
        onSignedLocal: (event) => {
          setSignedEvent(event)
          setActionState("publishing")
        },
      })
      return completeAcceptance(result.productCoordinate)
    },
    onMutate: () => {
      setActionError("")
      setSignedEvent(null)
      setSignerProgress(null)
      setActionState("awaiting_signature")
    },
    onSuccess: finishPublication,
    onError: (error) => {
      setSignerProgress(null)
      setActionState("error")
      setActionError(
        errorMessage(error, "The event product could not be published.")
      )
    },
  })
  const retryMutation = useMutation({
    mutationFn: async () => {
      if (!signedEvent) throw new Error("Signed product event is unavailable.")
      if (!publishedCoordinate)
        await retryEventProductDelivery(signedEvent, merchantPubkey)
      const dTag = signedEvent.tags.find((tag) => tag[0] === "d")?.[1]
      if (!dTag) throw new Error("Signed product coordinate is unavailable.")
      return completeAcceptance(`30402:${merchantPubkey}:${dTag}`)
    },
    onMutate: () => {
      setActionError("")
      setActionState("publishing")
    },
    onSuccess: finishPublication,
    onError: (error) => {
      setActionState("error")
      setActionError(
        errorMessage(error, "The signed product could not be redelivered.")
      )
    },
  })
  const pending = publishMutation.isPending || retryMutation.isPending

  function update<K extends keyof EventProductPublishFormValues>(
    key: K,
    value: EventProductPublishFormValues[K]
  ): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function chooseTemplate(value: string): void {
    setSubmitted(false)
    setActionState("dirty")
    setActionError("")
    if (value === BLANK_TEMPLATE) {
      setForm(createEmptyEventProductForm(market))
      return
    }
    const template = templates.find(
      (candidate) => candidate.coordinate === value
    )
    if (template) setForm(eventProductFormFromTemplate(template, market))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"
        onPointerDownOutside={(event) => pending && event.preventDefault()}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Publish a product to {market.title}</DialogTitle>
          <DialogDescription className="text-pretty">
            Create a new event-specific listing or start from one of your
            existing products. The original listing is never changed.
            {ownsMarket &&
              " Since you organize this event, publishing also asks your signer to accept the product into your event catalog."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setSubmitted(true)
            if (!validation.canPublish || pending || signedEvent) return
            publishMutation.mutate()
          }}
        >
          <fieldset disabled={pending || !!signedEvent} className="contents">
            <div className="grid gap-1.5">
              <Label htmlFor="event-product-template">Start from</Label>
              <Select
                value={form.templateCoordinate || BLANK_TEMPLATE}
                onValueChange={chooseTemplate}
                disabled={templatesQuery.isPending}
              >
                <SelectTrigger id="event-product-template">
                  <SelectValue
                    placeholder={
                      templatesQuery.isPending
                        ? "Loading your products…"
                        : "Start with a blank product"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BLANK_TEMPLATE}>
                    <span className="flex items-center gap-2">
                      <PackagePlus className="h-4 w-4" /> Blank product
                    </span>
                  </SelectItem>
                  {templates.map((template) => (
                    <SelectItem
                      key={template.coordinate}
                      value={template.coordinate}
                    >
                      <span className="flex items-center gap-2">
                        <Copy className="h-4 w-4" /> {template.product.title}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {templatesQuery.isError && (
                <p className="text-xs leading-5 text-[var(--text-muted)]">
                  Existing products could not be loaded. You can still start
                  with a blank product.
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="event-product-title">Product title</Label>
              <Input
                id="event-product-title"
                value={form.title}
                onChange={(event) => update("title", event.target.value)}
                aria-invalid={!!errors.title}
                aria-describedby={
                  errors.title ? "event-product-title-error" : undefined
                }
              />
              <FieldError
                id="event-product-title-error"
                message={errors.title}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="event-product-summary">Summary</Label>
              <Textarea
                id="event-product-summary"
                className="min-h-20"
                value={form.summary}
                onChange={(event) => update("summary", event.target.value)}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="event-product-price">Price</Label>
                <Input
                  id="event-product-price"
                  type="text"
                  inputMode="decimal"
                  value={form.price}
                  onChange={(event) => update("price", event.target.value)}
                  aria-invalid={!!errors.price}
                  aria-describedby={
                    errors.price ? "event-product-price-error" : undefined
                  }
                />
                <FieldError
                  id="event-product-price-error"
                  message={errors.price}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-product-currency">Currency</Label>
                <Select
                  value={form.currency}
                  onValueChange={(value) => update("currency", value)}
                >
                  <SelectTrigger id="event-product-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_PRODUCT_PRICE_CURRENCIES.map((currency) => (
                      <SelectItem key={currency} value={currency}>
                        {currency}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-product-stock">Stock (optional)</Label>
                <Input
                  id="event-product-stock"
                  type="text"
                  inputMode="numeric"
                  value={form.stock}
                  onChange={(event) => update("stock", event.target.value)}
                  aria-invalid={!!errors.stock}
                  aria-describedby={
                    errors.stock ? "event-product-stock-error" : undefined
                  }
                />
                <FieldError
                  id="event-product-stock-error"
                  message={errors.stock}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="event-product-image">Image URL</Label>
              <Input
                id="event-product-image"
                type="url"
                inputMode="url"
                placeholder="https://"
                value={form.imageUrl}
                onChange={(event) => update("imageUrl", event.target.value)}
                aria-invalid={!!errors.imageUrl}
                aria-describedby={
                  errors.imageUrl ? "event-product-image-error" : undefined
                }
              />
              <FieldError
                id="event-product-image-error"
                message={errors.imageUrl}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="event-product-tags">Tags</Label>
              <Input
                id="event-product-tags"
                placeholder="coffee, local, handmade"
                value={form.tags}
                onChange={(event) => update("tags", event.target.value)}
                aria-invalid={!!errors.tags}
                aria-describedby={
                  errors.tags
                    ? "event-product-tags-error"
                    : "event-product-tags-help"
                }
              />
              <p
                id="event-product-tags-help"
                className="text-xs leading-5 text-[var(--text-muted)]"
              >
                Add at least three comma-separated tags so shoppers can find the
                product.
              </p>
              <FieldError id="event-product-tags-error" message={errors.tags} />
            </div>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium text-[var(--text-primary)]">
                Who hands the product to the buyer?
              </legend>
              <Button
                type="button"
                variant="outline"
                aria-pressed={form.handoffMode === "merchant_handoff"}
                className={cn(
                  "h-auto justify-start whitespace-normal p-3 text-left",
                  form.handoffMode === "merchant_handoff" &&
                    "border-primary-500 bg-primary-500/10"
                )}
                onClick={() => update("handoffMode", "merchant_handoff")}
              >
                <span>
                  <span className="block font-medium">I hand it out</span>
                  <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                    The buyer meets you at your pickup point or booth.
                  </span>
                </span>
              </Button>
              {!ownsMarket && (
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={form.handoffMode === "organizer_handoff"}
                  disabled={!market.pickupCoordinate}
                  className={cn(
                    "h-auto justify-start whitespace-normal p-3 text-left",
                    form.handoffMode === "organizer_handoff" &&
                      "border-secondary-500 bg-secondary-500/10"
                  )}
                  onClick={() => update("handoffMode", "organizer_handoff")}
                >
                  <span>
                    <span className="block font-medium">
                      Organizer hands it out
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                      You confirm payment and mark the item ready. Stay
                      available remotely; the organizer receives your signed
                      handoff instruction and pickup code, not independent
                      payment proof.
                    </span>
                  </span>
                </Button>
              )}
              {!ownsMarket && !market.pickupCoordinate && (
                <p className="text-xs leading-5 text-[var(--text-muted)]">
                  This organizer is not offering organizer handoff.
                </p>
              )}
            </fieldset>

            {form.handoffMode === "merchant_handoff" && (
              <div className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 sm:grid-cols-[1fr_8rem]">
                <div className="grid gap-1.5">
                  <Label htmlFor="event-product-pickup-location">
                    Pickup point or booth
                  </Label>
                  <Input
                    id="event-product-pickup-location"
                    value={form.merchantPickupLocation}
                    onChange={(event) =>
                      update("merchantPickupLocation", event.target.value)
                    }
                    aria-invalid={!!pickupError}
                    aria-describedby={
                      pickupError ? "event-product-pickup-error" : undefined
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="event-product-pickup-country">Country</Label>
                  <Input
                    id="event-product-pickup-country"
                    maxLength={2}
                    className="uppercase"
                    value={form.merchantPickupCountry}
                    onChange={(event) =>
                      update(
                        "merchantPickupCountry",
                        event.target.value.toUpperCase()
                      )
                    }
                    aria-invalid={!!pickupError}
                    aria-describedby={
                      pickupError ? "event-product-pickup-error" : undefined
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <FieldError
                    id="event-product-pickup-error"
                    message={pickupError ?? undefined}
                  />
                </div>
              </div>
            )}
          </fieldset>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
            <SignedActionStatus
              state={actionState}
              dirtyMessage={
                ownsMarket
                  ? "This creates a new product and accepts it into your event with a separate collection signature."
                  : "This creates a new product and asks the organizer to include it in the event."
              }
              awaitingSignatureMessage={
                accepting
                  ? "Confirm acceptance into your event catalog in your signer."
                  : signerProgress
                    ? getProductSignerRequestMessage(signerProgress)
                    : "Confirm the product in your signer."
              }
              publishingMessage={
                accepting
                  ? "Publishing your signed event acceptance."
                  : "Publishing the product and pickup reference."
              }
              successMessage={
                ownsMarket
                  ? "Product published and accepted into your event."
                  : "Product published. Organizer acceptance is pending."
              }
              errorMessage={actionError}
            />
          </div>

          <DialogFooter>
            {signedEvent && actionState === "error" && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => retryMutation.mutate()}
              >
                {publishedCoordinate ? "Retry acceptance" : "Retry delivery"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {actionState === "success"
                ? "Done"
                : publishedCoordinate
                  ? "Close"
                  : "Cancel"}
            </Button>
            {actionState !== "success" && !signedEvent && (
              <Button type="submit" disabled={pending}>
                {pending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Publishing…
                  </>
                ) : ownsMarket ? (
                  "Publish and accept product"
                ) : (
                  "Publish product"
                )}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
