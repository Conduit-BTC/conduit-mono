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
import { useState } from "react"

import {
  ProductGridCard,
  PRODUCT_GRID_CLASS_NAME,
} from "../components/ProductGridCard"

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
    images: [{ url: "https://cdn.conduit.market/variation-fixture.jpg" }],
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
    const [ready, setReady] = useState(true)
    return (
      <>
        <button type="button" onClick={() => setReady((value) => !value)}>
          Toggle variation availability
        </button>
        <ul
          data-testid="product-variation-grid"
          className={PRODUCT_GRID_CLASS_NAME}
        >
          <li data-testid="variable-product-list-item">
            <ProductGridCard
              product={parent}
              family={ready ? preparedFamily : undefined}
              familyHydrating={!ready}
              merchantName="Conduit Merchant"
              onProductActivate={() => undefined}
            />
          </li>
          <li data-testid="simple-product-sibling">
            <ProductGridCard
              product={sibling}
              merchantName="Conduit Merchant"
              notice="Checking current signed event pickup evidence before this listing can be added."
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
      </>
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
