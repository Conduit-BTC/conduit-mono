import { useQuery } from "@tanstack/react-query"
import {
  encodeEventMarketNaddr,
  readEventMarketAuthorization,
  useAuth,
  useProfiles,
  type ParsedEventMarketRoster,
  type EventMarketEnrollmentState,
} from "@conduit/core"
import {
  Button,
  SignerRecoveryNotice,
  useSignIn,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@conduit/ui"
import { EventActorName, EventActorProvenance } from "./EventActorIdentity"
import { getEventParticipationStatus } from "../lib/event-market-enrollment-presentation"

export function FutureEventMerchantParticipation({
  market,
  authenticatedPubkey,
  enrollment,
  busy,
  blocked,
  error,
  networkRepair,
  pendingDelivery = false,
  onSend,
}: {
  market: ParsedEventMarketRoster
  authenticatedPubkey: string | null
  enrollment?: EventMarketEnrollmentState
  busy: boolean
  blocked: boolean
  error?: string
  networkRepair?: boolean
  pendingDelivery?: boolean
  onSend: (action: "request" | "withdraw", merchant: string) => Promise<void>
}) {
  const {
    accountPubkey,
    authGeneration,
    isAuthGenerationCurrent,
    signerReadiness,
    status: authStatus,
    error: authError,
    connect,
  } = useAuth()
  const { requestSignIn } = useSignIn()
  const profiles = useProfiles([market.organizerPubkey], {
    accountPubkey,
    authenticatedPubkey,
    priority: "visible",
    shouldContinue: () => isAuthGenerationCurrent(authGeneration),
  })
  const auth = useQuery({
    queryKey: [
      "future-market-merchant-participation",
      market.coordinate,
      authenticatedPubkey,
      authGeneration,
      market.eventId,
    ],
    queryFn: ({ signal }) =>
      readEventMarketAuthorization({
        marketCoordinate: market.coordinate,
        merchantPubkey: authenticatedPubkey!,
        authenticatedPubkey,
        signal,
        shouldContinue: () =>
          !signal.aborted && isAuthGenerationCurrent(authGeneration),
      }),
    enabled: !!authenticatedPubkey,
    retry: false,
  })
  const row = market.merchants.find(
    (merchant) => merchant.pubkey === authenticatedPubkey
  )
  const approved =
    !!row &&
    auth.data?.resolution.state === "active" &&
    auth.data.actionable === true
  const revoked = auth.data?.resolution.state === "revoked"
  const status = getEventParticipationStatus({
    approved,
    revoked,
    busy,
    pendingDelivery,
    enrollmentStatus: enrollment?.status,
  })
  return (
    <Card role="region" aria-label="Your participation">
      <CardHeader>
        <CardTitle>Your participation</CardTitle>
        <CardDescription>
          Hosted by{" "}
          <EventActorName
            pubkey={market.organizerPubkey}
            profile={profiles.data?.[market.organizerPubkey]}
          />{" "}
          <EventActorProvenance
            pubkey={market.organizerPubkey}
            copyLabel="Copy organizer npub"
            className="text-xs"
          />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p role="status" className="font-medium">
          {authenticatedPubkey
            ? status
            : accountPubkey
              ? "Your account is retained. A ready signer is required for participation actions."
              : "Connect your signer to request a place or review your invitation."}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-[var(--error-text)]">
            {error}
            {networkRepair ? (
              <>
                {" "}
                <a className="underline" href="/network">
                  Open Network settings
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {!authenticatedPubkey ? (
          !accountPubkey ? (
            <Button onClick={() => requestSignIn()}>Connect</Button>
          ) : signerReadiness === "incompatible" ? (
            <p role="alert">
              Your signer does not support the capabilities required for
              participation. Open Network settings to review compatibility.
            </p>
          ) : (
            <SignerRecoveryNotice
              description="Reconnect your account, then retry your participation action."
              reconnecting={
                authStatus === "restoring" || authStatus === "connecting"
              }
              restoreFailed={authStatus === "error"}
              restoreFailureDescription={authError}
              onReconnect={() => connect({ mode: "restore" })}
            />
          )
        ) : approved ? (
          <>
            <p className="text-sm">
              {row?.mode === "organizer_handoff"
                ? "The organizer handles pickup"
                : "You hand out your goods"}{" "}
              · {row?.assignment}
            </p>
            <Button asChild>
              <a
                href={`/products?eventMarket=${encodeURIComponent(encodeEventMarketNaddr(market.coordinate))}`}
              >
                Choose products for this event
              </a>
            </Button>
            <p className="text-xs text-[var(--text-muted)]">
              Add existing shop products or create a product here. You control
              price, stock and visibility. Remove an event association to stop
              offering a product here.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              {enrollment?.status === "requested"
                ? "The host reviews your account and assigns a booth or pickup point. Your request survives closing this page."
                : "Send the host a private participation request. The host must approve your merchant account before your products can sell here."}
            </p>
            {enrollment?.status === "requested" ? (
              <Button
                variant="outline"
                disabled={busy || blocked}
                onClick={() => void onSend("withdraw", authenticatedPubkey)}
              >
                {busy ? "Sending…" : "Withdraw request"}
              </Button>
            ) : (
              <Button
                disabled={busy || blocked || auth.isFetching}
                onClick={() => void onSend("request", authenticatedPubkey)}
              >
                {busy
                  ? "Sending…"
                  : enrollment?.status === "invited"
                    ? "Accept invitation and request approval"
                    : revoked
                      ? "Request reapproval"
                      : "Request to join"}
              </Button>
            )}
            {row && !approved ? (
              <p role="status" className="text-sm">
                Your signed approval is being checked. A roster row or
                invitation alone does not approve selling.
              </p>
            ) : null}
          </>
        )}
        {auth.isError ? (
          <p role="alert">
            Your approval could not be checked. Refresh your participation.
          </p>
        ) : null}
        {authenticatedPubkey ? (
          <Button
            variant="ghost"
            disabled={auth.isFetching}
            onClick={() => void auth.refetch()}
          >
            Refresh participation
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}
