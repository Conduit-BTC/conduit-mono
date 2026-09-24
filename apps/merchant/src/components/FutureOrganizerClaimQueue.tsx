import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  formatEventMarketPickupClaimCode,
  getNdk,
  loadFutureMarketPrivateDeliveries,
  publishFutureMarketHandoffAck,
  readFutureMarketReadyReceipts,
  retryFutureMarketPrivateDelivery,
  saveFutureMarketPrivateDelivery,
  useAuth,
  type FutureMarketOrganizerClaim,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@conduit/ui"

function ClaimCard({
  claim,
  organizerPubkey,
  stale,
  onUpdated,
}: {
  claim: FutureMarketOrganizerClaim
  organizerPubkey: string
  stale: boolean
  onUpdated: () => void
}) {
  const {
    accountPubkey,
    pubkey,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
  } = useAuth()
  const [enteredCode, setEnteredCode] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [deliveryStatus, setDeliveryStatus] = useState("")
  const receipt = claim.receipt.payload
  const code = formatEventMarketPickupClaimCode(receipt.claimRef)
  let exactAck:
    ReturnType<typeof loadFutureMarketPrivateDeliveries>[number] | undefined
  let storageError = ""
  try {
    exactAck =
      accountPubkey === organizerPubkey
        ? loadFutureMarketPrivateDeliveries(organizerPubkey).find(
            (record) =>
              record.type === "future_market_handed_out" &&
              record.readyReceiptId === claim.receipt.id
          )
        : undefined
  } catch (cause) {
    storageError =
      cause instanceof Error
        ? cause.message
        : "Saved handoff recovery could not be read."
  }
  const signerReady =
    accountPubkey === organizerPubkey &&
    pubkey === organizerPubkey &&
    signerReadiness === "ready"
  const codeMatches = enteredCode.trim().toUpperCase() === code.toUpperCase()
  const canRelease =
    signerReady &&
    !stale &&
    claim.state === "ready_for_pickup" &&
    codeMatches &&
    !storageError &&
    !pending

  async function retryExactAck(): Promise<void> {
    if (
      !exactAck ||
      !signerReady ||
      stale ||
      pending ||
      claim.state === "revoked" ||
      claim.state === "conflicting"
    )
      return
    setPending(true)
    setError("")
    setDeliveryStatus("")
    try {
      const result = await retryFutureMarketPrivateDelivery({
        record: exactAck,
        authenticatedOwnerPubkey: organizerPubkey,
        shouldContinue: () => isAuthGenerationCurrent(authGeneration),
      })
      setDeliveryStatus(
        result.recipientDelivered
          ? "Exact handed-out update delivered."
          : "Exact update remains saved for retry."
      )
      onUpdated()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Exact handoff retry failed."
      )
    } finally {
      setPending(false)
    }
  }

  async function acknowledge(): Promise<void> {
    if (!canRelease) return
    if (exactAck) {
      await retryExactAck()
      return
    }
    setPending(true)
    setError("")
    setDeliveryStatus("")
    try {
      const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
      const ndk = getNdk()
      if (!ndk.signer)
        throw new Error("Connect the organizer signer to confirm handoff.")
      await publishFutureMarketHandoffAck({
        organizerPubkey,
        claim,
        physicalReleaseConfirmed: true,
        signer: ndk.signer,
        authenticatedPubkey: organizerPubkey,
        shouldContinue,
        persistExactWraps: (record) =>
          saveFutureMarketPrivateDelivery(organizerPubkey, record),
      })
      setDeliveryStatus("Handed-out update submitted privately.")
      onUpdated()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The private handoff update could not be sent."
      )
      onUpdated()
    } finally {
      setPending(false)
    }
  }

  return (
    <article className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
            Merchant
          </p>
          <p className="break-all text-sm font-medium">
            {receipt.merchantPubkey.slice(0, 16)}…
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Pickup code {code}
          </p>
        </div>
        <span className="text-xs font-medium capitalize">
          {claim.state.replaceAll("_", " ")}
        </span>
      </div>
      <p className="text-sm text-[var(--text-secondary)]">
        {receipt.items.reduce((count, item) => count + item.quantity, 0)}{" "}
        {receipt.items.length === 1 ? "item" : "items"} for this release. This
        claim carries physical handoff authority only.
      </p>
      {claim.state === "ready_for_pickup" ? (
        <div className="space-y-2">
          <Label htmlFor={`claim-code-${claim.receipt.id}`}>
            Confirm buyer pickup code
          </Label>
          <Input
            id={`claim-code-${claim.receipt.id}`}
            value={enteredCode}
            onChange={(event) => setEnteredCode(event.target.value)}
            autoComplete="off"
            placeholder="Enter code shown by buyer"
          />
          <Button
            type="button"
            disabled={!canRelease}
            onClick={() => void acknowledge()}
          >
            {exactAck ? "Retry exact handed-out update" : "Mark handed out"}
          </Button>
        </div>
      ) : null}
      {claim.state === "handed_out" && exactAck ? (
        <Button
          type="button"
          variant="outline"
          disabled={pending || stale || !signerReady}
          onClick={() => void retryExactAck()}
        >
          Retry exact delivery
        </Button>
      ) : null}
      {storageError ? (
        <p role="alert" className="text-sm text-[var(--destructive)]">
          {storageError}
        </p>
      ) : null}
      {stale ? (
        <p role="alert" className="text-sm text-[var(--warning)]">
          Private receipt evidence is stale. Refresh before physical release.
        </p>
      ) : null}
      {claim.state === "conflicting" ? (
        <p role="alert" className="text-sm text-[var(--warning)]">
          Conflicting private release evidence needs merchant review.
        </p>
      ) : null}
      {deliveryStatus ? (
        <p role="status" className="text-sm">
          {deliveryStatus}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-[var(--destructive)]">
          {error}
        </p>
      ) : null}
    </article>
  )
}

