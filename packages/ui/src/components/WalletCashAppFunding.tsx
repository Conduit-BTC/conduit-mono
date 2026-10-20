import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  decodeLightningInvoiceMetadata,
  formatBitcoinBaseUnits,
  getCashAppLightningUrl,
  getShopperSatsDisplay,
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  type BtcUsdRateQuote,
  type WalletDescriptor,
} from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import type { SparkReceiveRequest } from "@conduit/core/wallets/spark-wallet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs"
import { Button } from "./Button"
import { Input } from "./Input"
import { Label } from "./Label"
import { InvoicePayment } from "./InvoicePayment"
import { useTimeBoundaryNow } from "../hooks/useTimeBoundaryNow"

type FundingRequest = SparkReceiveRequest & { amountSats: number }
type ReceiptStatus = "pending" | "received" | "failed" | "unavailable"

export function WalletCashAppFunding({
  walletId,
  wallets,
  current,
  ready,
  quote,
  onPendingChange,
}: {
  walletId: string
  wallets: Pick<
    UseWalletsReturn,
    "receiveSparkLightning" | "checkSparkReceive" | "refreshBalance"
  >
  current: () => boolean
  ready: boolean
  quote: BtcUsdRateQuote | null
  onPendingChange: (pending: boolean) => void
}) {
  const [amount, setAmount] = useState("")
  const [request, setRequest] = useState<FundingRequest | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [status, setStatus] = useState<ReceiptStatus>("pending")
  const [error, setError] = useState<string | null>(null)
  const preparingRef = useRef(false)
  const readyRef = useRef(ready)
  useLayoutEffect(() => {
    readyRef.current = ready
  }, [ready])
  const expiresAt = request
    ? decodeLightningInvoiceMetadata(request.paymentRequest).expiresAt
    : null
  const nowMs = useTimeBoundaryNow([
    ...(expiresAt === null ? [] : [expiresAt * 1000]),
    ...(quote ? [quote.fetchedAt + DEFAULT_PRICING_RATE_MAX_AGE_MS + 1] : []),
  ])
  const expired =
    expiresAt !== null && Math.max(nowMs, Date.now()) >= expiresAt * 1000
  const amountSats = Number(amount)
  const validAmount =
    Number.isSafeInteger(amountSats * 1000) &&
    Number.isInteger(amountSats) &&
    amountSats > 0
  const display = validAmount
    ? getShopperSatsDisplay(
        amountSats,
        { currency: "USD", bitcoinUnit: "sats" },
        quote,
        { nowMs: Math.max(nowMs, Date.now()) }
      )
    : null
  const checkReceive = wallets.checkSparkReceive
  const refreshBalance = wallets.refreshBalance
  const [checkRevision, setCheckRevision] = useState(0)

  const terminal = status === "received"
  const checkReceipt = useCallback(
    async (observation: { active: boolean; checking: boolean }) => {
      if (
        !request ||
        !observation.active ||
        observation.checking ||
        !current() ||
        !readyRef.current ||
        document.visibilityState !== "visible"
      )
        return
      observation.checking = true
      try {
        const next = await checkReceive(walletId, request)
        if (!observation.active || !current() || !readyRef.current) return
        setStatus(next)
        if (next === "received") {
          try {
            await refreshBalance(walletId)
          } catch {
            if (observation.active && current())
              setError(
                "Money received. Refresh the wallet balance when your connection returns."
              )
          }
        }
      } catch {
        if (observation.active && current() && readyRef.current)
          setStatus("unavailable")
      } finally {
        observation.checking = false
      }
    },
    [request, current, checkReceive, walletId, refreshBalance]
  )
  useEffect(() => {
    if (!request || terminal || !ready) return
    const observation = { active: true, checking: false }
    // Bounded foreground observation; expiry is never evidence of no funds.
    const deadline = Date.now() + 5 * 60_000
    const check = () => {
      void checkReceipt(observation)
    }
    check()
    const interval = window.setInterval(() => {
      if (Date.now() < deadline) check()
    }, 5000)
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", check)
    return () => {
      observation.active = false
      window.clearInterval(interval)
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", check)
    }
  }, [request, ready, checkReceipt, checkRevision, terminal])

  const canUseInvoice = useCallback(
    () =>
      !!request &&
      current() &&
      readyRef.current &&
      status !== "received" &&
      status !== "failed" &&
      !!getCashAppLightningUrl(request.paymentRequest, request.amountSats),
    [current, request, status]
  )

  async function prepare() {
    if (
      !current() ||
      !readyRef.current ||
      preparingRef.current ||
      !validAmount ||
      request
    )
      return
    preparingRef.current = true
    setPreparing(true)
    onPendingChange(true)
    setError(null)
    try {
      const result = await wallets.receiveSparkLightning(walletId, amountSats)
      if (!current() || !readyRef.current) return
      if (!getCashAppLightningUrl(result.paymentRequest, amountSats))
        throw new Error(
          "Cash App requires a valid mainnet invoice for this amount. Try Lightning receive instead."
        )
      setRequest({ ...result, amountSats })
      setStatus("pending")
    } catch {
      if (current())
        setError(
          "Could not prepare Cash App funding. Check the wallet connection and amount, then try again."
        )
    } finally {
      preparingRef.current = false
      if (current()) {
        setPreparing(false)
        onPendingChange(false)
      }
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        Add bitcoin to this wallet. Choose Cash in Cash App, if available. Cash
        App shows your final debit and any fees.
      </p>
      {!request ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="cash-app-amount">Amount in sats</Label>
            <Input
              id="cash-app-amount"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={amount}
              disabled={preparing || !ready}
              onChange={(event) => setAmount(event.target.value)}
              aria-describedby="cash-app-amount-help"
            />
            <p
              id="cash-app-amount-help"
              className="text-xs text-[var(--text-secondary)]"
            >
              {display?.state === "ready" && display.approximate
                ? `${display.primary} estimated. Cash App sets the final conversion rate.`
                : "Enter a whole-number amount. A fixed amount enables eligible Cash App funding options."}
            </p>
          </div>
          <Button
            onClick={() => void prepare()}
            disabled={!validAmount || preparing || !ready}
            aria-busy={preparing}
          >
            {preparing ? "Preparing…" : "Continue"}
          </Button>
        </>
      ) : (
        <>
          <FundingReceipt
            request={request}
            status={status}
            expired={expired}
            ready={ready}
            quote={quote}
            canUseInvoice={canUseInvoice}
            onCheck={() => setCheckRevision((value) => value + 1)}
          />
          <p className="text-xs text-[var(--text-secondary)]">
            You can close this dialog and check wallet history later. Closing it
            does not cancel a payment.
          </p>
        </>
      )}
      {!ready && <p role="status">Open this wallet again to continue.</p>}
      {error && (
        <p role="alert" className="text-sm text-[var(--text-secondary)]">
          {error}
        </p>
      )}
    </div>
  )
}

