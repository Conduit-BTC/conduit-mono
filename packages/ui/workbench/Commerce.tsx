import { useState } from "react"
import { ArrowRight, Package } from "lucide-react"
import {
  ActionRow,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EventMarketCard,
  Field,
  Input,
  ProductCard,
  ProductCartAction,
  ProductCardSkeleton,
  SectionGrid,
  Skeleton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatePanel,
  StatusPill,
  SummaryList,
  SummaryRow,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@conduit/ui"

export type ExampleState = "ready" | "loading" | "empty" | "error" | "pending"
export const coffeeImage =
  "https://shop.conduit.market/images/placeholders/product.png"

export function Commerce({
  state,
  long,
}: {
  state: ExampleState
  long: boolean
}) {
  const [quantity, setQuantity] = useState(0)
  const [size, setSize] = useState("340")
  const [reviewed, setReviewed] = useState(false)
  const total = (
    Math.max(1, quantity) * (size === "680" ? 48000 : 24000)
  ).toLocaleString("en-US")
  if (state === "empty")
    return (
      <StatePanel
        title="Your cart is empty"
        description="Choose a product to start an order."
        action={
          <Button onClick={() => setReviewed(true)}>
            {reviewed ? "Catalog requested (demo)" : "Browse sample catalog"}
          </Button>
        }
      />
    )
  if (state === "error")
    return (
      <StatePanel
        tone="error"
        title="Availability could not be refreshed"
        description="Refresh availability before placing an order. An unavailable source is not proof that a product is sold out."
        action={
          <Button variant="outline" onClick={() => setReviewed(true)}>
            {reviewed ? "Refresh requested (demo)" : "Try again"}
          </Button>
        }
      />
    )
  return (
    <SectionGrid className="lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.85fr)]">
      <section className="space-y-4" aria-labelledby="products-heading">
        <h2
          id="products-heading"
          className="text-balance text-xl font-semibold"
        >
          Product cards
        </h2>
        <p className="text-pretty text-base text-[var(--text-secondary)]">
          Freshly roasted Colombian coffee in two bag sizes, ready for Saturday
          market pickup.
        </p>
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,8.5rem),1fr))] gap-2 sm:gap-4">
          {state === "loading" ? (
            <>
              <ProductCardSkeleton />
              <ProductCardSkeleton />
            </>
          ) : (
            <>
              <ProductCard
                title={
                  long
                    ? "Colombia coffee gift set, whole bean, medium roast with an exceptionally long catalog title"
                    : "Colombia coffee gift set"
                }
                merchantName={
                  long
                    ? "The very long neighborhood coffee collective and merchant"
                    : "Sample roastery"
                }
                images={[{ url: coffeeImage }]}
                primaryPrice="₿206,353"
                secondaryPrice="$170.00 USD"
                onActivate={() => setReviewed(true)}
                onMerchantActivate={() => setReviewed(true)}
                action={
                  <ProductCartAction
                    title="Colombia coffee gift set"
                    cartQuantity={0}
                    onAddToCart={() => setReviewed(true)}
                  />
                }
              />
              <ProductCard
                title={
                  long
                    ? "Windows Server 2025 RDS – 50 User / Device CAL with extended support"
                    : "Windows Server RDS – 50 User / Device CAL"
                }
                merchantName="Sample Roastery"
                images={[]}
                primaryPrice="₿95,047"
                secondaryPrice="€70.00 EUR"
                approximateUsdPrice="$78.30 USD"
                soldOut
                action={
                  <ProductCartAction
                    title="Windows Server RDS – 50 User / Device CAL"
                    cartQuantity={0}
                    soldOut
                    onAddToCart={() => undefined}
                  />
                }
              />
            </>
          )}
        </div>
        <h3 className="text-lg font-semibold">Product options</h3>
        <SampleProduct
          state={state}
          long={long}
          size={size}
          quantity={quantity}
          onSizeChange={setSize}
          onAdd={() => setQuantity(quantity + 1)}
          onRemove={() => setQuantity(Math.max(0, quantity - 1))}
        />
      </section>
      <CheckoutExample
        state={state}
        long={long}
        size={size}
        quantity={quantity}
        total={total}
        reviewed={reviewed}
        onReview={() => setReviewed(true)}
      />
    </SectionGrid>
  )
}

