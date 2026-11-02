import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { LocalProductStockRecovery } from "../packages/core/src/protocol/local-product-stock"
import { OrderStockHistory } from "../apps/merchant/src/components/OrderStockHistory"
import { getOrderStockHistory } from "../apps/merchant/src/lib/order-stock-history"

// Display fixtures only: no signature, storage, publishing or retry authority.
function savedRecord(
  decision: LocalProductStockRecovery["checkpoint"]["state"],
  delivery: LocalProductStockRecovery["listingJob"]["state"],
  acknowledged = false
): LocalProductStockRecovery {
  return {
    checkpoint: { state: decision },
    signedEvent: { id: "display-fixture" },
    listingJob: {
      state: delivery,
      signedEvents: [{ id: "display-fixture" }],
      relayTargets: [{ relayUrl: "wss://relay.example.test" }],
      relayDelivery: [
        {
          eventId: "display-fixture",
          relayUrl: "wss://relay.example.test",
          status: acknowledged ? "acked" : "pending",
        },
      ],
    },
  } as LocalProductStockRecovery
}

describe("saved order stock history disclosure", () => {
  it("distinguishes checking, unavailable and a successful empty local read", () => {
    const checking = getOrderStockHistory({
      status: "pending",
      isFetching: true,
    })
    expect(checking).toEqual({ status: "checking" })
    expect(
      renderToStaticMarkup(<OrderStockHistory history={checking} />)
    ).toContain("Checking saved stock history")
    const unavailable = getOrderStockHistory({
      status: "error",
      isFetching: false,
    })
    expect(unavailable).toEqual({ status: "unavailable" })
    const unavailableMarkup = renderToStaticMarkup(
      <OrderStockHistory history={unavailable} />
    )
    expect(unavailableMarkup).toContain("could not be verified")
    expect(unavailableMarkup).not.toContain("No matching stock update")
    const emptyMarkup = renderToStaticMarkup(
      <OrderStockHistory
        history={getOrderStockHistory({
          status: "success",
          isFetching: false,
          data: [],
        })}
      />
    )
    expect(emptyMarkup).toContain(
      "No matching stock update record was found in this browser"
    )
    expect(emptyMarkup).toContain("does not prove that no update was published")
  })

  it("does not present cached rows as verified after a failed read or during refresh", () => {
    const data = [savedRecord("applied", "delivered", true)]
    expect(
      getOrderStockHistory({ status: "error", isFetching: false, data })
    ).toEqual({ status: "unavailable" })
    expect(
      getOrderStockHistory({ status: "success", isFetching: true, data })
    ).toEqual({ status: "checking" })
    expect(
      getOrderStockHistory({ status: "success", isFetching: false })
    ).toEqual({ status: "unavailable" })
  })

  it("keeps finalized decisions distinct from historical delivery acknowledgement", () => {
    const applied = savedRecord("applied", "delivered", true)
    applied.listingJob.localReplaySupersededBy = {
      "display-fixture": "later-display-revision",
    }
    const history = getOrderStockHistory({
      status: "success",
      isFetching: false,
      data: [
        applied,
        savedRecord("pending", "delivered"),
        savedRecord("unpublished", "failed"),
      ],
    })
    expect(history).toEqual({
      status: "loaded",
      records: [
        {
          decision: "Applied locally",
          delivery: "Recorded as delivered",
          acknowledged: true,
          superseded: true,
        },
        {
          decision: "Pending local decision",
          delivery: "Recorded as delivered",
          acknowledged: false,
          superseded: false,
        },
        {
          decision: "Recorded as unpublished",
          delivery: "Recorded as failed",
          acknowledged: false,
          superseded: false,
        },
      ],
    })
    const markup = renderToStaticMarkup(<OrderStockHistory history={history} />)
    expect(markup).toContain("Applied locally")
    expect(markup).toContain("Historical relay acknowledgement: Recorded")
    expect(markup).toContain("Historical relay acknowledgement: Not recorded")
    expect(markup).toContain("Later local change recorded: Yes")
    expect(markup).toContain("not a current stock read or permission to retry")
    expect(markup).not.toContain("display-fixture")
    expect(markup).not.toContain("relay.example.test")
    expect(markup).not.toContain("later-display-revision")
    expect(markup).not.toContain("<button")
    expect(markup).not.toContain("<input")
    expect(markup).not.toContain(" open=")
  })

  it("projects remaining ordinary delivery states without changing its input", () => {
    const data = [
      savedRecord("pending", "pending"),
      savedRecord("pending", "partial"),
      savedRecord("unpublished", "superseded_unpublished"),
    ]
    const before = JSON.stringify(data)
    expect(
      getOrderStockHistory({ status: "success", isFetching: false, data })
    ).toMatchObject({
      records: [
        { delivery: "Pending delivery" },
        { delivery: "Partial delivery" },
        { delivery: "Superseded before publication" },
      ],
    })
    expect(JSON.stringify(data)).toBe(before)
  })
})
