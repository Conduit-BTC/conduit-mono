import { useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  parseEventMarketOrganizerFeeTerms,
  publishEventMarketRoster,
  retainSignedEventMarketEvidence,
  retryEventMarketRosterDelivery,
  useAuth,
  useProfile,
  type EventMarketOrganizerFeeResolution,
  type ParsedEventMarketRoster,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import {
  createEventMarketOrganizerFeeFormValues,
  formatOrganizerFeePercent,
  getOrganizerFeeProfileAddress,
  observeOrganizerFeeProfileReceiver,
  parseEventMarketOrganizerFeeForm,
  withOrganizerFeeProfileDefault,
  type EventMarketOrganizerFeeFormValues,
  type OrganizerFeeProfileReceiver,
} from "../lib/event-market-organizer-fee-form"

export function EventMarketOrganizerFeeForm(props: {
  fee: EventMarketOrganizerFeeResolution
  values: EventMarketOrganizerFeeFormValues
  canEdit: boolean
  canRetry: boolean
  busy: boolean
  editing: boolean
  editLocked?: boolean
  profileReceiver?: OrganizerFeeProfileReceiver
  notice?: string
  error?: string
  onChange: (values: EventMarketOrganizerFeeFormValues) => void
  onSave: () => void
  onRetry: () => void
  onEdit: () => void
  onCancel: () => void
}) {
  const { fee, values } = props
  const receiver = props.profileReceiver ?? { status: "none" }
  const disabled = props.busy || props.editLocked
  const update = (
    field: keyof EventMarketOrganizerFeeFormValues,
    value: string
  ) => props.onChange({ ...values, [field]: value })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organizer fee</CardTitle>
        <CardDescription>
          Added to each event purchase, separate from the product price and
          Conduit fee. Existing orders keep their original terms.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {fee.state === "invalid" ? (
          <p role="alert" className="text-sm text-[var(--error-text)]">
            The current signed fee settings could not be verified. New event
            payments need the organizer to explicitly replace them.
          </p>
        ) : fee.state === "active" ? (
          <dl className="grid gap-2 text-sm">
            <div>
              <dt className="text-[var(--text-secondary)]">Current fee</dt>
              <dd>
                {formatOrganizerFeePercent(fee.basisPoints)}%
                {fee.minimumSats > 0
                  ? `, minimum ${fee.minimumSats.toLocaleString()} sats`
                  : ""}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[var(--text-secondary)]">
                Receiving address
              </dt>
              <dd className="break-all">{fee.lightningAddress}</dd>
            </div>
            {fee.expiresAt !== undefined ? (
              <div>
                <dt className="text-[var(--text-secondary)]">Expires</dt>
                <dd>
                  {new Date(fee.expiresAt * 1_000)
                    .toISOString()
                    .replace("T", " ")
                    .replace(".000Z", " UTC")}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">
            {fee.state === "revoked"
              ? "Organizer fee revoked."
              : fee.state === "disabled"
                ? "Organizer fee disabled."
                : "No organizer fee has been set."}
          </p>
        )}
        {props.canEdit && props.editing ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              props.onSave()
            }}
          >
            <Field label="Fee setting">
              {(control) => (
                <Select
                  value={values.state}
                  disabled={disabled}
                  onValueChange={(value) => update("state", value)}
                >
                  <SelectTrigger {...control}>
                    <SelectValue placeholder="Choose a fee setting">
                      {values.state === "active"
                        ? "Charge an organizer fee"
                        : values.state === "disabled"
                          ? "Disable organizer fee"
                          : values.state === "revoked"
                            ? "Revoke organizer fee"
                            : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">
                      Charge an organizer fee
                    </SelectItem>
                    <SelectItem value="disabled">
                      Disable organizer fee
                    </SelectItem>
                    <SelectItem value="revoked">
                      Revoke organizer fee
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            {values.state === "active" ? (
              <>
                <Field
                  label="Percentage"
                  description="Of merchandise and shipping only; no fee on other fees. Set to zero to disable the fee."
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="decimal"
                      value={values.percent}
                      disabled={disabled}
                      onChange={(event) =>
                        update("percent", event.target.value)
                      }
                      placeholder="2.5"
                    />
                  )}
                </Field>
                {receiver.status === "supported" ? (
                  <div className="space-y-2">
                    <p className="break-all text-sm text-[var(--text-secondary)]">
                      {values.lightningAddress === receiver.address
                        ? "Using your saved Lightning address: "
                        : "Your supported profile address: "}
                      {receiver.address}
                    </p>
                    {values.lightningAddress !== receiver.address ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          update("lightningAddress", receiver.address)
                        }
                      >
                        Use my Lightning address
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p
                      role="status"
                      className="text-sm text-[var(--text-secondary)]"
                    >
                      {receiver.status === "checking"
                        ? "Checking your saved Lightning address…"
                        : receiver.status === "unsupported"
                          ? "Your saved address is not supported for event routing in this deployment. Choose a supported receiving wallet."
                          : receiver.status === "unavailable"
                            ? "Your saved address could not be checked right now. Retry later or enter another receiving address."
                            : receiver.status === "conflicting"
                              ? "Your saved address did not pass the receiving-wallet check. Review its setup or enter another address."
                              : "No usable saved profile address is available here. Set up a receiving wallet or enter an address below."}
                    </p>
                    {receiver.status !== "checking" ? (
                      <Button asChild type="button" variant="outline">
                        <a href="/wallet">Manage in Wallets</a>
                      </Button>
                    ) : null}
                    <p className="text-sm text-[var(--text-secondary)]">
                      You can leave the organizer fee disabled. Wallet setup
                      does not change your profile or existing event fees.
                    </p>
                  </div>
                )}
                <Field
                  label="Organizer Lightning address"
                  description="Use your saved address or enter a different supported receiving wallet. This does not change your profile or wallet settings."
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={values.lightningAddress}
                      disabled={disabled}
                      onChange={(event) =>
                        update("lightningAddress", event.target.value)
                      }
                      placeholder="organizer@wallet.example"
                    />
                  )}
                </Field>
                {fee.state === "active" &&
                (fee.minimumSats > 0 || fee.expiresAt !== undefined) ? (
                  <p className="text-sm text-[var(--text-secondary)]">
                    Saving replaces the current minimum and expiry with a
                    percentage-only fee. Existing orders keep their original
                    terms.
                  </p>
                ) : null}
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={disabled || values.state === ""}>
                {props.busy ? "Saving fee settings…" : "Save fee settings"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={props.onCancel}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : props.canEdit ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={props.onEdit}
          >
            Edit fee settings
          </Button>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">
            Only the authenticated organizer with current event authority can
            change these settings.
          </p>
        )}
        {props.canRetry ? (
          <Button
            type="button"
            variant="outline"
            disabled={props.busy}
            onClick={props.onRetry}
          >
            Retry current signed settings
          </Button>
        ) : null}
        {props.notice ? (
          <p role="status" className="text-sm text-[var(--success-text)]">
            {props.notice}
          </p>
        ) : null}
        {props.error ? (
          <p role="alert" className="text-sm text-[var(--error-text)]">
            {props.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function EventMarketOrganizerFeeEditor(props: {
  market: ParsedEventMarketRoster
  authenticatedPubkey: string | null
  canManage: boolean
  onChanged: () => void | Promise<unknown>
}) {
  const { market } = props
  const { authGeneration, isAuthGenerationCurrent } = useAuth()
  const fee = useMemo(
    () =>
      parseEventMarketOrganizerFeeTerms({
        event: market.signedEvent,
        marketCoordinate: market.coordinate,
      }),
    [market.signedEvent, market.coordinate]
  )
  const [values, setValues] = useState(() =>
    createEventMarketOrganizerFeeFormValues(fee)
  )
  const [addressEdited, setAddressEdited] = useState(false)
  const [editing, setEditing] = useState(
    () => fee.state === "absent" || fee.state === "invalid"
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [saved, setSaved] = useState<SignedPublicNostrEvent | null>(null)
  const [published, setPublished] = useState(false)
  const inFlight = useRef(false)
  const owner = props.authenticatedPubkey === market.organizerPubkey
  const shouldContinue = () => owner && isAuthGenerationCurrent(authGeneration)
  const profileQuery = useProfile(owner ? market.organizerPubkey : null, {
    accountPubkey: props.authenticatedPubkey,
    authenticatedPubkey: props.authenticatedPubkey,
    shouldContinue,
    enabled: owner && props.canManage && editing,
    maxUnresolvedRefetches: 2,
    evidenceScope: "payment",
  })
  const profileAddress = getOrganizerFeeProfileAddress(
    profileQuery.profileContext,
    market.organizerPubkey
  )
  const receiverEnabled =
    owner && props.canManage && editing && values.state === "active"
  const receiverQuery = useQuery({
    queryKey: [
      "event-organizer-fee-profile-receiver",
      market.coordinate,
      props.authenticatedPubkey,
      authGeneration,
      profileAddress,
    ],
    queryFn: ({ signal }) =>
      observeOrganizerFeeProfileReceiver({
        context: profileQuery.profileContext,
        organizerPubkey: market.organizerPubkey,
        assertCurrent: () => {
          if (signal.aborted || !shouldContinue())
            throw new Error("Organizer session changed.")
        },
      }),
    enabled: receiverEnabled && !!profileAddress,
    retry: false,
    gcTime: 0,
  })
  const profileReceiver: OrganizerFeeProfileReceiver = !receiverEnabled
    ? { status: "none" }
    : profileQuery.isFetching || receiverQuery.isFetching
      ? { status: "checking" }
      : profileQuery.error || receiverQuery.isError
        ? { status: "unavailable" }
        : (receiverQuery.data ?? { status: "none" })
  const draftValues = withOrganizerFeeProfileDefault({
    fee,
    values,
    receiver: profileReceiver,
    addressEdited,
  })
  const displayedFee = useMemo(
    () =>
      published && saved
        ? parseEventMarketOrganizerFeeTerms({
            event: saved,
            marketCoordinate: market.coordinate,
          })
        : fee,
    [fee, market.coordinate, published, saved]
  )
  function changeEditing(next: boolean) {
    if (inFlight.current || saved) return
    setValues(createEventMarketOrganizerFeeFormValues(fee))
    setAddressEdited(false)
    setNotice("")
    setError("")
    setEditing(next)
  }
  async function mutate(retry: boolean) {
    if (
      inFlight.current ||
      !owner ||
      (!retry && (!props.canManage || !editing || saved))
    )
      return
    inFlight.current = true
    setBusy(true)
    setNotice("")
    setError("")
    try {
      if (!shouldContinue()) throw new Error("Organizer session changed.")
      if (retry)
        await retryEventMarketRosterDelivery({
          signedEvent: saved ?? market.signedEvent,
          authenticatedPubkey: props.authenticatedPubkey,
          shouldContinue,
        })
      else
        await publishEventMarketRoster({
          organizerPubkey: market.organizerPubkey,
          authenticatedPubkey: props.authenticatedPubkey,
          dTag: market.coordinate.split(":").slice(2).join(":"),
          calendarCoordinate: market.calendarCoordinate,
          state: market.state,
          merchants: market.merchants,
          expectedPreviousEventId: market.eventId,
          organizerFee: parseEventMarketOrganizerFeeForm(draftValues),
          shouldContinue,
          onSignedLocal: async (event) => {
            await retainSignedEventMarketEvidence(market.coordinate, event)
            if (shouldContinue()) setSaved(event)
          },
        })
      if (shouldContinue()) {
        setPublished(true)
        setEditing(false)
        setNotice("Fee settings saved and published.")
        try {
          await props.onChanged()
        } catch {
          if (shouldContinue())
            setError(
              "The fee settings were published, but the event could not refresh. Refresh the event before editing again."
            )
        }
      }
    } catch (cause) {
      if (shouldContinue())
        setError(
          cause instanceof Error
            ? cause.message
            : "The fee settings could not be saved. Retry the same signed update if it was already saved."
        )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return (
    <EventMarketOrganizerFeeForm
      fee={displayedFee}
      values={draftValues}
      canEdit={owner && props.canManage}
      canRetry={owner && !!saved && !published && !!error}
      busy={busy}
      editing={editing}
      editLocked={!!saved}
      profileReceiver={profileReceiver}
      notice={notice}
      error={error}
      onChange={(next) => {
        if (inFlight.current || saved) return
        if (next.lightningAddress !== draftValues.lightningAddress)
          setAddressEdited(true)
        setValues(next)
        setNotice("")
        setError("")
      }}
      onSave={() => void mutate(false)}
      onRetry={() => void mutate(true)}
      onEdit={() => changeEditing(true)}
      onCancel={() => changeEditing(false)}
    />
  )
}
