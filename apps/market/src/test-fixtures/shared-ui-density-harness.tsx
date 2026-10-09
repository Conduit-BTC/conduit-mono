import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { createRoot } from "react-dom/client"
import type { Product } from "@conduit/core"
import { Badge, Button, StatusPill, StatusStepper } from "@conduit/ui"
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
