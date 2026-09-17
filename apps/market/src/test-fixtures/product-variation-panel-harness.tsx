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

import {
  EventActorName,
  EventActorProvenance,
} from "../components/EventActorIdentity"

const MERCHANT_PUBKEY = "a".repeat(64)
const FAMILY_ID = `30402:${MERCHANT_PUBKEY}:conduit-shirt`
const ZERO_AXIS_FAMILY_ID = `30402:${MERCHANT_PUBKEY}:conduit-mug`

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
      price: index === 0 ? 40_000 : 25_000,
      type: "variation",
      parentProductId: FAMILY_ID,
      specifications: [{ key: "size", value: size }],
      stock: index === 0 ? 1 : 2,
      images: [
        {
          url: `https://cdn.conduit.market/variation-${size.toLowerCase()}.jpg`,
          alt: `Conduit Shirt ${size}`,
        },
      ],
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
  const zeroAxisParent = product({
    id: ZERO_AXIS_FAMILY_ID,
    title: "Conduit Mug",
    type: "variable",
  })
  const zeroAxisChild = product({
    id: `${ZERO_AXIS_FAMILY_ID}-child`,
    title: "Conduit Mug",
    price: 30_000,
    type: "variation",
    parentProductId: ZERO_AXIS_FAMILY_ID,
    stock: 3,
  })
  const zeroAxisFamily = requirePreparedFamily(
    prepareProductCatalog([zeroAxisParent, zeroAxisChild].map(record), {
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
    const [quantities, setQuantities] = useState<Record<string, number>>({})
    const addSelection = (selection: Product) => {
      container.dataset.addedProduct = JSON.stringify({
        id: selection.id,
        title: selection.title,
        price: selection.price,
        currency: selection.currency,
        stock: selection.stock,
        image: selection.images[0]?.url ?? null,
        specifications: selection.specifications,
      })
      setQuantities((current) => ({
        ...current,
        [selection.id]: (current[selection.id] ?? 0) + 1,
      }))
    }
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
              pricePreference={{ currency: "BITCOIN", bitcoinUnit: "sats" }}
              getCartQuantity={(selection) => quantities[selection.id] ?? 0}
              onAddToCart={addSelection}
              onIncrement={addSelection}
              onDecrement={(selection) =>
                setQuantities((current) => ({
                  ...current,
                  [selection.id]: Math.max(0, (current[selection.id] ?? 0) - 1),
                }))
              }
            />
          </li>
          <li data-testid="simple-product-sibling">
            <ProductGridCard
              product={sibling}
              merchantName="Conduit Merchant"
              notice={
                <>
                  Checking current signed event pickup evidence before this
                  listing can be added.
                  <EventActorName
                    identity={{ displayName: "Fixture pickup handler" }}
                  />
                  <EventActorProvenance
                    pubkey={MERCHANT_PUBKEY}
                    copyLabel="Copy pickup handler npub"
                  />
                </>
              }
              onProductActivate={() => {
                container.dataset.productActivations = String(
                  Number(container.dataset.productActivations ?? "0") + 1
                )
              }}
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
          <li data-testid="zero-axis-variable-product-list-item">
            <ProductGridCard
              product={zeroAxisParent}
              family={zeroAxisFamily}
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
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/u/$profileRef",
    component: () => (
      <div data-testid="fixture-profile-page">Profile route</div>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([productRoute, profileRoute]),
    history: createMemoryHistory({ initialEntries: ["/products"] }),
  })
  const root = createRoot(container)
  root.render(<RouterProvider router={router} />)
  return () => root.unmount()
}
