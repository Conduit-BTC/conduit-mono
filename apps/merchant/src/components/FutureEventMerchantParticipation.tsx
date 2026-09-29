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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@conduit/ui"
import { EventActorName, EventActorProvenance } from "./EventActorIdentity"
import { SignerSwitch } from "./SignerSwitch"

export function FutureEventMerchantParticipation({
  market,
  authenticatedPubkey,
  enrollment,
  busy,
  blocked,
  onSend,
}: {
  market: ParsedEventMarketRoster
  authenticatedPubkey: string | null
  enrollment?: EventMarketEnrollmentState
  busy: boolean
  blocked: boolean
  onSend: (action: "request" | "withdraw", merchant: string) => Promise<void>
}) {
  const { accountPubkey, authGeneration, isAuthGenerationCurrent } = useAuth()
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
  const status = approved
    ? "Approved to sell"
    : revoked
      ? "Approval revoked"
      : enrollment?.status === "requested"
        ? "Request pending"
        : enrollment?.status === "invited"
          ? "Invited to join"
          : enrollment?.status === "declined"
            ? "Request declined"
            : enrollment?.status === "withdrawn"
              ? "Request withdrawn"
              : "Join this event"
  return (
    <Card>
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
            : "Connect your signer to request a place or review your invitation."}
        </p>
        {!authenticatedPubkey ? (
          <SignerSwitch />
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
                Withdraw request
              </Button>
            ) : (
              <Button
                disabled={busy || blocked || auth.isFetching}
                onClick={() => void onSend("request", authenticatedPubkey)}
              >
                {enrollment?.status === "invited"
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
