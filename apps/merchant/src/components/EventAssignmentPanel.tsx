import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  type ProductSchema,
  readEventMarketRoster,
  readMerchantOccurrenceInventory,
  saveMerchantOccurrenceAssignment,
  resumeMerchantOccurrencePublication,
} from "@conduit/core"
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"

/** Assignment controls compose shared primitives; ordinary product editing stays separate. */
export function EventAssignmentPanel(props: {
  marketReference: string
  merchantPubkey: string
  authenticatedPubkey: string | null
  authGeneration: number
  shouldContinue: () => boolean
  products: ProductSchema[]
}) {
  const queryClient = useQueryClient()
  const [productCoordinate, setProductCoordinate] = useState("")
  const [occurrenceCoordinate, setOccurrenceCoordinate] = useState("")
  const [quantity, setQuantity] = useState("")
  const [filter, setFilter] = useState("all")
  const [notice, setNotice] = useState("")
  const queryKey = [
    "merchant-occurrence-inventory",
    props.merchantPubkey,
    props.authGeneration,
    props.marketReference,
  ]
  const market = useQuery({
    queryKey: [
      "merchant-assignment-market",
      props.marketReference,
      props.authenticatedPubkey,
      props.authGeneration,
    ],
    queryFn: ({ signal }) =>
      readEventMarketRoster({
        reference: props.marketReference,
        authenticatedPubkey: props.authenticatedPubkey,
        signal,
        shouldContinue: () => !signal.aborted && props.shouldContinue(),
      }),
    retry: false,
  })
  const inventory = useQuery({
    queryKey,
    queryFn: () => readMerchantOccurrenceInventory(props.merchantPubkey),
    retry: false,
  })
  const occurrences =
    market.data?.schedule?.kind === "series"
      ? market.data.schedule.occurrences.map((entry) => entry.occurrence)
      : market.data?.calendar
        ? [market.data.calendar]
        : []
  const selectedOccurrence = occurrences.find(
    (entry) => entry.coordinate === occurrenceCoordinate
  )
  const product = props.products.find((entry) => entry.id === productCoordinate)
  const assignments = (inventory.data ?? []).filter(
    (entry) =>
      entry.marketCoordinate === market.data?.coordinate &&
      (!occurrenceCoordinate ||
        entry.occurrenceCoordinate === occurrenceCoordinate)
  )
  const activeProducts = new Set(
    assignments
      .filter((entry) => entry.state === "active")
      .map((entry) => entry.productCoordinate)
  )
  const options = props.products.filter(
    (entry) =>
      entry.type !== "variable" &&
      (filter === "all" ||
        (filter === "assigned"
          ? activeProducts.has(entry.id)
          : !activeProducts.has(entry.id)))
  )
  const save = useMutation({
    mutationFn: async (remove: boolean) => {
      setNotice("")
      if (!product || !occurrenceCoordinate)
        throw new Error("Choose a product and event date.")
      if (
        !remove &&
        product.stock !== undefined &&
        !/^(0|[1-9][0-9]*)$/.test(quantity)
      )
        throw new Error("Enter a whole allocation quantity.")
      await saveMerchantOccurrenceAssignment({
        ...props,
        product,
        occurrenceCoordinate,
        quantity: product.stock === undefined ? undefined : Number(quantity),
        remove,
      })
      if (props.shouldContinue())
        setNotice(
          "Assignment saved on this device. Publication can be retried below."
        )
      await queryClient.invalidateQueries({ queryKey })
      return resumeMerchantOccurrencePublication(props)
    },
    onSuccess: async (result) => {
      if (props.shouldContinue())
        setNotice(
          result.pending
            ? "Saved locally. Publication is pending; retry when your signer and relays are available."
            : "Assignment published. Refresh the event to see it."
        )
      await queryClient.invalidateQueries({ queryKey })
    },
  })
  const retry = useMutation({
    mutationFn: () => resumeMerchantOccurrencePublication(props),
    onSuccess: async (result) => {
      if (props.shouldContinue())
        setNotice(
          result.pending
            ? "Some publication work is still pending."
            : "Saved inventory updates published."
        )
      await queryClient.invalidateQueries({ queryKey })
    },
  })
  const selectedAssignment = assignments.find(
    (entry) =>
      entry.productCoordinate === productCoordinate &&
      entry.occurrenceCoordinate === occurrenceCoordinate
  )
  const busy = save.isPending || retry.isPending
  return (
    <section
      className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
      aria-label="Occurrence assignments"
    >
      <div className="space-y-2">
        <h2 className="text-balance text-xl font-semibold">
          Assign products to an event date
        </h2>
        <p className="text-pretty text-sm text-[var(--text-secondary)]">
          Reserve existing stock for pickup. Product details and shop shipping
          stay intact. Each date has its own allocation.
        </p>
        <Button asChild variant="outline">
          <a href={`/events/${encodeURIComponent(props.marketReference)}`}>
            Back to event
          </a>
        </Button>
      </div>
      {market.isPending || inventory.isPending ? (
        <p role="status">Loading event and saved allocations…</p>
      ) : null}
      {market.isError || inventory.isError ? (
        <p role="alert">
          Saved inventory or event evidence could not be read. Refresh before
          assigning stock.
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="assignment-occurrence">Event date</Label>
          <Select
            value={occurrenceCoordinate}
            onValueChange={(value) => {
              setOccurrenceCoordinate(value)
              setQuantity("")
            }}
          >
            <SelectTrigger id="assignment-occurrence">
              <SelectValue placeholder="Choose a date" />
            </SelectTrigger>
            <SelectContent>
              {occurrences.map((entry) => (
                <SelectItem key={entry.coordinate} value={entry.coordinate}>
                  {entry.title} · {new Date(entry.start).toLocaleDateString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedOccurrence ? (
            <p className="text-pretty text-xs text-[var(--text-muted)]">
              Unused allocation releases at{" "}
              {new Date(selectedOccurrence.end).toISOString()} (UTC).
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="assignment-filter">Products shown</Label>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger id="assignment-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All shop products</SelectItem>
              <SelectItem value="assigned">Assigned to this date</SelectItem>
              <SelectItem value="available">Available to add</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="assignment-product">Product or variation</Label>
          <Select
            value={productCoordinate}
            onValueChange={(value) => {
              setProductCoordinate(value)
              const current = assignments.find(
                (entry) =>
                  entry.productCoordinate === value &&
                  entry.occurrenceCoordinate === occurrenceCoordinate
              )
              setQuantity(
                current?.quantity === undefined ? "" : String(current.quantity)
              )
            }}
          >
            <SelectTrigger id="assignment-product">
              <SelectValue placeholder="Choose an existing product" />
            </SelectTrigger>
            <SelectContent>
              {options.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.title}
                  {entry.specifications.length
                    ? ` · ${entry.specifications.map((spec) => spec.value).join(" / ")}`
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="assignment-quantity">Pickup allocation</Label>
          {product?.stock === undefined && product ? (
            <p>Untracked inventory. No finite quantity is promised.</p>
          ) : (
            <Input
              id="assignment-quantity"
              inputMode="numeric"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="Choose a quantity"
            />
          )}
          <p className="text-pretty text-xs text-[var(--text-muted)]">
            Pickup from the merchant. Organizer handout integration is not
            available here yet.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            busy || !product || !selectedOccurrence || inventory.isError
          }
          onClick={() => save.mutate(false)}
        >
          {selectedAssignment?.state === "active"
            ? "Save allocation"
            : "Add to event"}
        </Button>
        {selectedAssignment?.state === "active" ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => save.mutate(true)}
          >
            Remove assignment
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => retry.mutate()}
        >
          Retry publication
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-pretty text-sm">
          {notice}
        </p>
      ) : null}
      {save.error || retry.error ? (
        <p role="alert" className="text-pretty text-sm text-error">
          {(save.error ?? retry.error)?.message}
        </p>
      ) : null}
      <ul className="space-y-2 text-sm" aria-label="Saved allocations">
        {assignments.map((entry) => (
          <li
            key={entry.coordinate}
            className="flex flex-wrap justify-between gap-2 border-t border-[var(--border)] pt-2"
          >
            <span>
              {props.products.find(
                (item) => item.id === entry.productCoordinate
              )?.title ?? "Product"}
            </span>
            <span className="tabular-nums">
              {entry.state === "removed"
                ? "Removed"
                : entry.quantity === undefined
                  ? "Untracked"
                  : `${entry.quantity} allocated · ${entry.ordinaryAvailable ?? "unknown"} ordinary available`}
              {entry.pending ? " · publication pending" : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
