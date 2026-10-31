import type { OrderStockHistory as StockHistory } from "../lib/order-stock-history"

export function OrderStockHistory({ history }: { history: StockHistory }) {
  return (
    <details className="text-sm text-[var(--text-secondary)]">
      <summary className="cursor-pointer rounded-sm py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
        Saved stock update history
      </summary>
      <div className="space-y-3 py-2">
        <p>
          Local records for this account and order reference in this browser.
          Checking this history does not publish or change stock.
        </p>
        {history.status === "checking" ? (
          <p role="status">Checking saved stock history…</p>
        ) : history.status === "unavailable" ? (
          <p role="status">
            Saved stock history could not be verified. Do not repeat a stock
            update based on this result.
          </p>
        ) : history.records.length === 0 ? (
          <p>
            No matching stock update record was found in this browser. This does
            not prove that no update was published.
          </p>
        ) : (
          <ol className="list-decimal space-y-3 pl-5">
            {history.records.map((record, index) => (
              <li key={index}>
                <p>Saved decision: {record.decision}.</p>
                <p>Saved delivery: {record.delivery}.</p>
                <p>
                  Historical relay acknowledgement:{" "}
                  {record.acknowledged ? "Recorded" : "Not recorded"}.
                </p>
                <p>
                  Later local change recorded:{" "}
                  {record.superseded ? "Yes" : "Not recorded"}.
                </p>
              </li>
            ))}
          </ol>
        )}
        <p>
          Historical delivery is not a current stock read or permission to
          retry. It does not prove that every relay has the update.
        </p>
      </div>
    </details>
  )
}