/** Keep both prepared receive requests while switching the presentation method. */
export function WalletReceiveMethods({
  wallet,
  wallets,
  current,
  pending,
  rateQuote,
  onPendingChange,
  children,
}: {
  wallet: WalletDescriptor | null
  wallets: UseWalletsReturn
  current: () => boolean
  pending: boolean
  rateQuote: BtcUsdRateQuote | null
  onPendingChange: (pending: boolean) => void
  children: ReactNode
}) {
  return (
    <Tabs defaultValue="lightning">
      <TabsList aria-label="Receive method">
        <TabsTrigger value="lightning" disabled={pending}>
          Lightning
        </TabsTrigger>
        {wallet?.network === "mainnet" && (
          <TabsTrigger value="cash-app" disabled={pending}>
            Cash App
          </TabsTrigger>
        )}
      </TabsList>
      <TabsContent
        value="cash-app"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        {wallet && (
          <WalletCashAppFunding
            walletId={wallet.id}
            wallets={wallets}
            current={current}
            ready={wallets.runtime[wallet.id]?.status === "ready"}
            quote={rateQuote}
            onPendingChange={onPendingChange}
          />
        )}
      </TabsContent>
      <TabsContent value="lightning">{children}</TabsContent>
    </Tabs>
  )
}

function FundingReceipt({
  request,
  status,
  expired,
  ready,
  quote,
  canUseInvoice,
  onCheck,
}: {
  request: FundingRequest
  status: ReceiptStatus
  expired: boolean
  ready: boolean
  quote: BtcUsdRateQuote | null
  canUseInvoice: () => boolean
  onCheck: () => void
}) {
  return (
    <>
      {status === "received" ? (
        <p role="status">Money received in this wallet.</p>
      ) : (
        <>
          <p role="status" className="text-sm text-[var(--text-secondary)]">
            {status === "failed"
              ? "This payment failed. Check wallet history before starting another deposit."
              : expired
                ? "This request expired. Check its status before starting another deposit."
                : status === "unavailable"
                  ? "Receipt status is unavailable. Check again or view wallet history before paying again."
                  : "Waiting for payment. Returning from Cash App does not confirm receipt."}
          </p>
          {!expired && ready && status !== "failed" && (
            <InvoicePayment
              invoice={request.paymentRequest}
              expectedAmountSats={request.amountSats}
              preference={{ currency: "USD", bitcoinUnit: "sats" }}
              quote={quote}
              guestSession={false}
              cashAppLabel="Open Cash App"
              amountLabel="Amount to add"
              onBeforeInvoiceUse={canUseInvoice}
            />
          )}
          <p className="text-xs text-[var(--text-secondary)]">
            Wallet receive fee:{" "}
            {formatBitcoinBaseUnits(request.feeSats, "sats")}. Cash App may
            apply its own fees.
          </p>
          <Button variant="outline" onClick={onCheck} disabled={!ready}>
            Check deposit status
          </Button>
        </>
      )}
    </>
  )
}
