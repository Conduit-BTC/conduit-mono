import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { Copy, Loader2, PackagePlus } from "lucide-react"
import {
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  useAuth,
  type ProductImageUploadController,
} from "@conduit/core"
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
  ProductImageUrlCollectionField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SignerRecoveryNotice,
  SignedActionStatus,
  Textarea,
  cn,
  type SignedActionStatusState,
} from "@conduit/ui"
import type {
  MerchantOrganizerEventMarket,
  MerchantOrganizerRecordDelivery,
} from "../lib/event-market"
import {
  acceptOwnEventProduct,
  retryOwnEventProductAcceptance,
} from "../lib/event-product-acceptance"
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
import { ProductPaymentSetupNotice } from "./ProductPaymentSetupNotice"

const BLANK_TEMPLATE = "__blank__"

function createEventProductUploadScopeId(): string {
  try {
    return `event-product-draft:${crypto.randomUUID()}`
  } catch {
    return `event-product-draft:${Date.now()}:${Math.random().toString(36).slice(2)}`
  }
}

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
  authenticatedPubkey,
  shouldContinue,
  market,
  productImageUpload,
  onOpenChange,
  onPublished,
}: {
  open: boolean
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  market: MerchantOrganizerEventMarket
  productImageUpload: ProductImageUploadController
  onOpenChange: (open: boolean) => void
  onPublished: (accepted: boolean) => void
}) {
  const {
    accountPubkey,
    pubkey,
    signer,
    status: authStatus,
    authGeneration,
    isAuthGenerationCurrent,
    remoteSignerRecovery,
    signerReadiness,
    connect,
  } = useAuth()
  const mountedRef = useRef(true)
  const authorityRef = useRef({
    accountPubkey,
    pubkey,
    authGeneration,
    signerReadiness,
    signerAvailable: !!signer,
  })
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useLayoutEffect(() => {
    authorityRef.current = {
      accountPubkey,
      pubkey,
      authGeneration,
      signerReadiness,
      signerAvailable: !!signer,
    }
  }, [accountPubkey, authGeneration, pubkey, signer, signerReadiness])

  function isCurrentOwner(ownerPubkey: string): boolean {
    return (
      mountedRef.current && authorityRef.current.accountPubkey === ownerPubkey
    )
  }

  function isCurrentFreshAuthority(
    ownerPubkey: string,
    generation: number
  ): boolean {
    const current = authorityRef.current
    return (
      isCurrentOwner(ownerPubkey) &&
      current.pubkey === ownerPubkey &&
      current.authGeneration === generation &&
      current.signerReadiness === "ready" &&
      current.signerAvailable &&
      isAuthGenerationCurrent(generation)
    )
  }

  const signerReady =
    accountPubkey === merchantPubkey &&
    pubkey === merchantPubkey &&
    signerReadiness === "ready" &&
    !!signer
  const titleInputRef = useRef<HTMLInputElement>(null)
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
  const [productImageUploadScopeId, setProductImageUploadScopeId] = useState(
    createEventProductUploadScopeId
  )
  const ownsMarket = merchantPubkey === market.organizerPubkey
  const [signerProgress, setSignerProgress] =
    useState<ProductSignerRequestProgress | null>(null)

  const templatesQuery = useQuery({
    queryKey: [
      "merchant-event-product-templates",
      merchantPubkey,
      authenticatedPubkey,
    ],
    enabled: open && !!merchantPubkey,
    queryFn: ({ signal }) =>
      listEventProductTemplates(
        merchantPubkey,
        accountPubkey,
        authenticatedPubkey,
        () => shouldContinue() && !signal.aborted
      ),
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

  type FreshAuthority = { ownerPubkey: string; authGeneration: number }

  function currentFreshAuthority(): FreshAuthority | null {
    if (!signerReady) return null
    return { ownerPubkey: merchantPubkey, authGeneration }
  }

  function productCoordinateFromSignedEvent(event: NDKEvent): string {
    const dTag = event.tags.find((tag) => tag[0] === "d")?.[1]
    if (!dTag) throw new Error("Signed product coordinate is unavailable.")
    return `30402:${merchantPubkey}:${dTag}`
  }

  async function reviewAndAccept(
    productCoordinate: string,
    authority: FreshAuthority
  ) {
    if (
      !isCurrentFreshAuthority(authority.ownerPubkey, authority.authGeneration)
    ) {
      throw new Error("Reconnect your signer, review this product, and retry.")
    }
    if (isCurrentOwner(authority.ownerPubkey)) {
      setPublishedCoordinate(productCoordinate)
      setSignerProgress(null)
      if (ownsMarket) {
        setAccepting(true)
        setActionState("awaiting_signature")
      }
    }
    const accepted = await acceptOwnEventProduct({
      merchantPubkey: authority.ownerPubkey,
      authenticatedPubkey: authority.ownerPubkey,
      shouldContinue: () =>
        isCurrentFreshAuthority(
          authority.ownerPubkey,
          authority.authGeneration
        ),
      marketReference: market.naddr,
      productCoordinate,
      onSignedAcceptance: (record) => {
        if (!isCurrentOwner(authority.ownerPubkey)) return
        setSignedAcceptance(record)
        setActionState("publishing")
      },
    })
    return { productCoordinate, accepted }
  }

  function finishPublication(
    result: { productCoordinate: string; accepted: boolean },
    ownerPubkey: string
  ) {
    if (!isCurrentOwner(ownerPubkey)) return
    setAccepting(false)
    setSignerProgress(null)
    setActionState("success")
    onPublished(result.accepted)
  }

  const publishMutation = useMutation({
    mutationFn: async (authority: FreshAuthority) => {
      if (
        !isCurrentFreshAuthority(
          authority.ownerPubkey,
          authority.authGeneration
        )
      ) {
        throw new Error(
          "Reconnect your signer, review this product, and retry."
        )
      }
      let fallbackDestinationScope: string | null = null
      let fallbackMovePrepared = false
      let signedLocally = false
      try {
        const result = await publishEventProduct({
          merchantPubkey: authority.ownerPubkey,
          authenticatedPubkey: authority.ownerPubkey,
          shouldContinue: () =>
            isCurrentFreshAuthority(
              authority.ownerPubkey,
              authority.authGeneration
            ),
          marketReference: market.naddr,
          form,
          onSignerRequest: (progress) => {
            if (
              isCurrentFreshAuthority(
                authority.ownerPubkey,
                authority.authGeneration
              )
            ) {
              setSignerProgress(progress)
            }
          },
          onProductPrepared: (dTag) => {
            if (
              !isCurrentFreshAuthority(
                authority.ownerPubkey,
                authority.authGeneration
              )
            ) {
              return
            }
            fallbackDestinationScope = `product:30402:${merchantPubkey}:${dTag}`
            fallbackMovePrepared = productImageUpload.prepareFallbackClaimMove(
              productImageUploadScopeId,
              fallbackDestinationScope
            )
          },
          onSignedLocal: (event) => {
            signedLocally = true
            if (fallbackMovePrepared && fallbackDestinationScope) {
              productImageUpload.commitFallbackClaimMove(
                productImageUploadScopeId,
                fallbackDestinationScope
              )
            }
            if (
              !isCurrentFreshAuthority(
                authority.ownerPubkey,
                authority.authGeneration
              )
            ) {
              return
            }
            setSignedEvent(event)
            setActionState("publishing")
          },
        })
        return reviewAndAccept(result.productCoordinate, authority)
      } catch (error) {
        if (
          fallbackMovePrepared &&
          !signedLocally &&
          fallbackDestinationScope
        ) {
          productImageUpload.cancelFallbackClaimMove(
            productImageUploadScopeId,
            fallbackDestinationScope
          )
        }
        throw error
      }
    },
    onMutate: (authority) => {
      if (
        !isCurrentFreshAuthority(
          authority.ownerPubkey,
          authority.authGeneration
        )
      ) {
        return
      }
      setActionError("")
      setSignedEvent(null)
      setSignerProgress(null)
      setActionState("awaiting_signature")
    },
    onSuccess: (result, authority) => {
      if (
        !isCurrentFreshAuthority(
          authority.ownerPubkey,
          authority.authGeneration
        )
      ) {
        return
      }
      finishPublication(result, authority.ownerPubkey)
    },
    onError: (error, authority) => {
      if (
        !isCurrentFreshAuthority(
          authority.ownerPubkey,
          authority.authGeneration
        )
      ) {
        return
      }
      setSignerProgress(null)
      setActionState("error")
      setActionError(
        errorMessage(error, "The event product could not be published.")
      )
    },
  })
  const retryProductDeliveryMutation = useMutation({
    mutationFn: async (input: { ownerPubkey: string; event: NDKEvent }) => {
      if (!isCurrentOwner(input.ownerPubkey)) {
        throw new Error("This signed product belongs to another account.")
      }
      await retryEventProductDelivery(
        input.event,
        input.ownerPubkey,
        null,
        () => isCurrentOwner(input.ownerPubkey)
      )
      return productCoordinateFromSignedEvent(input.event)
    },
    onMutate: (input) => {
      if (!isCurrentOwner(input.ownerPubkey)) return
      setActionError("")
      setActionState("publishing")
    },
    onSuccess: (productCoordinate, input) => {
      if (!isCurrentOwner(input.ownerPubkey)) return
      setPublishedCoordinate(productCoordinate)
      setSignerProgress(null)
      if (ownsMarket) {
        setActionState("dirty")
      } else {
        finishPublication(
          { productCoordinate, accepted: false },
          input.ownerPubkey
        )
      }
    },
    onError: (error, input) => {
      if (!isCurrentOwner(input.ownerPubkey)) return
      setActionState("error")
      setActionError(
        errorMessage(error, "The signed product could not be redelivered.")
      )
    },
  })
  const reviewAcceptanceMutation = useMutation({
    mutationFn: (input: FreshAuthority & { productCoordinate: string }) =>
      reviewAndAccept(input.productCoordinate, input),
    onMutate: (input) => {
      if (!isCurrentFreshAuthority(input.ownerPubkey, input.authGeneration)) {
        return
      }
      setActionError("")
      setAccepting(true)
      setActionState("awaiting_signature")
    },
    onSuccess: (result, input) => {
      if (!isCurrentFreshAuthority(input.ownerPubkey, input.authGeneration)) {
        return
      }
      finishPublication(result, input.ownerPubkey)
    },
    onError: (error, input) => {
      if (!isCurrentFreshAuthority(input.ownerPubkey, input.authGeneration)) {
        return
      }
      setAccepting(false)
      setActionState("error")
      setActionError(
        errorMessage(error, "The product acceptance could not be published.")
      )
    },
  })
  const retryAcceptanceMutation = useMutation({
    mutationFn: async (input: {
      ownerPubkey: string
      productCoordinate: string
      acceptance: MerchantOrganizerRecordDelivery
    }) => {
      if (!isCurrentOwner(input.ownerPubkey)) {
        throw new Error("This signed acceptance belongs to another account.")
      }
      const accepted = await retryOwnEventProductAcceptance({
        merchantPubkey: input.ownerPubkey,
        authenticatedPubkey: null,
        shouldContinue: () => isCurrentOwner(input.ownerPubkey),
        marketReference: market.naddr,
        productCoordinate: input.productCoordinate,
        signedAcceptance: input.acceptance,
        onRetriedAcceptance: (record) => {
          if (isCurrentOwner(input.ownerPubkey)) setSignedAcceptance(record)
        },
      })
      return { productCoordinate: input.productCoordinate, accepted }
    },
    onMutate: (input) => {
      if (!isCurrentOwner(input.ownerPubkey)) return
      setActionError("")
      setActionState("publishing")
    },
    onSuccess: (result, input) => {
      finishPublication(result, input.ownerPubkey)
    },
    onError: (error, input) => {
      if (!isCurrentOwner(input.ownerPubkey)) return
      setActionState("error")
      setActionError(
        errorMessage(
          error,
          "The signed event acceptance could not be redelivered."
        )
      )
    },
  })
  const pending =
    publishMutation.isPending ||
    retryProductDeliveryMutation.isPending ||
    reviewAcceptanceMutation.isPending ||
    retryAcceptanceMutation.isPending
  const acceptanceNeedsRetry =
    !!signedAcceptance &&
    (signedAcceptance.acknowledgedCount === 0 ||
      signedAcceptance.rejectedCount > 0 ||
      signedAcceptance.timedOutCount > 0)

  const previousAuthorityKeyRef = useRef(`${authGeneration}:${signerReady}`)
  useLayoutEffect(() => {
    const authorityKey = `${authGeneration}:${signerReady}`
    if (previousAuthorityKeyRef.current === authorityKey) return
    previousAuthorityKeyRef.current = authorityKey
    if (signerReady) return
    publishMutation.reset()
    reviewAcceptanceMutation.reset()
    setAccepting(false)
    setSignerProgress(null)
    setActionState((current) =>
      current === "awaiting_signature" || current === "publishing"
        ? signedEvent
          ? "error"
          : "dirty"
        : current
    )
  }, [
    authGeneration,
    publishMutation,
    reviewAcceptanceMutation,
    signedEvent,
    signerReady,
  ])

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

  function startAnotherPublication(): void {
    setForm(createEmptyEventProductForm(market))
    setSubmitted(false)
    setActionState("dirty")
    setSignedEvent(null)
    setPublishedCoordinate(null)
    setSignedAcceptance(null)
    setProductImageUploadScopeId(createEventProductUploadScopeId())
    requestAnimationFrame(() => titleInputRef.current?.focus())
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        if (!next && !signedEvent) {
          productImageUpload.clearFallbackClaim(productImageUploadScopeId)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="max-h-[92dvh] overflow-x-hidden overflow-y-auto sm:max-w-2xl"
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

        <ProductPaymentSetupNotice
          merchantPubkey={merchantPubkey}
          enabled={open}
        />

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setSubmitted(true)
            if (
              !validation.canPublish ||
              pending ||
              productImageUpload.isBusy ||
              signedEvent
            )
              return
            const authority = currentFreshAuthority()
            if (!authority) return
            publishMutation.mutate(authority)
          }}
        >
          <fieldset disabled={pending || !!signedEvent} className="contents">
            <div className="grid gap-1.5">
              <Label htmlFor="event-product-template">
                Create new or copy existing
              </Label>
              <Select
                value={form.templateCoordinate || BLANK_TEMPLATE}
                onValueChange={chooseTemplate}
                disabled={templatesQuery.isPending || productImageUpload.isBusy}
              >
                <SelectTrigger id="event-product-template">
                  <SelectValue
                    placeholder={
                      templatesQuery.isPending
                        ? "Loading your products…"
                        : "Create a new event product"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BLANK_TEMPLATE}>
                    <span className="flex items-center gap-2">
                      <PackagePlus className="h-4 w-4" /> Create a new event
                      product
                    </span>
                  </SelectItem>
                  {templates.map((template) => (
                    <SelectItem
                      key={template.coordinate}
                      value={template.coordinate}
                    >
                      <span className="flex items-center gap-2">
                        <Copy className="h-4 w-4" /> Copy “
                        {template.product.title}”
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-5 text-[var(--text-muted)]">
                Existing products are listed newest first. Copying creates a
                separate event listing and leaves the original unchanged.
              </p>
              {templatesQuery.isError && (
                <p className="text-xs leading-5 text-[var(--text-muted)]">
                  Existing products could not be loaded. You can still create a
                  new event product.
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="event-product-title">Product title</Label>
              <Input
                ref={titleInputRef}
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

            <ProductImageUrlCollectionField
              key={productImageUploadScopeId}
              id="event-product-image"
              images={form.images}
              upload={productImageUpload}
              uploadScopeId={productImageUploadScopeId}
              previewTitle={form.title.trim() || "Event product image"}
              onChange={(images) => update("images", images)}
              showRequiredError={submitted}
            />

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
          {remoteSignerRecovery ? (
            <SignerRecoveryNotice
              description="Your product draft and any exact signed delivery retry remain here. Reconnect the same signer, review the pending step, then choose it again. Conduit will not sign or send it automatically."
              reconnecting={authStatus === "restoring"}
              restoreFailed={!!remoteSignerRecovery.restoreError}
              restoreFailureDescription="That saved signer connection could not be restored. Your work remains for this account, and no product or acceptance action was replayed."
              onReconnect={() => connect({ mode: "restore" })}
            />
          ) : (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
              <SignedActionStatus
                state={actionState}
                dirtyMessage={
                  publishedCoordinate && ownsMarket
                    ? "The product is delivered. Review and accept it into your event with a separate signature."
                    : ownsMarket
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
          )}

          <DialogFooter>
            {signedEvent && !publishedCoordinate && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  retryProductDeliveryMutation.mutate({
                    ownerPubkey: merchantPubkey,
                    event: signedEvent,
                  })
                }
              >
                Retry exact product delivery
              </Button>
            )}
            {ownsMarket &&
              publishedCoordinate &&
              signedAcceptance &&
              acceptanceNeedsRetry && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    retryAcceptanceMutation.mutate({
                      ownerPubkey: merchantPubkey,
                      productCoordinate: publishedCoordinate,
                      acceptance: signedAcceptance,
                    })
                  }
                >
                  Retry exact acceptance
                </Button>
              )}
            {ownsMarket && publishedCoordinate && !signedAcceptance && (
              <Button
                type="button"
                disabled={pending || !signerReady}
                onClick={() => {
                  const authority = currentFreshAuthority()
                  if (!authority) return
                  reviewAcceptanceMutation.mutate({
                    ...authority,
                    productCoordinate: publishedCoordinate,
                  })
                }}
              >
                Review and accept
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
            {actionState === "success" && (
              <Button type="button" onClick={startAnotherPublication}>
                Publish another item
              </Button>
            )}
            {actionState !== "success" && !signedEvent && (
              <Button
                type="submit"
                disabled={pending || productImageUpload.isBusy || !signerReady}
              >
                {productImageUpload.isBusy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Uploading
                    images…
                  </>
                ) : pending ? (
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
