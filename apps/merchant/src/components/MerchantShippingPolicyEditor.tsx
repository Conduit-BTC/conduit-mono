import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  fetchMerchantShippingPolicy,
  publishMerchantShippingPolicy,
  SHIPPING_COUNTRIES,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  useAuth,
  withdrawMerchantShippingPolicy,
  type ShippingPolicy,
  type ShippingPolicyRevision,
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
  Combobox,
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
  shippingPolicyToDraft,
  type ShippingPolicyDraft,
} from "../lib/shippingPolicyForm"

import {
  getShippingWeightUnitPreference,
  saveShippingWeightUnitPreference,
  SHIPPING_WEIGHT_UNITS,
  type ShippingWeightUnit,
} from "../lib/shippingWeightUnits"
import { ShippingTableEditor } from "./ShippingTableEditor"
import { ShippingPolicyPreview } from "./ShippingPolicyPreview"

const countryOptions = SHIPPING_COUNTRIES.map((country) => ({
  value: country.code,
  label: country.name,
}))

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
  const [weightUnit, setWeightUnit] = useState<ShippingWeightUnit>(() =>
    getShippingWeightUnitPreference(pubkey)
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
  const needsUpgrade = remote?.policy.version === 1
  const [acceptedRevision, setAcceptedRevision] =
    useState<ShippingPolicyRevision | null>(null)
  const [acceptedConflictRevision, setAcceptedConflictRevision] =
    useState<ShippingPolicyRevision | null>(null)
  const observedRevision =
    query.data && query.data.state !== "not_found"
      ? (query.data.revision ?? null)
      : null
  const revisionChanged =
    (observedRevision?.eventId ?? null) !== (acceptedRevision?.eventId ?? null)
  const hasConflict =
    query.data?.state === "unavailable" && query.data.reason === "conflicting"
  const canReviewConflict =
    hasConflict && query.data?.coverageComplete && !!observedRevision
  const conflictNeedsReview =
    hasConflict &&
    (!canReviewConflict ||
      acceptedConflictRevision?.eventId !== observedRevision?.eventId)
  function acceptConflict() {
    if (!canReviewConflict || busy || query.isFetching || query.isError) return
    setAcceptedRevision(observedRevision)
    setAcceptedConflictRevision(observedRevision)
    setDirty(true)
    setStatus({ state: "idle" })
  }
  function loadLatestRates() {
    setDraft(
      remote
        ? shippingPolicyToDraft(remote.policy)
        : createShippingPolicyDraft()
    )
    setAcceptedRevision(observedRevision)
    setAcceptedConflictRevision(null)
    setDirty(false)
    setStatus({ state: "idle" })
  }
  useEffect(() => {
    if (dirty || !query.data || query.data.state === "unavailable") return
    if (!revisionChanged) return
    setDraft(
      remote
        ? shippingPolicyToDraft(remote.policy)
        : createShippingPolicyDraft()
    )
    setAcceptedRevision(observedRevision)
    setAcceptedConflictRevision(null)
  }, [remote, dirty, query.data, revisionChanged, observedRevision])
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
    if (
      !pubkey ||
      !policy ||
      busy ||
      revisionChanged ||
      conflictNeedsReview ||
      query.isPending ||
      authStatus !== "connected"
    )
      return
    setBusy(true)
    setStatus({ state: "idle" })
    try {
      await publishMerchantShippingPolicy({
        pubkey,
        policy,
        acceptedRevision,
        dependencies: {
          shouldContinue: () => generationRef.current === authGeneration,
        },
      })
      if (generationRef.current !== authGeneration) return
      setDirty(false)
      setStatus({
        state: "success",
        message: "Shipping rates published.",
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
    if (!pubkey || !remote || !acceptedRevision || busy || revisionChanged)
      return
    setBusy(true)
    try {
      await withdrawMerchantShippingPolicy({
        pubkey,
        acceptedRevision,
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
        <p className="text-pretty text-sm text-[var(--text-secondary)]">
          One shipping charge per order.
        </p>
        <Badge variant={dirty ? "warning" : remote ? "success" : "outline"}>
          {query.isPending
            ? "Checking rates"
            : dirty
              ? "Unpublished changes"
              : remote
                ? "Published"
                : "Not published"}
        </Badge>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || query.isFetching}
          onClick={() => void query.refetch()}
        >
          Check for updates
        </Button>
      </div>
      {(query.isError ||
        (query.data &&
          query.data.state !== "found" &&
          query.data.state !== "not_found")) && (
        <div className="space-y-2 rounded-xl border border-warning/40 p-3">
          <p className="text-pretty text-sm text-warning">
            {query.data?.state === "withdrawn"
              ? "These rates were withdrawn. Publish new rates when you are ready to ship."
              : hasConflict
                ? "Conflicting shipping rates were found. New checkouts need coordination until you publish replacement rates. Your draft will be kept."
                : "The latest shipping policy could not be confirmed. Check the relay connection before publishing changes."}
          </p>
          {hasConflict &&
            (conflictNeedsReview ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  !canReviewConflict ||
                  busy ||
                  query.isFetching ||
                  query.isError
                }
                onClick={acceptConflict}
              >
                Replace conflicting rates
              </Button>
            ) : (
              <p className="text-pretty text-sm text-[var(--text-secondary)]">
                Review your draft, then publish it as the new shipping rates.
              </p>
            ))}
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
      {dirty && revisionChanged && !hasConflict && (
        <div
          role="alert"
          className="space-y-2 rounded-xl border border-warning/40 p-3"
        >
          <p className="text-pretty text-sm text-warning">
            Shipping changed while you were editing. Load the latest rates
            before publishing. This replaces your unpublished edits.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || query.data?.state === "unavailable"}
            onClick={loadLatestRates}
          >
            Load latest rates
          </Button>
        </div>
      )}
      <form onSubmit={publish} className="space-y-5">
        <fieldset disabled={busy} className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 space-y-1.5 sm:col-span-1">
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
              <Label htmlFor="policy-currency">Shipping currency</Label>
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
            <div className="space-y-1.5">
              <Label htmlFor="policy-weight-unit">Weight unit</Label>
              <Select
                value={weightUnit}
                onValueChange={(value) => {
                  const unit = value as ShippingWeightUnit
                  setWeightUnit(unit)
                  saveShippingWeightUnitPreference(pubkey, unit)
                }}
              >
                <SelectTrigger id="policy-weight-unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHIPPING_WEIGHT_UNITS.map((unit) => (
                    <SelectItem key={unit.value} value={unit.value}>
                      {unit.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <ShippingTableEditor
              kind="domestic"
              originCountry={draft.originCountry}
              currency={draft.currency}
              weightUnit={weightUnit}
              table={draft.domestic}
              onChange={(domestic) => update({ domestic })}
            />
            <ShippingTableEditor
              kind="international"
              originCountry={draft.originCountry}
              currency={draft.currency}
              weightUnit={weightUnit}
              table={draft.international}
              onChange={(international) => update({ international })}
            />
          </div>
          {remote?.policy.version === 1 &&
            (remote.policy.weightAllowanceGrams > 0 ||
              remote.policy.handlingMinor > 0) && (
              <p className="text-pretty text-sm text-warning">
                Move shared packing buffers to products before updating these
                rates.
              </p>
            )}
        </fieldset>
        <ShippingPolicyPreview policy={policy} weightUnit={weightUnit} />
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
              revisionChanged ||
              conflictNeedsReview ||
              authStatus !== "connected" ||
              (!dirty && !!remote && !needsUpgrade)
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
              disabled={busy || revisionChanged}
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
            dirtyMessage="Publish rate changes."
            successMessage={status.message}
            errorMessage={status.state === "error" ? status.message : undefined}
          />
        </div>
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
