import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import {
  prepareProductCatalog,
  type CommerceProductRecord,
  type PreparedProductFamily,
  type Product,
} from "@conduit/core"
import { createRoot } from "react-dom/client"

import { ProductGridCard } from "../components/ProductGridCard"

const MERCHANT_PUBKEY = "a".repeat(64)
const FAMILY_ID = `30402:${MERCHANT_PUBKEY}:conduit-shirt`

function requirePreparedFamily(
  item:
    | ReturnType<
        typeof prepareProductCatalog<CommerceProductRecord>
      >["items"][number]
    | undefined
): PreparedProductFamily<CommerceProductRecord> {
  if (!item || item.kind !== "family") {
    throw new Error("Expected prepared product family")
  }
  return item.family
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: FAMILY_ID,
    pubkey: MERCHANT_PUBKEY,
    title: "Conduit Shirt",
    price: 25_000,
    currency: "SATS",
    type: "simple",
    specifications: [],
    format: "physical",
    visibility: "public",
    images: [],
    tags: ["shirt"],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function record(
  product: Product,
  eventCreatedAt: number
): CommerceProductRecord {
  return {
    product,
    addressId: product.id,
    eventId: `${product.id}-event`,
    eventCreatedAt,
    dTag: product.id.split(":").at(-1) ?? null,
  }
}

export function mountProductVariationPanelHarness(
  container: HTMLElement
): () => void {
  const parent = product({ type: "variable" })
  const variations = ["M", "L"].map((size, index) =>
    product({
      id: `${FAMILY_ID}-${size.toLowerCase()}`,
      title: `Conduit Shirt ${size}`,
      type: "variation",
      parentProductId: FAMILY_ID,
      specifications: [{ key: "size", value: size }],
      stock: index + 1,
    })
  )
  const preparedFamily = requirePreparedFamily(
    prepareProductCatalog([parent, ...variations].map(record), {
      source: "commerce",
      fetchedAt: 2,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
  )
  const sibling = product({
    id: `30402:${MERCHANT_PUBKEY}:cap`,
    title: "Conduit Cap",
  })

  function ProductVariationPanelProbe() {
    return (
      <ul
        data-testid="product-variation-grid"
        className="grid grid-cols-3 gap-4"
      >
        <li data-testid="variable-product-list-item">
          <ProductGridCard
            product={parent}
            family={preparedFamily}
            merchantName="Conduit Merchant"
            onProductActivate={() => undefined}
          />
        </li>
        <li data-testid="simple-product-sibling">
          <ProductGridCard
            product={sibling}
            merchantName="Conduit Merchant"
            onProductActivate={null}
          />
        </li>
        <li data-testid="hydrating-variable-product-list-item">
          <ProductGridCard
            product={parent}
            familyHydrating
            merchantName="Conduit Merchant"
            onProductActivate={() => undefined}
          />
        </li>
      </ul>
    )
  }

  const rootRoute = createRootRoute()
  const productRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/products",
    component: ProductVariationPanelProbe,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([productRoute]),
    history: createMemoryHistory({ initialEntries: ["/products"] }),
  })
  const root = createRoot(container)
  root.render(<RouterProvider router={router} />)
  return () => root.unmount()
}
