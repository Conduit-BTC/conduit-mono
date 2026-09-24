import { useQuery } from "@tanstack/react-query"
import { readEventMarketCatalog, useConduitSession } from "@conduit/core"
import { Button } from "@conduit/ui"
import { PRODUCT_GRID_CLASS_NAME, ProductGridCard } from "./ProductGridCard"

/** The future contract has a separate signed admission path from legacy collections. */
export function FutureEventMarketPage({ reference }: { reference: string }) {
  const session = useConduitSession()
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const query = useQuery({
    queryKey: [
      "future-event-market",
      reference,
      session.relayScope,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      readEventMarketCatalog({ reference, authenticatedPubkey, signal }),
    enabled: session.relaySettingsReady,
    retry: false,
  })
  const catalog = query.data
  const market = catalog?.marketRead.resolution
  const current = market?.state === "current" ? market.market : null
  const calendar = catalog?.marketRead.calendar
  const eligible =
    catalog?.products.filter(
      (entry) => entry.resolution.state === "eligible"
    ) ?? []
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold">
          {calendar?.title ?? "Event Market"}
        </h1>
        {current ? (
          <p className="text-[var(--text-muted)]">
            {current.state === "open" ? "Open" : "Closed"} ·{" "}
            {current.merchants.length} approved shops
          </p>
        ) : null}
      </div>
      {query.isPending ? (
        <p>Checking signed event and merchant records…</p>
      ) : null}
      {query.isError ? (
        <p role="alert">Event records could not be checked. Try again.</p>
      ) : null}
      {catalog &&
      (catalog.coverage !== "complete" ||
        catalog.marketRead.coverage !== "complete") ? (
        <p role="status" className="rounded-lg border border-amber-500/50 p-4">
          Relay evidence is incomplete. More current products or participation
          changes may exist.
        </p>
      ) : null}
      {market?.state === "current" && current?.state === "closed" ? (
        <p>This Event Market is closed to new purchases.</p>
      ) : null}
      {market && market.state !== "current" ? (
        <p role="status">
          The current signed Event Market record is unavailable.
        </p>
      ) : null}
      {current && !calendar && !query.isPending ? (
        <p role="status">
          The linked event record is unavailable. Refresh event records before
          checking products.
        </p>
      ) : null}
      {current &&
      calendar &&
      eligible.length === 0 &&
      catalog?.coverage === "complete" &&
      !query.isPending ? (
        <p>No eligible products were found in the checked relay evidence.</p>
      ) : null}
      {eligible.length > 0 ? (
        <>
          <p role="status">Purchases are not available for this event yet.</p>
          <ul className={PRODUCT_GRID_CLASS_NAME}>
            {eligible.map((entry) => {
              if (entry.resolution.state !== "eligible") return null
              const { product, merchant } = entry.resolution
              return (
                <li key={entry.productCoordinate}>
                  <ProductGridCard
                    product={product}
                    merchantName={merchant.pubkey.slice(0, 12)}
                    notice={
                      <span>
                        {merchant.mode === "merchant_present"
                          ? "Merchant booth"
                          : "Organizer pickup"}
                        {": "}
                        {merchant.assignment}
                      </span>
                    }
                    onProductActivate={null}
                  />
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
      <Button
        variant="outline"
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
      >
        Refresh event records
      </Button>
    </div>
  )
}