function SampleProduct({
  state,
  long,
  size,
  quantity,
  onSizeChange,
  onAdd,
  onRemove,
}: {
  state: ExampleState
  long: boolean
  size: string
  quantity: number
  onSizeChange: (size: string) => void
  onAdd: () => void
  onRemove: () => void
}) {
  return (
    <ProductCard
      title={
        long
          ? "Colombia whole-bean coffee, medium roast, carefully selected seasonal harvest in a reusable gift package"
          : "Colombia whole-bean coffee"
      }
      merchantName={
        long
          ? "The very long neighborhood coffee collective and roastery"
          : "Sample Roastery"
      }
      images={[{ url: coffeeImage }]}
      primaryPrice={size === "680" ? "48,000 sats" : "24,000 sats"}
      secondaryPrice={size === "680" ? "$48.00 USD" : "$24.00 USD"}
      disableImageHoverZoom
      options={
        <Field label="Bag size">
          {(props) => (
            <Select value={size} onValueChange={onSizeChange}>
              <SelectTrigger {...props}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="340">340 g</SelectItem>
                <SelectItem value="680">680 g</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
      }
      notice="Pickup at the Saturday market. Availability is checked at checkout."
      action={
        <ProductCartAction
          title={`${size} g Colombia whole-bean coffee`}
          cartQuantity={quantity}
          onAddToCart={onAdd}
          onIncrement={onAdd}
          onDecrement={onRemove}
          disabled={state === "pending"}
          disabledLabel="Checking…"
        />
      }
    />
  )
}

function CheckoutExample({
  state,
  long,
  size,
  quantity,
  total,
  reviewed,
  onReview,
}: {
  state: ExampleState
  long: boolean
  size: string
  quantity: number
  total: string
  reviewed: boolean
  onReview: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Checkout summary</CardTitle>
        <CardDescription>
          Review the items and fulfillment before placing an order.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {state === "loading" ? (
          <div
            role="status"
            aria-label="Loading checkout summary"
            className="space-y-4"
          >
            <Skeleton className="h-10 w-3/4" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-10 w-full" />
            <span className="sr-only">Loading checkout summary</span>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <Package aria-hidden="true" className="mt-1 size-5 shrink-0" />
              <div className="min-w-0">
                <p className="text-pretty font-medium">
                  {long
                    ? "Colombia whole-bean coffee, medium roast, seasonal harvest, 340 g reusable package"
                    : "Colombia whole-bean coffee"}
                </p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {size} g · Quantity {Math.max(1, quantity)}
                </p>
              </div>
            </div>
            <SummaryList>
              <SummaryRow label="Items">{total} sats</SummaryRow>
              <SummaryRow label="Pickup">Included</SummaryRow>
              <SummaryRow label="Total" total>
                {total} sats
              </SummaryRow>
            </SummaryList>
            <SummaryList>
              <SummaryRow label="Pickup location">
                {long
                  ? "Community hall, north entrance, ground floor collection desk beside the accessible courtyard entrance. Bring your order reference."
                  : "Community hall · North entrance"}
              </SummaryRow>
              <SummaryRow label="Pickup time">Saturday · 10 am–4 pm</SummaryRow>
            </SummaryList>
            {state === "pending" ? (
              <StatePanel
                tone="pending"
                title="Waiting for confirmation"
                description="Your order is pending. Delivery and payment are separate states."
              />
            ) : (
              <Button className="w-full" onClick={onReview}>
                Review sample order{" "}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Button>
            )}
            <p
              role="status"
              className="text-pretty text-base text-[var(--text-secondary)]"
            >
              {reviewed
                ? "Sample order reviewed. No order was placed and no payment was made."
                : "Demo only. This button opens no signer or payment flow."}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function Orders({ compact, long }: { compact: boolean; long: boolean }) {
  const [selected, setSelected] = useState("1042")
  const rows = [
    {
      id: "1042",
      status: "Confirmed paid",
      tone: "success" as const,
      amount: "24,000 sats",
    },
    {
      id: "1041",
      status: "Proof received",
      tone: "info" as const,
      amount: "38,000 sats",
    },
    {
      id: "1040",
      status: "Awaiting payment",
      tone: "warning" as const,
      amount: "18,000 sats",
    },
  ]
  return (
    <section className="space-y-4" aria-labelledby="orders-heading">
      <h2 id="orders-heading" className="text-balance text-xl font-semibold">
        Orders and status
      </h2>
      <p className="text-pretty text-base text-[var(--text-secondary)]">
        Semantic table with a named, keyboard-scrollable region. Select a row
        using its button. Payment evidence remains distinct from confirmation.
      </p>
      <Table
        scrollLabel="Sample orders, scroll horizontally for all columns"
        density={compact ? "compact" : "comfortable"}
      >
        <TableCaption>
          Fictional orders · selected order {selected}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Customer / contents</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} data-selected={selected === row.id}>
              <TableCell>
                <Button
                  variant={selected === row.id ? "muted" : "ghost"}
                  aria-pressed={selected === row.id}
                  size="sm"
                  onClick={() => setSelected(row.id)}
                >
                  #{row.id}
                </Button>
              </TableCell>
              <TableCell>
                <p className="font-medium">Sample customer</p>
                <p className="max-w-sm text-pretty text-[var(--text-secondary)]">
                  {long
                    ? "Coffee sampler with an exceptionally long product description that remains readable without hiding the order amount or its status"
                    : "Colombia coffee · Pickup"}
                </p>
              </TableCell>
              <TableCell>
                <StatusPill variant={row.tone}>{row.status}</StatusPill>
              </TableCell>
              <TableCell className="whitespace-nowrap">{row.amount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <StatePanel
        tone="pending"
        title="Proof received is awaiting verification"
        description="The status label describes the evidence available. A successful message delivery does not establish payment confirmation."
      />
    </section>
  )
}

export function Events({
  state,
  long,
  compact,
}: {
  state: ExampleState
  long: boolean
  compact: boolean
}) {
  const [notice, setNotice] = useState("")
  return (
    <SectionGrid>
      <section className="space-y-4" aria-labelledby="event-heading">
        <h2 id="event-heading" className="text-balance text-xl font-semibold">
          Event Market
        </h2>
        <EventMarketCard
          title={
            long
              ? "Saturday neighborhood market, independent makers and seasonal food collective"
              : "Saturday neighborhood market"
          }
          summary="Meet local makers, browse seasonal produce and pick up your weekly coffee."
          organizerName="Sample community collective"
          schedule="Saturday, October 17 · 10 am–4 pm"
          location="Community hall · North entrance"
          statusLabel="Upcoming"
          topics={["Coffee", "Crafts", "Local pickup"]}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNotice("Sample event selected")}
            >
              View event
            </Button>
          }
        />
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          {notice}
        </p>
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Inventory assignment</CardTitle>
          <CardDescription>
            Presentation of occurrence-specific stock. These controls are sample
            state only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state === "loading" ? (
            <>
              <ProductCardSkeleton />
              <p role="status">Loading sample inventory…</p>
            </>
          ) : state === "empty" ? (
            <StatePanel
              title="No products assigned"
              description="Choose existing inventory for this occurrence."
              action={
                <Button
                  onClick={() => setNotice("Sample inventory picker opened")}
                >
                  Choose inventory
                </Button>
              }
            />
          ) : state === "error" ? (
            <StatePanel
              tone="error"
              title="Inventory is unavailable"
              description="Stock could not be loaded. Refresh to check availability; unavailable data must not be treated as zero inventory."
              action={
                <Button
                  variant="outline"
                  onClick={() => setNotice("Sample refresh requested")}
                >
                  Refresh inventory
                </Button>
              }
            />
          ) : (
            <>
              <InventoryRows
                state={state}
                compact={compact}
                onNotice={setNotice}
              />
            </>
          )}
        </CardContent>
      </Card>
    </SectionGrid>
  )
}

function InventoryRows({
  state,
  compact,
  onNotice,
}: {
  state: ExampleState
  compact: boolean
  onNotice: (message: string) => void
}) {
  const [assigned, setAssigned] = useState(true)
  return (
    <>
      <ActionRow>
        <StatusPill variant={state === "pending" ? "warning" : "success"}>
          {state === "pending" ? "Assignment pending" : "Assignment confirmed"}
        </StatusPill>
        <span className="text-sm tabular-nums text-[var(--text-secondary)]">
          12 available
        </span>
      </ActionRow>
      <Table
        scrollLabel="Sample inventory allocation"
        density={compact ? "compact" : "comfortable"}
      >
        <TableCaption>Stock for this occurrence</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Assigned</TableHead>
            <TableHead>Quantity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-selected={assigned}>
            <TableCell>
              Colombia coffee
              <p className="text-sm text-[var(--text-secondary)]">340 g bag</p>
            </TableCell>
            <TableCell>
              <Checkbox
                aria-label="Assign Colombia coffee"
                checked={assigned}
                onCheckedChange={setAssigned}
                disabled={state === "pending"}
              />
            </TableCell>
            <TableCell>
              <Input
                aria-label="Allocated quantity"
                type="number"
                min={0}
                max={12}
                defaultValue={6}
                disabled={!assigned || state === "pending"}
                className="w-20"
              />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p className="text-pretty text-base text-[var(--text-secondary)]">
        Display availability is not checkout authority. Feature code supplies
        verified assignment and stock evidence.
      </p>
      <Button
        disabled={state === "pending"}
        aria-busy={state === "pending"}
        onClick={() =>
          onNotice("Sample assignment reviewed. Nothing published.")
        }
      >
        {state === "pending"
          ? "Waiting for confirmation…"
          : "Review assignment"}
      </Button>
    </>
  )
}
