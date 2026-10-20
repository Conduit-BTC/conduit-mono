import { useMemo, useRef, useState } from "react"
import {
  parseEventMarketOrganizerFeeTerms,
  publishEventMarketRoster,
  retainSignedEventMarketEvidence,
  retryEventMarketRosterDelivery,
  useAuth,
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
  parseEventMarketOrganizerFeeForm,
  type EventMarketOrganizerFeeFormValues,
} from "../lib/event-market-organizer-fee-form"

export function EventMarketOrganizerFeeForm(props: {
  fee: EventMarketOrganizerFeeResolution
  values: EventMarketOrganizerFeeFormValues
  canEdit: boolean
  canRetry: boolean
  busy: boolean
  notice?: string
  error?: string
  onChange: (values: EventMarketOrganizerFeeFormValues) => void
  onSave: () => void
  onRetry: () => void
}) {
  const { fee, values } = props
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
                {formatOrganizerFeePercent(fee.basisPoints)}%, minimum{" "}
                {fee.minimumSats.toLocaleString()} sats
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
        {props.canEdit ? (
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
                  disabled={props.busy}
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
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Percentage"
                    description="Of merchandise and shipping only; no fee on other fees."
                  >
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="decimal"
                        value={values.percent}
                        disabled={props.busy}
                        onChange={(event) =>
                          update("percent", event.target.value)
                        }
                        placeholder="2.5"
                      />
                    )}
                  </Field>
                  <Field
                    label="Minimum (sats)"
                    description="The larger of this minimum or the percentage applies."
                  >
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="numeric"
                        value={values.minimumSats}
                        disabled={props.busy}
                        onChange={(event) =>
                          update("minimumSats", event.target.value)
                        }
                        placeholder="0"
                      />
                    )}
                  </Field>
                </div>
                <Field
                  label="Organizer Lightning address"
                  description="Use your own supported receiving wallet. Its outgoing fee stays within the organizer allocation."
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={values.lightningAddress}
                      disabled={props.busy}
                      onChange={(event) =>
                        update("lightningAddress", event.target.value)
                      }
                      placeholder="organizer@wallet.example"
                    />
                  )}
                </Field>
                <Field
                  label="Expiry (UTC, optional)"
                  description="Leave empty for no separate fee expiry. Setting both amounts to zero disables the fee."
                >
                  {(control) => (
                    <Input
                      {...control}
                      type="datetime-local"
                      step={1}
                      value={values.expiresAtUtc}
                      disabled={props.busy}
                      onChange={(event) =>
                        update("expiresAtUtc", event.target.value)
                      }
                    />
                  )}
                </Field>
              </>
            ) : null}
            <Button type="submit" disabled={props.busy || values.state === ""}>
              {props.busy ? "Saving fee settings…" : "Save fee settings"}
            </Button>
          </form>
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
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [saved, setSaved] = useState<SignedPublicNostrEvent | null>(null)
  const inFlight = useRef(false)
  const owner = props.authenticatedPubkey === market.organizerPubkey
  const shouldContinue = () => owner && isAuthGenerationCurrent(authGeneration)
  async function mutate(retry: boolean) {
    if (inFlight.current || !owner || (!retry && !props.canManage)) return
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
          organizerFee: parseEventMarketOrganizerFeeForm(values, Date.now()),
          shouldContinue,
          onSignedLocal: async (event) => {
            await retainSignedEventMarketEvidence(market.coordinate, event)
            if (shouldContinue()) setSaved(event)
          },
        })
      if (shouldContinue()) {
        setNotice("Fee settings saved and published.")
        await props.onChanged()
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
      fee={fee}
      values={values}
      canEdit={owner && props.canManage && !saved}
      canRetry={owner}
      busy={busy}
      notice={notice}
      error={error}
      onChange={setValues}
      onSave={() => void mutate(false)}
      onRetry={() => void mutate(true)}
    />
  )
}
