import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import {
  fetchMerchantShippingPolicy,
  publishMerchantShippingPolicy,
  previewShippingPolicy,
  SHIPPING_COUNTRIES,
  shippingMinorUnitsToAmount,
  shippingMoneyToMinorUnits,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  useAuth,
  withdrawMerchantShippingPolicy,
  type ShippingPolicy,
} from "@conduit/core"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  Combobox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SignedActionStatus,
} from "@conduit/ui"
import {
  buildShippingPolicyFromDraft,
  createShippingPolicyDraft,
  createShippingRuleDraft,
  shippingPolicyToDraft,
  type ShippingPolicyDraft,
  type ShippingTableDraft,
} from "../lib/shippingPolicyForm"

const countryOptions = SHIPPING_COUNTRIES.map((country) => ({
  value: country.code,
  label: country.name,
}))
const panel =
  "space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues
      .map((issue: { message: string }) => issue.message)
      .join(" ")
  }
  return error instanceof Error
    ? error.message
    : "Shipping could not be published. Try again."
}

function TableEditor({
  kind,
  originCountry,
  currency,
  table,
  onChange,
}: {
  kind: "domestic" | "international"
  originCountry: string
  currency: string
  table: ShippingTableDraft
  onChange: (value: ShippingTableDraft) => void
}) {
  const title = kind === "domestic" ? "Domestic" : "International"
  function updateRule(
    index: number,
    update: Partial<ShippingTableDraft["rules"][number]>
  ) {
    onChange({
      ...table,
      rules: table.rules.map((rule, i) =>
        i === index ? { ...rule, ...update } : rule
      ),
    })
  }
  return (
    <section className={panel} aria-label={`${title} rates`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-balance text-lg font-semibold">{title}</h3>
          <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
            {kind === "domestic"
              ? "Ship within your origin country."
              : "Choose the countries you ship to."}
          </p>
        </div>
        <label className="flex min-h-11 shrink-0 items-center gap-2 text-sm">
          <Checkbox
            checked={table.enabled}
            onCheckedChange={(checked) =>
              onChange({
                ...table,
                enabled: checked === true,
                rules:
                  checked === true && table.rules.length === 0
                    ? [
                        createShippingRuleDraft(
                          kind === "domestic" ? originCountry : ""
                        ),
                      ]
                    : table.rules,
              })
            }
          />
          Enable {title.toLowerCase()}
        </label>
      </div>
      {table.enabled && (
        <>
          {table.rules.map((rule, index) => (
            <div
              key={rule.id}
              className="space-y-3 rounded-xl border border-[var(--border)] p-3 sm:p-4"
            >
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor={`${rule.id}-country`}>
                    Destination {index + 1}
                  </Label>
                  {kind === "domestic" ? (
                    <p
                      id={`${rule.id}-country`}
                      className="flex min-h-11 items-center text-sm"
                    >
                      {countryOptions.find(
                        (country) => country.value === originCountry
                      )?.label ?? "Choose an origin country above"}
                    </p>
                  ) : (
                    <Combobox
                      id={`${rule.id}-country`}
                      value={rule.country}
                      options={countryOptions.filter(
                        (country) => country.value !== originCountry
                      )}
                      placeholder="Choose country"
                      searchPlaceholder="Search countries"
                      onValueChange={(country) =>
                        updateRule(index, {
                          country,
                          subdivision: "",
                          postalPrefix: "",
                        })
                      }
                    />
                  )}
                </div>
                {(kind === "international" || table.rules.length > 1) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${title.toLowerCase()} destination ${index + 1}`}
                    onClick={() =>
                      onChange({
                        ...table,
                        rules: table.rules.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer py-2 text-[var(--text-secondary)]">
                  Limit to a state or postal area (optional)
                </summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${rule.id}-subdivision`}>
                      Subdivision code
                    </Label>
                    <Input
                      id={`${rule.id}-subdivision`}
                      value={rule.subdivision}
                      placeholder="For example, US-CA"
                      autoCapitalize="characters"
                      onChange={(event) =>
                        updateRule(index, { subdivision: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${rule.id}-postal`}>Postal prefix</Label>
                    <Input
                      id={`${rule.id}-postal`}
                      value={rule.postalPrefix}
                      placeholder="For example, 94"
                      autoCapitalize="characters"
                      onChange={(event) =>
                        updateRule(index, { postalPrefix: event.target.value })
                      }
                    />
                  </div>
                </div>
                <p className="mt-2 text-pretty text-xs text-[var(--text-muted)]">
                  Leave both blank for the whole country. More specific areas
                  take precedence.
                </p>
              </details>
              {rule.bands.map((band, bandIndex) => (
                <div key={band.id} className="flex items-end gap-2">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor={`${band.id}-weight`}>
                      Up to weight (g)
                    </Label>
                    <Input
                      id={`${band.id}-weight`}
                      value={band.maxWeight}
                      inputMode="numeric"
                      placeholder={bandIndex === 0 ? "500" : "1000"}
                      className="tabular-nums"
                      onChange={(event) =>
                        updateRule(index, {
                          bands: rule.bands.map((entry, i) =>
                            i === bandIndex
                              ? { ...entry, maxWeight: event.target.value }
                              : entry
                          ),
                        })
                      }
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor={`${band.id}-price`}>
                      Total price ({currency})
                    </Label>
                    <Input
                      id={`${band.id}-price`}
                      value={band.price}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="tabular-nums"
                      onChange={(event) =>
                        updateRule(index, {
                          bands: rule.bands.map((entry, i) =>
                            i === bandIndex
                              ? { ...entry, price: event.target.value }
                              : entry
                          ),
                        })
                      }
                    />
                  </div>
                  {rule.bands.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${title.toLowerCase()} destination ${index + 1} band ${bandIndex + 1}`}
                      onClick={() =>
                        updateRule(index, {
                          bands: rule.bands.filter((_, i) => i !== bandIndex),
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  updateRule(index, {
                    bands: [
                      ...rule.bands,
                      { id: crypto.randomUUID(), maxWeight: "", price: "" },
                    ],
                  })
                }
              >
                <Plus className="mr-2 size-4" />
                Add weight band
              </Button>
              <p className="text-pretty text-xs text-[var(--text-muted)]">
                Each price is the total for the combined shipment in that band.
                The upper weight is included.
              </p>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                ...table,
                rules: [
                  ...table.rules,
                  createShippingRuleDraft(
                    kind === "domestic" ? originCountry : ""
                  ),
                ],
              })
            }
          >
            <Plus className="mr-2 size-4" />
            {kind === "domestic" ? "Add a special area" : "Add destination"}
          </Button>
          <div className="space-y-1.5">
            <Label htmlFor={`${kind}-free-threshold`}>
              Free shipping from ({currency}, optional)
            </Label>
            <Input
              id={`${kind}-free-threshold`}
              value={table.freeShippingThreshold}
              inputMode="decimal"
              placeholder="No free shipping threshold"
              className="tabular-nums"
              onChange={(event) =>
                onChange({
                  ...table,
                  freeShippingThreshold: event.target.value,
                })
              }
            />
            <p className="text-pretty text-xs text-[var(--text-muted)]">
              Based on shipped items after discounts. The destination and weight
              must still be supported.
            </p>
          </div>
        </>
      )}
    </section>
  )
}

function ShippingPreview({ policy }: { policy: ShippingPolicy | null }) {
  const [country, setCountry] = useState("")
  const [subdivision, setSubdivision] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [firstWeight, setFirstWeight] = useState("250")
  const [secondWeight, setSecondWeight] = useState("250")
  const [quantity, setQuantity] = useState("1")
  const [subtotal, setSubtotal] = useState("0")
  let result: string | null = null
  if (
    policy &&
    country &&
    firstWeight &&
    secondWeight &&
    quantity &&
    subtotal
  ) {
    try {
      const q = Number(quantity)
      const first = Number(firstWeight)
      const second = Number(secondWeight)
      if (
        ![q, first, second].every(
          (value) => Number.isSafeInteger(value) && value > 0
        )
      )
        throw new Error("Enter positive whole weights and quantities.")
      const subtotalMinor = shippingMoneyToMinorUnits(
        Number(subtotal),
        policy.currency
      )
      const quote = previewShippingPolicy({
        policy,
        destination: { country, subdivision, postalCode },
        items: [
          {
            shippingWeightGrams: first,
            quantity: q,
            currency: policy.currency,
            subtotalMinor: 0,
          },
          {
            shippingWeightGrams: second,
            quantity: 1,
            currency: policy.currency,
            subtotalMinor,
          },
        ],
      })
      result =
        quote.status === "quoted"
          ? `Combined shipping: ${shippingMinorUnitsToAmount(quote.amountMinor, policy.currency)} ${policy.currency}`
          : "This basket needs merchant coordination. Check the destination and weight limits."
    } catch (error) {
      result = errorMessage(error)
    }
  }
  return (
    <details className={panel}>
      <summary className="cursor-pointer text-balance font-semibold">
        Preview a basket
      </summary>
      <p className="text-pretty text-sm text-[var(--text-secondary)]">
        Try two products together. This calculation stays on this device and
        uses your draft rates.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="shipping-preview-country">Preview destination</Label>
          <Combobox
            id="shipping-preview-country"
            searchPlaceholder="Search countries"
            value={country}
            options={countryOptions}
            placeholder="Choose country"
            onValueChange={setCountry}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shipping-preview-region">Preview subdivision</Label>
          <Input
            id="shipping-preview-region"
            value={subdivision}
            onChange={(e) => setSubdivision(e.target.value)}
            placeholder="Optional, for example US-CA"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shipping-preview-postal">Preview postal code</Label>
          <Input
            id="shipping-preview-postal"
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shipping-preview-first-weight">
            First item weight (g)
          </Label>
          <Input
            id="shipping-preview-first-weight"
            value={firstWeight}
            inputMode="numeric"
            onChange={(e) => setFirstWeight(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shipping-preview-quantity">First item quantity</Label>
          <Input
            id="shipping-preview-quantity"
            value={quantity}
            inputMode="numeric"
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shipping-preview-second-weight">
            Second item weight (g)
          </Label>
          <Input
            id="shipping-preview-second-weight"
            value={secondWeight}
            inputMode="numeric"
            onChange={(e) => setSecondWeight(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shipping-preview-subtotal">
            Shipped merchandise subtotal ({policy?.currency ?? "currency"})
          </Label>
          <Input
            id="shipping-preview-subtotal"
            value={subtotal}
            inputMode="decimal"
            onChange={(e) => setSubtotal(e.target.value)}
          />
        </div>
      </div>
      <p role="status" className="text-pretty text-sm tabular-nums">
        {result ??
          "Complete valid rates above and choose a destination to see the total."}
      </p>
    </details>
  )
}

export function MerchantShippingPolicyEditor() {
  const { pubkey, status: authStatus, authGeneration } = useAuth()
  const generationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    generationRef.current = authGeneration
  }, [authGeneration])
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<ShippingPolicyDraft>(
    createShippingPolicyDraft
  )
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [status, setStatus] = useState<{
    state: "idle" | "success" | "error"
    message?: string
  }>({ state: "idle" })
  const queryKey = ["merchant-shipping-policy", pubkey ?? "none"]
  const query = useQuery({
    queryKey,
    enabled: !!pubkey && authStatus === "connected",
    queryFn: () =>
      fetchMerchantShippingPolicy(pubkey!, {
        authenticatedPubkey: pubkey,
        accountPubkey: pubkey,
        shouldContinue: () => generationRef.current === authGeneration,
      }),
    staleTime: 30_000,
  })
  const remote = query.data?.state === "found" ? query.data : null
  const hydratedRevision = useRef<string | null>(null)
  useEffect(() => {
    if (
      !remote ||
      dirty ||
      hydratedRevision.current === remote.revision.eventId
    )
      return
    setDraft(shippingPolicyToDraft(remote.policy))
    hydratedRevision.current = remote.revision.eventId
  }, [remote, dirty])
  function update(update: Partial<ShippingPolicyDraft>) {
    setDraft((current) => ({ ...current, ...update }))
    setDirty(true)
    setStatus({ state: "idle" })
  }
  let policy: ShippingPolicy | null = null
  let validationError: string | null = null
  try {
    policy = buildShippingPolicyFromDraft(draft)
  } catch (error) {
    validationError = errorMessage(error)
  }
  async function publish(event: React.FormEvent) {
    event.preventDefault()
    if (!pubkey || !policy || busy || authStatus !== "connected") return
    setBusy(true)
    setStatus({ state: "idle" })
    try {
      await publishMerchantShippingPolicy({
        pubkey,
        policy,
        acceptedRevision:
          remote?.revision ??
          (query.data?.state === "withdrawn" ? query.data.revision : null),
        dependencies: {
          shouldContinue: () => generationRef.current === authGeneration,
        },
      })
      if (generationRef.current !== authGeneration) return
      setDirty(false)
      setStatus({
        state: "success",
        message:
          "Shipping rates published. Products using this policy share a shipping charge.",
      })
      await queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      if (generationRef.current === authGeneration)
        setStatus({ state: "error", message: errorMessage(error) })
    } finally {
      if (generationRef.current === authGeneration) setBusy(false)
    }
  }
  async function withdraw() {
    if (!pubkey || !remote || busy) return
    setBusy(true)
    try {
      await withdrawMerchantShippingPolicy({
        pubkey,
        acceptedRevision: remote.revision,
        dependencies: {
          shouldContinue: () => generationRef.current === authGeneration,
        },
      })
      if (generationRef.current !== authGeneration) return
      setWithdrawOpen(false)
      setStatus({
        state: "success",
        message:
          "Shipping policy withdrawn. New orders need coordination until rates are published again.",
      })
      await queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      if (generationRef.current === authGeneration)
        setStatus({ state: "error", message: errorMessage(error) })
    } finally {
      if (generationRef.current === authGeneration) setBusy(false)
    }
  }
  return (
    <section aria-label="Shipping rates" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-balance text-2xl font-semibold">Shipping rates</h2>
        <Badge variant={dirty ? "warning" : remote ? "success" : "outline"}>
          {query.isPending
            ? "Checking rates"
            : dirty
              ? "Unpublished changes"
              : remote
                ? "Published"
                : "Not published"}
        </Badge>
      </div>
      <p className="text-pretty text-sm leading-6 text-[var(--text-secondary)]">
        Set one total price for each combined weight band. Buyers pay one
        shipping charge when products use the same policy. Custom tables work
        without a carrier or preset.
      </p>
      {(query.isError ||
        (query.data &&
          query.data.state !== "found" &&
          query.data.state !== "not_found")) && (
        <div className="space-y-2 rounded-xl border border-warning/40 p-3">
          <p className="text-pretty text-sm text-warning">
            {query.data?.state === "withdrawn"
              ? "These rates were withdrawn. Publish new rates when you are ready to ship."
              : "The latest shipping policy could not be confirmed. Check the relay connection before publishing changes."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Check again
          </Button>
        </div>
      )}
      <form onSubmit={publish} className="space-y-5">
        <fieldset disabled={busy} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="policy-origin">Origin country</Label>
              <Combobox
                id="policy-origin"
                value={draft.originCountry}
                options={countryOptions}
                placeholder="Choose origin country"
                searchPlaceholder="Search countries"
                onValueChange={(originCountry) => update({ originCountry })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="policy-currency">Rate currency</Label>
              <Select
                value={draft.currency}
                onValueChange={(currency) => update({ currency })}
              >
                <SelectTrigger id="policy-currency">
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
          </div>
          <p className="text-pretty text-xs text-[var(--text-muted)]">
            Use the same currency on products assigned to this policy. Grams
            measure the weight shipped: 1 kg = 1,000 g.
          </p>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <TableEditor
              kind="domestic"
              originCountry={draft.originCountry}
              currency={draft.currency}
              table={draft.domestic}
              onChange={(domestic) => update({ domestic })}
            />
            <TableEditor
              kind="international"
              originCountry={draft.originCountry}
              currency={draft.currency}
              table={draft.international}
              onChange={(international) => update({ international })}
            />
          </div>
          <details className={panel}>
            <summary className="cursor-pointer text-balance font-semibold">
              Weight and handling buffers (optional)
            </summary>
            <div className="space-y-1.5">
              <Label htmlFor="policy-title">Policy name</Label>
              <Input
                id="policy-title"
                value={draft.title}
                onChange={(event) => update({ title: event.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="policy-weight-allowance">
                  Extra shipment weight (g)
                </Label>
                <Input
                  id="policy-weight-allowance"
                  inputMode="numeric"
                  value={draft.weightAllowance}
                  placeholder="0"
                  onChange={(e) => update({ weightAllowance: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="policy-handling">
                  Handling buffer ({draft.currency})
                </Label>
                <Input
                  id="policy-handling"
                  inputMode="decimal"
                  value={draft.handling}
                  placeholder="0"
                  onChange={(e) => update({ handling: e.target.value })}
                />
              </div>
            </div>
            <p className="text-pretty text-xs text-[var(--text-muted)]">
              Each buffer is applied once per combined shipment. These are
              estimates for ordinary packing, not an exact carrier quote.
            </p>
          </details>
        </fieldset>
        <ShippingPreview policy={policy} />
        {dirty && validationError && (
          <p
            id="shipping-policy-error"
            role="alert"
            className="text-pretty text-sm text-error"
          >
            {validationError}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            type="submit"
            disabled={
              !policy ||
              busy ||
              query.isPending ||
              authStatus !== "connected" ||
              (!dirty && !!remote)
            }
          >
            {busy
              ? "Waiting for signer…"
              : remote
                ? "Publish rate changes"
                : "Publish shipping rates"}
          </Button>
          {remote && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setWithdrawOpen(true)}
            >
              Withdraw policy
            </Button>
          )}
          <SignedActionStatus
            state={
              status.state === "error"
                ? "error"
                : dirty
                  ? "dirty"
                  : status.state === "success"
                    ? "success"
                    : "idle"
            }
            dirtyMessage="Publish to make these rates available to buyers."
            successMessage={status.message}
            errorMessage={status.state === "error" ? status.message : undefined}
          />
        </div>
        <p className="text-pretty text-xs text-[var(--text-muted)]">
          Your rates are public and signed. Buyer destinations and basket
          calculations remain private.
        </p>
      </form>
      <AlertDialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw shipping rates?</AlertDialogTitle>
            <AlertDialogDescription>
              New checkouts using these rates will need coordination. Orders
              already agreed keep their original shipping terms.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setWithdrawOpen(false)}
            >
              Keep rates
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void withdraw()}
            >
              Sign and withdraw
            </Button>
          </AlertDialogFooter>
          {status.state === "error" && (
            <p role="alert" className="text-pretty text-sm text-error">
              {status.message}
            </p>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
