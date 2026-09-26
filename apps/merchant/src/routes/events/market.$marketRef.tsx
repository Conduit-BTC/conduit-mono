import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  decodeEventMarketReference,
  EVENT_KINDS,
  listPendingEventMarketMerchantDecisions,
  publishEventMarketMerchantDecision,
  readEventMarketAuthorization,
  readEventMarketReapprovalPreview,
  readEventMarketRoster,
  retryEventMarketMerchantDecisionDelivery,
  useAuth,
  type EventMarketMerchantMode,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import { requireAuth } from "../../lib/auth"

const HEX_64 = /^[0-9a-f]{64}$/

export const Route = createFileRoute("/events/market/$marketRef")({
  beforeLoad: () => requireAuth(),
  component: FutureEventMarketOrganizerPage,
})

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The organizer action failed."
}

function FutureEventMarketOrganizerPage() {
  const { marketRef } = Route.useParams()
  const decoded = decodeEventMarketReference(marketRef, [
    EVENT_KINDS.EVENT_MARKET,
  ])
  const coordinate = decoded?.coordinate ?? ""
  const {
    accountPubkey,
    pubkey,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
  } = useAuth()
  const queryClient = useQueryClient()
  const [merchantInput, setMerchantInput] = useState("")
  const merchantPubkey = merchantInput.trim().toLowerCase()
  const [mode, setMode] = useState<EventMarketMerchantMode>("merchant_present")
  const [assignment, setAssignment] = useState("")
  const [reviewOpen, setReviewOpen] = useState(false)
  const [savedDecisionId, setSavedDecisionId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const organizerPubkey = decoded?.authorPubkey ?? ""
  const isOrganizer = !!accountPubkey && accountPubkey === organizerPubkey
  const authenticatedPubkey =
    isOrganizer && signerReadiness === "ready" && pubkey === accountPubkey
      ? pubkey
      : null
  const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
  const validMerchant = HEX_64.test(merchantPubkey)

  const marketQuery = useQuery({
    queryKey: ["future-market-organizer-roster", coordinate, authGeneration],
    enabled: !!coordinate && isOrganizer,
    queryFn: () =>
      readEventMarketRoster({
        reference: coordinate,
        authenticatedPubkey,
        shouldContinue,
      }),
  })
  const authorizationQuery = useQuery({
    queryKey: [
      "future-market-organizer-authorization",
      coordinate,
      merchantPubkey,
      authGeneration,
    ],
    enabled: !!coordinate && isOrganizer && validMerchant,
    queryFn: () =>
      readEventMarketAuthorization({
        marketCoordinate: coordinate,
        merchantPubkey,
        authenticatedPubkey,
        shouldContinue,
      }),
  })
  const pendingQuery = useQuery({
    queryKey: ["future-market-pending-decisions", coordinate],
    enabled: !!coordinate && isOrganizer,
    queryFn: () => listPendingEventMarketMerchantDecisions(coordinate),
  })
  const marketResolution = marketQuery.data?.resolution
  const market =
    marketResolution?.state === "current" ? marketResolution.market : null
  const existingRow = market?.merchants.find(
    (row) => row.pubkey === merchantPubkey
  )
  const authorization = authorizationQuery.data?.resolution
  const reapproval =
    !existingRow &&
    (authorization?.state === "revoked" ||
      (authorization?.state === "deleted" &&
        authorization.tip.state === "revoked"))
  const reconciliation = !existingRow && authorization?.state === "conflicting"
  const firstApproval = !existingRow && authorization?.state === "missing"
  const action = existingRow
    ? "revoke"
    : reapproval || reconciliation || firstApproval
      ? "approve"
      : null
  const decisionReady =
    !!market &&
    !!authenticatedPubkey &&
    validMerchant &&
    !!action &&
    !marketQuery.isFetching &&
    !authorizationQuery.isFetching &&
    !pendingQuery.isFetching &&
    marketQuery.data?.retained &&
    authorizationQuery.data?.retained &&
    (authorization?.state !== "conflicting" ||
      authorization.tips.length <= 8) &&
    pendingQuery.data?.length === 0 &&
    (action === "revoke" || !!assignment.trim())

  const previewQuery = useQuery({
    queryKey: [
      "future-market-reapproval-preview",
      coordinate,
      merchantPubkey,
      reviewOpen,
    ],
    enabled:
      reviewOpen && action === "approve" && !!coordinate && validMerchant,
    staleTime: 0,
    queryFn: () =>
      readEventMarketReapprovalPreview({
        marketCoordinate: coordinate,
        merchantPubkey,
        authenticatedPubkey,
      }),
  })
  const previewComplete =
    action === "revoke" ||
    (!previewQuery.isFetching &&
      !previewQuery.isError &&
      previewQuery.data?.complete === true &&
      previewQuery.data.coverage === "complete")

  const decisionMutation = useMutation({
    mutationFn: async () => {
      if (!market || !action || !authenticatedPubkey || !authorization) {
        throw new Error("Current signed organizer authority is required.")
      }
      const expectedAuthorizationTipIds =
        authorization.state === "active" ||
        authorization.state === "revoked" ||
        authorization.state === "deleted"
          ? [authorization.tip.eventId]
          : authorization.state === "conflicting"
            ? authorization.tips.map((tip) => tip.eventId)
            : []
      return publishEventMarketMerchantDecision({
        organizerPubkey,
        authenticatedPubkey,
        dTag: coordinate.slice(
          coordinate.indexOf(":", coordinate.indexOf(":") + 1) + 1
        ),
        calendarCoordinate: market.calendarCoordinate,
        merchantPubkey,
        action,
        ...(action === "approve"
          ? {
              row: {
                pubkey: merchantPubkey,
                mode,
                assignment: assignment.trim(),
              },
            }
          : {}),
        expectedPreviousEventId: market.eventId,
        expectedAuthorizationTipIds,
        shouldContinue,
        onSignedLocal: async (signed) => {
          setSavedDecisionId(signed.authorization.id)
          await queryClient.invalidateQueries({
            queryKey: ["future-market-pending-decisions", coordinate],
          })
        },
      })
    },
    onSuccess: async () => {
      setReviewOpen(false)
      setSavedDecisionId(null)
      setNotice(
        "Signed organizer decision published. Refreshing current evidence."
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["future-market-organizer-roster", coordinate],
        }),
        queryClient.invalidateQueries({
          queryKey: ["future-market-pending-decisions", coordinate],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "future-market-organizer-authorization",
            coordinate,
            merchantPubkey,
          ],
        }),
      ])
    },
  })
  const retryMutation = useMutation({
    mutationFn: async (decisionId: string) => {
      if (!authenticatedPubkey) {
        throw new Error(
          "Reconnect the organizer signer to retry saved delivery."
        )
      }
      return retryEventMarketMerchantDecisionDelivery({
        decisionId,
        authenticatedPubkey,
        shouldContinue,
      })
    },
    onSuccess: async () => {
      setSavedDecisionId(null)
      setReviewOpen(false)
      setNotice("Saved signed decision delivered. Refreshing current evidence.")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["future-market-organizer-roster", coordinate],
        }),
        queryClient.invalidateQueries({
          queryKey: ["future-market-pending-decisions", coordinate],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "future-market-organizer-authorization",
            coordinate,
            merchantPubkey,
          ],
        }),
      ])
    },
  })

  if (!decoded)
    return (
      <StatusCard
        title="Invalid market link"
        detail="Open a version-2 Event Market address."
      />
    )
  if (!isOrganizer)
    return (
      <StatusCard
        title="Organizer access required"
        detail="Connect the signer that authored this Event Market."
      />
    )

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-2 sm:py-6">
      <Button asChild variant="outline">
        <Link to="/events" search={{}}>
          Back to events
        </Link>
      </Button>
      <Card>
        <CardHeader>
          <CardTitle>Merchant admission</CardTitle>
          <CardDescription>
            Manage one merchant at this version-2 Event Market. A current row
            and a causal grant are both required for new purchases.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="break-all text-xs text-[var(--text-muted)]">
            {coordinate}
          </p>
          {!authenticatedPubkey && (
            <p role="status">
              Connect and unlock the organizer signer before signing a decision.
            </p>
          )}
          {marketQuery.isPending && (
            <p role="status">Checking current market authority…</p>
          )}
          {marketQuery.isError && (
            <p role="alert">{message(marketQuery.error)}</p>
          )}
          {marketResolution && marketResolution.state !== "current" && (
            <p role="alert">
              Current market authority: {marketResolution.state}. No decision
              can be signed.
            </p>
          )}
          {market && (
            <p>
              Market is {market.state}. {market.merchants.length} merchant
              {market.merchants.length === 1 ? "" : "s"} currently listed.
            </p>
          )}
          {pendingQuery.isError && (
            <p role="alert">
              Saved decisions could not be checked:{" "}
              {message(pendingQuery.error)}
            </p>
          )}
          {!!pendingQuery.data?.length && (
            <div className="space-y-3 rounded-lg border border-[var(--border)] p-4">
              <p>
                Saved organizer decisions need exact delivery before another
                decision can be signed.
              </p>
              {pendingQuery.data.map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span className="break-all text-sm">
                    {job.action} · {job.merchantPubkey}
                  </span>
                  <Button
                    variant="outline"
                    disabled={!authenticatedPubkey || retryMutation.isPending}
                    onClick={() => retryMutation.mutate(job.id)}
                  >
                    Retry saved delivery
                  </Button>
                </div>
              ))}
              {retryMutation.isError && (
                <p role="alert">{message(retryMutation.error)}</p>
              )}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="future-market-merchant">Merchant public key</Label>
            <Input
              id="future-market-merchant"
              value={merchantInput}
              onChange={(event) => {
                setMerchantInput(event.target.value)
                setReviewOpen(false)
                setNotice(null)
              }}
              placeholder="64-character hex public key"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {validMerchant && authorizationQuery.isPending && (
            <p role="status">Checking merchant authorization…</p>
          )}
          {authorizationQuery.isError && (
            <p role="alert">{message(authorizationQuery.error)}</p>
          )}
          {existingRow && (
            <p>
              Current assignment: {existingRow.assignment} (
              {existingRow.mode === "merchant_present"
                ? "Merchant handoff"
                : "Organizer handoff"}
              ).
            </p>
          )}
          {authorization && (
            <p>Authorization: {authorization.state.replace("_", " ")}.</p>
          )}
          {action === "approve" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="future-market-mode">Handoff mode</Label>
                <Select
                  value={mode}
                  onValueChange={(value) =>
                    setMode(value as EventMarketMerchantMode)
                  }
                >
                  <SelectTrigger id="future-market-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="merchant_present">
                      Merchant handoff
                    </SelectItem>
                    <SelectItem value="organizer_handoff">
                      Organizer handoff
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="future-market-assignment">
                  Public assignment
                </Label>
                <Input
                  id="future-market-assignment"
                  value={assignment}
                  onChange={(event) => setAssignment(event.target.value)}
                  maxLength={120}
                  placeholder="Booth or pickup desk"
                />
              </div>
            </>
          )}
          {validMerchant && !action && !authorizationQuery.isPending && (
            <p role="status">
              This evidence needs organizer review before another decision can
              be signed.
            </p>
          )}
          <Button
            disabled={
              !decisionReady ||
              decisionMutation.isPending ||
              retryMutation.isPending ||
              !!savedDecisionId ||
              pendingQuery.isPending ||
              !!pendingQuery.data?.length
            }
            onClick={() => {
              setNotice(null)
              setReviewOpen(true)
            }}
          >
            Review{" "}
            {action === "revoke"
              ? "revocation"
              : reconciliation
                ? "reconciliation"
                : reapproval
                  ? "reapproval"
                  : "approval"}
          </Button>
          {notice && <p role="status">{notice}</p>}
          {decisionMutation.isError && (
            <p role="alert">{message(decisionMutation.error)}</p>
          )}
          {savedDecisionId && (
            <div className="space-y-2 rounded-lg border border-[var(--border)] p-4">
              <p>
                The exact signed records were saved. Retry their delivery before
                starting another decision.
              </p>
              <Button
                variant="outline"
                disabled={!authenticatedPubkey || retryMutation.isPending}
                onClick={() => retryMutation.mutate(savedDecisionId)}
              >
                Retry saved delivery
              </Button>
              {retryMutation.isError && (
                <p role="alert">{message(retryMutation.error)}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === "revoke"
                ? "Confirm revocation"
                : reconciliation
                  ? "Confirm reconciliation"
                  : reapproval
                    ? "Confirm reapproval"
                    : "Confirm approval"}
            </DialogTitle>
            <DialogDescription>
              {action === "revoke"
                ? "The merchant row will be removed and a descendant revoke signed."
                : reconciliation
                  ? "The new active grant will descend from every observed authorization tip. A current row and grant will admit every still-valid tagged product. Review the products found on the checked relays before signing."
                  : "A current row and active grant will admit every still-valid tagged product. Review the products found on the checked relays before signing."}
            </DialogDescription>
          </DialogHeader>
          {action === "approve" && (
            <div className="max-h-64 space-y-2 overflow-y-auto text-sm">
              {previewQuery.isPending && (
                <p role="status">Checking current tagged products…</p>
              )}
              {previewQuery.isError && (
                <p role="alert">{message(previewQuery.error)}</p>
              )}
              {previewQuery.data && !previewComplete && (
                <p role="alert">
                  The product check is incomplete. Reapproval is unavailable
                  until the current tagged products can be reviewed.
                </p>
              )}
              {previewComplete && previewQuery.data?.products.length === 0 && (
                <p>
                  No current tagged products were found on the checked relays.
                </p>
              )}
              {previewComplete &&
                previewQuery.data?.products.map((product) => (
                  <div
                    key={product.id}
                    className="rounded-md border border-[var(--border)] p-2"
                  >
                    <strong>{product.title}</strong>
                    <p className="break-all text-xs text-[var(--text-muted)]">
                      {product.id}
                    </p>
                  </div>
                ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !decisionReady ||
                !previewComplete ||
                decisionMutation.isPending ||
                !!savedDecisionId
              }
              onClick={() => decisionMutation.mutate()}
            >
              {decisionMutation.isPending ? "Signing…" : "Confirm and sign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StatusCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto max-w-3xl py-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{detail}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
