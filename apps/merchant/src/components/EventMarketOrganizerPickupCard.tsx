import { useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { EventMarketOrganizerMerchandise } from "@conduit/core/protocol/event-market-organizer-merchandise"
import {
  acceptCheckoutSparkOrganizerStockOrder,
  assertCheckoutSparkOrganizerCommerceProof,
  assertCheckoutSparkOrganizerRecoveryAuthority,
  assertEventMarketOrganizerPurchaseAuthority,
  confirmOrganizerStockOrderHandout,
  db,
  getAccountSigner,
  getCommerceInbox,
  openCheckoutSparkOrganizerRecoveryAuthority,
  openEventMarketFreePurchaseAuthority,
  proveEventMarketFreeOrganizerCommerce,
  readRetainedCheckoutSparkOrganizerRecoveries,
  retryOrganizerStockOrderHandout,
  useAuth,
  type CheckoutSparkOrganizerCommerceProof,
  type CheckoutSparkOrganizerRecoveryAuthority,
  type CheckoutSparkOrganizerRecoverySelection,
  type EventMarketFreePurchaseSelection,
  type EventMarketFreePurchaseAuthority,
  type EventMarketOrganizerPurchaseAuthority,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CheckoutPaymentProgress,
  Field,
  Input,
  useTimeBoundaryNow,
} from "@conduit/ui"

/** The UI's common continuation does not create a financial plan for free goods. */
export async function continueEventMarketOrganizerPickup(
  input: Omit<
    Parameters<typeof acceptCheckoutSparkOrganizerStockOrder>[0],
    "delivery" | "nowMs"
  >,
  dependencies: {
    delivery?: Parameters<
      typeof acceptCheckoutSparkOrganizerStockOrder
    >[0]["delivery"]
    now?: () => number
  } = {}
) {
  input = { ...input }
  const purchase = assertEventMarketOrganizerPurchaseAuthority(input.authority)
  await acceptCheckoutSparkOrganizerStockOrder({
    ...input,
    delivery: dependencies.delivery,
    nowMs: dependencies.now?.(),
  })
  if (purchase.kind === "free") {
    const commerceProof = await proveEventMarketFreeOrganizerCommerce({
      authority: input.authority as EventMarketFreePurchaseAuthority,
      assertCurrent: () => {
        if (!input.shouldContinue())
          throw new Error("Organizer pickup session changed.")
        assertEventMarketOrganizerPurchaseAuthority(input.authority)
      },
      now: dependencies.now,
    })
    return { status: "complete" as const, commerceProof, reason: undefined }
  }
  const { routeCheckoutSparkOrganizerOrder } =
    await import("../lib/checkout-spark-organizer-routing")
  return routeCheckoutSparkOrganizerOrder({
    ...input,
    authority: input.authority as CheckoutSparkOrganizerRecoveryAuthority,
  })
}

export function EventMarketOrganizerPickupForm(props: {
  orderLabel: string
  quantity: number
  merchandise?: EventMarketOrganizerMerchandise
  routing: boolean
  free?: boolean
  historyReady?: boolean
  paymentVerified: boolean
  handedOut: boolean
  waitingForBuyer: boolean
  waitingForFunding?: boolean
  needsAttention?: boolean
  claimCode: string
  error?: string
  notice?: string
  onClaimCode(value: string): void
  onContinue(): void
  onPause(): void
  onHandout(): void
  onRetryHandout(): void
}) {
  return (
    <section className="space-y-3 border-t border-[var(--border)] pt-4">
      <h3 className="font-semibold">Order {props.orderLabel}</h3>
      <p role="status" className="text-sm font-medium">
        {props.handedOut
          ? "Handed out"
          : props.routing
            ? props.free
              ? "Checking pickup"
              : "Routing"
            : props.paymentVerified
              ? "Ready for pickup"
              : props.needsAttention
                ? "Needs attention"
                : props.waitingForFunding
                  ? "Awaiting funding verification"
                  : props.waitingForBuyer
                    ? "Buyer payment in progress"
                    : "Awaiting verification"}
      </p>
      <p className="text-sm">
        {props.quantity} {props.quantity === 1 ? "item" : "items"} ·{" "}
        {props.handedOut
          ? "Handout recorded"
          : props.paymentVerified
            ? props.free
              ? "Free pickup verified"
              : "Goods payment verified"
            : props.free
              ? "No payment required"
              : "Goods payment not yet verified"}
      </p>
      {props.merchandise?.state === "ready" ? (
        <section aria-label="Items to hand out" className="space-y-2">
          <h4 className="text-sm font-medium">Items to hand out</h4>
          <ul className="space-y-3">
            {props.merchandise.lines.map((line) => (
              <li
                key={line.productCoordinate}
                className="flex min-w-0 items-start justify-between gap-3 text-sm"
              >
                <div className="min-w-0 break-words">
                  <p className="font-medium">
                    {line.familyTitle ?? line.title}
                  </p>
                  {line.familyTitle && line.familyTitle !== line.title ? (
                    <p className="text-[var(--text-secondary)]">{line.title}</p>
                  ) : null}
                  {line.specifications.map((specification) => (
                    <p
                      key={JSON.stringify([
                        specification.key,
                        specification.value,
                      ])}
                      className="text-[var(--text-secondary)]"
                    >
                      {specification.key}: {specification.value}
                    </p>
                  ))}
                </div>
                <span className="shrink-0 tabular-nums">
                  Qty {line.quantity}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p role="status" className="text-sm text-[var(--warning-text)]">
          Exact item details are unavailable. Reopen this saved order before
          handing out goods.
        </p>
      )}
      {props.routing ? (
        <>
          {props.free ? (
            <p role="status" className="text-sm">
              Checking free pickup…
            </p>
          ) : (
            <CheckoutPaymentProgress
              pausing={false}
              statusLabel="Completing this order…"
            />
          )}
          <Button type="button" variant="outline" onClick={props.onPause}>
            Pause this order
          </Button>
        </>
      ) : props.handedOut ? (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            Do not hand these goods out again. You can retry the same saved
            private update.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={props.onRetryHandout}
          >
            Retry saved handout update
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            {props.free
              ? "Check reserves this complete free order from your entrusted stock. No wallet, invoice or payment is needed."
              : "Continue reserves this complete order from your entrusted stock, then checks and finishes its existing payments. It never charges the buyer again."}
          </p>
          <Button
            type="button"
            disabled={props.waitingForBuyer || props.historyReady === false}
            onClick={props.onContinue}
          >
            {props.free
              ? props.paymentVerified
                ? "Recheck free pickup"
                : "Check free pickup"
              : props.paymentVerified
                ? "Recheck payments"
                : "Continue this order"}
          </Button>
          {props.waitingForBuyer ? (
            <p className="text-sm text-[var(--text-secondary)]">
              The buyer still has time to finish routing. Organizer recovery
              starts after the saved takeover time.
            </p>
          ) : null}
          {props.historyReady === false && !props.error ? (
            <p role="status" className="text-sm text-[var(--text-secondary)]">
              Checking saved handout history before continuing…
            </p>
          ) : null}
          {props.paymentVerified ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                props.onHandout()
              }}
            >
              <p className="text-sm text-[var(--success-text)]">
                {props.free
                  ? "This exact free pickup is verified. No payment is required. Check the buyer's pickup code before releasing anything."
                  : "The exact required goods payments are verified. Check the buyer's pickup code before releasing anything."}
              </p>
              <Field label="Buyer's pickup code">
                {(control) => (
                  <Input
                    {...control}
                    value={props.claimCode}
                    onChange={(event) => props.onClaimCode(event.target.value)}
                    autoCapitalize="characters"
                    autoComplete="off"
                  />
                )}
              </Field>
              <Button
                type="submit"
                disabled={
                  !props.claimCode.trim() ||
                  props.historyReady === false ||
                  props.merchandise?.state !== "ready"
                }
              >
                Confirm code and hand out once
              </Button>
            </form>
          ) : null}
        </>
      )}
      {props.notice ? (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          {props.notice}
        </p>
      ) : null}
      {props.error ? (
        <p role="alert" className="text-sm text-[var(--error-text)]">
          {props.error}
        </p>
      ) : null}
    </section>
  )
}

export function EventMarketOrganizerPickupCard(props: {
  authority: EventMarketOrganizerPurchaseAuthority
  authenticatedPubkey: string
  onBusy?(busy: boolean): void
}) {
  const { authGeneration, isAuthGenerationCurrent } = useAuth()
  const [commerceProof, setCommerceProof] =
    useState<CheckoutSparkOrganizerCommerceProof | null>(null)
  const [claimCode, setClaimCode] = useState("")
  const [routing, setRouting] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [waitingReason, setWaitingReason] = useState<string | undefined>()
  const running = useRef(false),
    paused = useRef(false)
  let purchase: ReturnType<
    typeof assertEventMarketOrganizerPurchaseAuthority
  > | null = null
  let takeoverAt: number | undefined
  try {
    purchase = assertEventMarketOrganizerPurchaseAuthority(props.authority)
    if (purchase.kind === "routed") {
      takeoverAt = assertCheckoutSparkOrganizerRecoveryAuthority(
        props.authority as CheckoutSparkOrganizerRecoveryAuthority
      ).plan.takeoverAt
    }
  } catch {
    purchase = null
    /* Reopen the exact selected recovery; never refresh its financial terms. */
  }
  const timeBoundaries = useMemo(
    () => (takeoverAt === undefined ? [] : [takeoverAt]),
    [takeoverAt]
  )
  const nowMs = useTimeBoundaryNow(timeBoundaries)
  const waitingForBuyer = takeoverAt !== undefined && nowMs < takeoverAt
  const saved = useQuery({
    queryKey: [
      "organizer-stock-handout",
      props.authenticatedPubkey,
      purchase?.orderId,
      purchase?.handoffId,
      authGeneration,
    ],
    queryFn: async () => {
      const exact = assertEventMarketOrganizerPurchaseAuthority(props.authority)
      const entries = await Promise.all(
        exact.writerBindings.map((binding) =>
          db.eventMarketOrganizerStockEntries
            .where("[accountPubkey+poolId+orderId]")
            .equals([props.authenticatedPubkey, binding.poolId, exact.orderId])
            .first()
        )
      )
      assertEventMarketOrganizerPurchaseAuthority(props.authority)
      return entries.filter((entry) => entry !== undefined)
    },
    enabled: !!purchase,
    retry: false,
  })
  const handedOut =
    saved.data?.some((entry) => entry.handout !== undefined) ?? false
  let paymentVerified = false
  if (purchase && commerceProof) {
    try {
      assertCheckoutSparkOrganizerCommerceProof(commerceProof, {
        organizerPubkey: props.authenticatedPubkey,
        orderId: purchase.orderId,
        merchantPubkey: purchase.merchantPubkey,
        orderBinding: purchase.orderBinding,
        initialHandoffId: purchase.handoffId,
      })
      paymentVerified = true
    } catch {
      /* Expired or changed proof cannot release goods. */
    }
  }
  const current = () =>
    !paused.current && isAuthGenerationCurrent(authGeneration)
  function session() {
    const signer = getAccountSigner()
    if (!signer || signer.pubkey !== props.authenticatedPubkey || !current())
      throw new Error("Reconnect the organizer signer.")
    return {
      db,
      signer,
      authenticatedPubkey: props.authenticatedPubkey,
      shouldContinue: current,
    }
  }
  async function run(action: "route" | "handout" | "retry") {
    if (running.current || !purchase) return
    running.current = true
    props.onBusy?.(true)
    paused.current = false
    setRouting(true)
    setError("")
    setNotice("")
    setWaitingReason(undefined)
    try {
      const input = session()
      if (action === "route") {
        setCommerceProof(null)
        const result = await continueEventMarketOrganizerPickup({
          ...input,
          authority: props.authority,
        })
        if (current()) {
          setCommerceProof(result.commerceProof)
          setWaitingReason(
            result.status === "waiting" ? result.reason : undefined
          )
          setNotice(
            result.status === "complete"
              ? purchase.kind === "free"
                ? "Free pickup checked and stock reserved. Confirm the buyer's pickup code before handout."
                : "Payment routing is complete. The recovery evidence remains saved; physical handout is a separate action."
              : result.reason === "funding_wait"
                ? "The original funding payment has not been verified yet. Continue checks this same payment; do not pay again."
                : "The saved payment is still being checked. Continue verifies any possible send first; do not create another payment."
          )
        }
      } else if (action === "handout") {
        if (!commerceProof) throw new Error("Verify this exact pickup first.")
        await confirmOrganizerStockOrderHandout({
          ...input,
          authority: props.authority,
          commerceProof,
          enteredClaimCode: claimCode,
          physicalReleaseConfirmed: true,
        })
        if (current())
          setNotice(
            "Handout recorded once; the exact private update was submitted to the seller."
          )
      } else {
        await retryOrganizerStockOrderHandout({
          ...input,
          orderId: purchase.orderId,
        })
        if (current())
          setNotice(
            "Retried the same saved handout update. Do not release the goods again."
          )
      }
    } catch (cause) {
      if (isAuthGenerationCurrent(authGeneration))
        setError(
          paused.current
            ? purchase.kind === "free"
              ? "This pickup check is paused. Its saved stock and handout history are preserved."
              : "This order is paused. A possibly sent payment is checked before any continuation."
            : message(cause)
        )
    } finally {
      if (isAuthGenerationCurrent(authGeneration)) await saved.refetch()
      running.current = false
      setRouting(false)
      props.onBusy?.(false)
    }
  }
  if (!purchase)
    return (
      <p role="status" className="text-sm text-[var(--warning-text)]">
        This pickup session expired or changed. Reopen the saved order to
        continue from its exact history.
      </p>
    )
  return (
    <EventMarketOrganizerPickupForm
      orderLabel={purchase.orderId.slice(-8)}
      quantity={purchase.writerBindings.reduce(
        (total, row) => total + row.quantity,
        0
      )}
      merchandise={purchase.merchandise}
      routing={routing}
      free={purchase.kind === "free"}
      historyReady={saved.isSuccess}
      paymentVerified={paymentVerified}
      handedOut={handedOut}
      waitingForBuyer={waitingForBuyer}
      waitingForFunding={waitingReason === "funding_wait"}
      needsAttention={
        !!error || (!!waitingReason && waitingReason !== "funding_wait")
      }
      claimCode={claimCode}
      error={
        error ||
        (saved.isError
          ? "Saved handout history could not be checked. Do not release goods."
          : undefined)
      }
      notice={notice}
      onClaimCode={setClaimCode}
      onContinue={() => void run("route")}
      onPause={() => {
        paused.current = true
      }}
      onHandout={() => {
        if (saved.isSuccess) void run("handout")
      }}
      onRetryHandout={() => void run("retry")}
    />
  )
}

export function EventMarketOrganizerRecoveryDiscoveryNotice(props: {
  missingInitialCheckouts: number
  selectionCount: number
  conflictingCheckouts: number
  capped: boolean
}) {
  const missingInitialNotice =
    props.missingInitialCheckouts > 0
      ? "Payment updates are saved, but the original recovery message is not available in this inbox view. Refresh or load older saved event orders before continuing. Do not pay again."
      : null
  if (props.conflictingCheckouts > 0 || props.capped)
    return (
      <p role="status" className="text-sm text-[var(--warning-text)]">
        Some event checkout history needs reconciliation before another action.
        {missingInitialNotice ? ` ${missingInitialNotice}` : null}
      </p>
    )
  if (missingInitialNotice)
    return (
      <p role="status" className="text-sm text-[var(--warning-text)]">
        {missingInitialNotice}
      </p>
    )
  return props.selectionCount === 0 ? (
    <p className="text-sm text-[var(--text-secondary)]">
      No event pickup or checkout recovery is saved in the current inbox view.
      This does not prove no older order exists.
    </p>
  ) : null
}

export function EventMarketOrganizerRecoveryQueue(props: {
  authenticatedPubkey: string
  marketCoordinate: string
  writerId: string
}) {
  const { authGeneration, isAuthGenerationCurrent } = useAuth()
  const [opened, setOpened] = useState<
    Record<
      string,
      { authority: EventMarketOrganizerPurchaseAuthority; instanceId: string }
    >
  >({})
  const [routing, setRouting] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const current = () => isAuthGenerationCurrent(authGeneration)
  const query = useQuery({
    queryKey: [
      "organizer-checkout-recovery",
      props.authenticatedPubkey,
      props.marketCoordinate,
      props.writerId,
      authGeneration,
    ],
    queryFn: () =>
      readRetainedCheckoutSparkOrganizerRecoveries({
        inbox: getCommerceInbox(props.authenticatedPubkey),
        marketCoordinate: props.marketCoordinate,
        shouldContinue: current,
      }),
    retry: false,
  })
  async function open(
    selection:
      CheckoutSparkOrganizerRecoverySelection | EventMarketFreePurchaseSelection
  ) {
    if (busy || routing) return
    setBusy(true)
    setError("")
    try {
      const signer = getAccountSigner()
      if (!signer || signer.pubkey !== props.authenticatedPubkey)
        throw new Error("Connect the organizer signer.")
      const common = {
        db,
        signer,
        authenticatedPubkey: props.authenticatedPubkey,
        writerId: props.writerId,
        shouldContinue: current,
      }
      const free = "signedRecipientWrap" in selection
      const authority = free
        ? await openEventMarketFreePurchaseAuthority({
            ...common,
            signedRecipientWrap: selection.signedRecipientWrap,
          })
        : await openCheckoutSparkOrganizerRecoveryAuthority({
            ...selection,
            ...common,
          })
      const key = free
        ? `free:${selection.handoffId}`
        : `routed:${selection.checkoutId}`
      if (current())
        setOpened((prior) => ({
          ...prior,
          [key]: {
            authority,
            instanceId: crypto.randomUUID(),
          },
        }))
    } catch (cause) {
      if (current()) setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  const choices = [
    ...(query.data?.selections ?? []).map((selection) => ({
      key: `routed:${selection.checkoutId}`,
      selection,
      free: false,
    })),
    ...(query.data?.freeSelections ?? []).map((selection) => ({
      key: `free:${selection.handoffId}`,
      selection,
      free: true,
    })),
  ]
  async function refresh(older = false) {
    if (busy || routing) return
    setBusy(true)
    setError("")
    try {
      const inbox = getCommerceInbox(props.authenticatedPubkey)
      if (older) await inbox.loadOlder()
      else await inbox.refreshRecent()
      if (current()) await query.refetch()
    } catch (cause) {
      if (current()) setError(message(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organizer pickups and recovery</CardTitle>
        <CardDescription>
          Check free pickups or finish an existing event payment from the
          designated device, then verify the buyer's pickup code. Receiving an
          organizer fee is never proof that the goods were paid for.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <Button
          type="button"
          variant="outline"
          disabled={busy || routing}
          onClick={() => void refresh()}
        >
          Refresh saved event orders
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || routing}
          onClick={() => void refresh(true)}
        >
          Load older saved event orders
        </Button>
        {choices.map(({ key, selection, free }) => (
          <div key={key} className="space-y-3">
            <Button
              type="button"
              variant="outline"
              disabled={busy || routing}
              onClick={() => void open(selection)}
            >
              Open {free ? "free pickup" : "saved order"}{" "}
              {selection.orderId.slice(-8)}
            </Button>
            {opened[key] ? (
              <EventMarketOrganizerPickupCard
                key={opened[key]!.instanceId}
                authority={opened[key]!.authority}
                authenticatedPubkey={props.authenticatedPubkey}
                onBusy={setRouting}
              />
            ) : null}
          </div>
        ))}
        {query.data ? (
          <EventMarketOrganizerRecoveryDiscoveryNotice
            missingInitialCheckouts={query.data.missingInitialCheckouts}
            selectionCount={choices.length}
            conflictingCheckouts={query.data.conflictingCheckouts}
            capped={query.data.capped}
          />
        ) : null}
        {error || query.isError ? (
          <p role="alert" className="text-sm text-[var(--error-text)]">
            {error || "Event checkout recovery could not be checked."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The saved organizer order could not continue. Do not create another payment."
}
