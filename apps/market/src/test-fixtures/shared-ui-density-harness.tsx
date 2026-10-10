import { useState } from "react"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { createRoot } from "react-dom/client"
import {
  getProductCardPriceDisplay,
  productSchema,
  type Product,
} from "@conduit/core"
import {
  Badge,
  Button,
  ProductCard,
  StatusPill,
  StatusStepper,
} from "@conduit/ui"
import {
  ProductGridCard,
  PRODUCT_GRID_CLASS_NAME,
} from "../components/ProductGridCard"

export function mountSharedUiDensityHarness(container: HTMLElement) {
  const product: Product = {
    id: `30402:${"a".repeat(64)}:density`,
    pubkey: "a".repeat(64),
    title:
      "Windows Server 2025 RDS – 50 User / Device CAL with an unusually long catalog title",
    price: 206353,
    currency: "SATS",
    type: "simple",
    format: "digital",
    visibility: "public",
    specifications: [],
    images: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
  }
  const rootRoute = createRootRoute()
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <>
        <ul data-testid="density-catalog" className={PRODUCT_GRID_CLASS_NAME}>
          {[0, 1].map((i) => (
            <li key={i}>
              <ProductGridCard
                product={{
                  ...product,
                  id: `${product.id}-${i}`,
                  stock: i === 1 ? 0 : 3,
                }}
                merchantName="The very long neighborhood merchant collective with several additional names"
                onAddToCart={() => undefined}
                onProductActivate={() => undefined}
              />
            </li>
          ))}
        </ul>
        <section data-testid="semantic-states" className="space-y-4 py-6">
          <StatusPill variant="success" data-testid="success-copy">
            Zap support detected
          </StatusPill>
          <Badge variant="success" data-testid="success-badge">
            Settings confirmed
          </Badge>
          <StatusPill variant="error" data-testid="error-copy">
            Unable to save
          </StatusPill>
          <p
            data-testid="validation-copy"
            className="text-xs text-[var(--error-text)]"
          >
            Required field
          </p>
          <Badge variant="destructive" data-testid="error-badge">
            Cancelled
          </Badge>
          <StatusPill variant="info" data-testid="info-copy">
            Network information
          </StatusPill>
          <Badge
            variant="secondary"
            data-testid="info-badge"
            className="border border-[var(--info)] bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[var(--info-text)]"
          >
            testnet
          </Badge>
          <StatusPill variant="warning" data-testid="warning-copy">
            Needs attention
          </StatusPill>
          <Button variant="destructive" data-testid="cancel-action">
            Cancel order
          </Button>
          <div data-testid="narrow-stepper" className="w-[182px] max-w-full">
            <StatusStepper
              rows={[
                { key: "placed", title: "Order placed", status: "complete" },
                {
                  key: "paid",
                  title: "Payment confirmed",
                  subtitle: "Settlement confirmed by merchant.",
                  status: "complete",
                },
                { key: "shipped", title: "Shipping", status: "in_progress" },
              ]}
            />
          </div>
        </section>
      </>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const root = createRoot(container)
  root.render(<RouterProvider router={router} />)
  return () => root.unmount()
}

const priceCases = [
  { price: 99_999_999, currency: "SATS" },
  { price: 100_000_000, currency: "SATS" },
  { price: 123_456_789, currency: "SATS" },
  { price: Number.MAX_SAFE_INTEGER, currency: "SATS" },
  { price: 100_300, currency: "USD" },
  { price: 1_403_000, currency: "USD" },
  { price: 1_403_000_000, currency: "USD" },
  { price: 999_950, currency: "USD" },
  { price: Number.MAX_VALUE, currency: "USD" },
  { price: 1_403_000, currency: "EUR" },
]
function PriceExample({
  price,
  currency,
}: {
  price: number
  currency: string
}) {
  const [quantity, setQuantity] = useState(0)
  const product = productSchema.parse({
    id: `price-${price}-${currency}`,
    pubkey: "a".repeat(64),
    title: "Large price",
    price,
    currency,
    images: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  })
  return (
    <ProductGridCard
      product={product}
      merchantName="Example merchant"
      pricePreference={{
        currency:
          currency === "EUR" ? "EUR" : currency === "USD" ? "USD" : "BITCOIN",
        bitcoinUnit: "bitcoin",
      }}
      cartQuantity={quantity}
      onAddToCart={() => setQuantity(1)}
      onIncrement={() => setQuantity((q) => q + 1)}
      onDecrement={() => setQuantity((q) => Math.max(0, q - 1))}
      onProductActivate={() => undefined}
      onMerchantActivate={() => undefined}
    />
  )
}
export function mountSharedUiPriceHarness(container: HTMLElement) {
  const rootRoute = createRootRoute()
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <section data-testid="compact-prices" className="space-y-4">
        {priceCases.map(({ price, currency }) => (
          <ul key={`${price}-${currency}`} className={PRODUCT_GRID_CLASS_NAME}>
            <li>
              <PriceExample price={price} currency={currency} />
            </li>
            <li>
              <PriceExample price={29132} currency="SATS" />
            </li>
          </ul>
        ))}
        <div data-testid="merchant-compact-price" className="w-40">
          <ProductCard
            title="Merchant price"
            merchantName="Example store"
            images={[]}
            {...(() => {
              const p = getProductCardPriceDisplay({
                price: 123456789,
                currency: "SATS",
              })
              return { primaryPrice: p.primary, secondaryPrice: p.secondary }
            })()}
            actionLayout="stacked"
            action={<Button size="sm">Edit</Button>}
          />
        </div>
      </section>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const root = createRoot(container)
  root.render(<RouterProvider router={router} />)
  return () => root.unmount()
}