export function FutureOrganizerClaimQueue({
  organizerPubkey,
  marketCoordinate,
}: {
  organizerPubkey: string
  marketCoordinate: string
}) {
  const { accountPubkey, pubkey, signerReadiness } = useAuth()
  const authenticated =
    accountPubkey === organizerPubkey &&
    pubkey === organizerPubkey &&
    signerReadiness === "ready"
  const query = useQuery({
    queryKey: [
      "future-market-organizer-claims",
      organizerPubkey,
      marketCoordinate,
    ],
    queryFn: () =>
      readFutureMarketReadyReceipts({ organizerPubkey, marketCoordinate }),
    enabled: authenticated,
    retry: false,
    refetchInterval: 30_000,
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pickup handoffs</CardTitle>
        <CardDescription>
          Ready receipts give this organizer order-specific physical release
          authority. Payment and the full merchant order stay with the merchant.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!authenticated ? (
          <p>Connect the organizer signer to read private pickup claims.</p>
        ) : null}
        {query.isPending && authenticated ? (
          <p role="status">Checking private ready receipts…</p>
        ) : null}
        {query.isError ? (
          <p role="alert">
            Private ready receipts could not be checked. Retry before releasing
            an order.
          </p>
        ) : null}
        {query.data?.stale ? (
          <p role="alert">
            Private receipt evidence is stale. Refresh before physical release.
          </p>
        ) : null}
        {query.data && query.data.claims.length === 0 ? (
          <p>No ready pickup claims are available for this market.</p>
        ) : null}
        {query.data?.claims.map((claim) => (
          <ClaimCard
            key={claim.receipt.id}
            claim={claim}
            organizerPubkey={organizerPubkey}
            stale={query.data.stale}
            onUpdated={() => void query.refetch()}
          />
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={query.isFetching || !authenticated}
          onClick={() => void query.refetch()}
        >
          Refresh pickup claims
        </Button>
      </CardContent>
    </Card>
  )
}
