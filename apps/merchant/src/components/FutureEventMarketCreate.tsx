import { useRef, useState } from "react"
import { encodeEventMarketNaddr, useAuth } from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@conduit/ui"
import {
  createEmptyOrganizerEventMarketForm,
  type OrganizerEventMarketFormValues,
} from "../lib/event-market-form"

import {
  loadFutureEventMarketCreation,
  publishFutureEventMarketCreation,
  saveNewFutureEventMarketCreation,
} from "../lib/event-market-creation-retry"

export function FutureEventMarketCreate({
  onPublished,
}: {
  onPublished: (reference: string) => void
}) {
  const {
    accountPubkey,
    pubkey,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
  } = useAuth()
  const organizerPubkey = accountPubkey ?? ""
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null
  return (
    <FutureEventMarketCreateForm
      key={organizerPubkey}
      organizerPubkey={organizerPubkey}
      authenticatedPubkey={authenticatedPubkey}
      shouldContinue={() => isAuthGenerationCurrent(authGeneration)}
      onPublished={onPublished}
    />
  )
}

function FutureEventMarketCreateForm({
  organizerPubkey,
  authenticatedPubkey,
  shouldContinue,
  onPublished,
}: {
  organizerPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  onPublished: (reference: string) => void
}) {
  const [restored] = useState(() => {
    try {
      return {
        creation: organizerPubkey
          ? loadFutureEventMarketCreation(organizerPubkey)
          : null,
        error: "",
      }
    } catch (cause) {
      return {
        creation: null,
        error:
          cause instanceof Error
            ? cause.message
            : "Saved creation could not be loaded.",
      }
    }
  })
  const [creation, setCreation] = useState(restored.creation)
  const [form, setForm] = useState<OrganizerEventMarketFormValues>(
    () => restored.creation?.form ?? createEmptyOrganizerEventMarketForm()
  )
  const publishing = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(restored.error)
  const [step, setStep] = useState("")

  function update<K extends keyof OrganizerEventMarketFormValues>(
    key: K,
    value: OrganizerEventMarketFormValues[K]
  ): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function publish(): Promise<void> {
    if (!authenticatedPubkey || publishing.current || restored.error) return
    publishing.current = true
    setPending(true)
    setError("")
    try {
      if (!shouldContinue()) throw new Error("Organizer session changed.")
      const saved =
        loadFutureEventMarketCreation(organizerPubkey) ??
        saveNewFutureEventMarketCreation(organizerPubkey, form)
      setCreation(saved)
      const result = await publishFutureEventMarketCreation({
        organizerPubkey,
        authenticatedPubkey,
        shouldContinue,
        onSaved: setCreation,
        onStep: setStep,
      })
      onPublished(
        encodeEventMarketNaddr(
          result.marketCoordinate,
          result.successfulRelayUrls
        )
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Event Market publication failed."
      )
    } finally {
      publishing.current = false
      setPending(false)
      setStep("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Event Market</CardTitle>
        <CardDescription>
          Publish one organizer-signed calendar and Event Market. Merchant
          admission and listings are managed after creation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {creation ? (
          <p role="status" className="text-sm text-[var(--text-muted)]">
            A saved creation is waiting to finish. Retry the same Event Market
            before creating another; its signed records may already be public.
          </p>
        ) : null}
        <fieldset disabled={pending || !!creation} className="space-y-5">
          <div className="space-y-1">
            <Label htmlFor="future-title">Event title</Label>
            <Input
              id="future-title"
              value={form.title}
              onChange={(event) => update("title", event.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-summary">Description</Label>
            <Textarea
              id="future-summary"
              value={form.summary}
              onChange={(event) => update("summary", event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-image">Banner URL</Label>
            <Input
              id="future-image"
              type="url"
              value={form.imageUrl}
              onChange={(event) => update("imageUrl", event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-location">Location</Label>
            <Input
              id="future-location"
              value={form.eventLocation}
              onChange={(event) => update("eventLocation", event.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="future-calendar-type">Schedule</Label>
            <Select
              value={form.calendarType}
              onValueChange={(value) =>
                update("calendarType", value as "date" | "timed")
              }
            >
              <SelectTrigger id="future-calendar-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="timed">Timed event</SelectItem>
                <SelectItem value="date">All-day event</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="future-start">Start</Label>
              <Input
                id="future-start"
                type={form.calendarType === "timed" ? "datetime-local" : "date"}
                value={form.start}
                onChange={(event) => update("start", event.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="future-end">End</Label>
              <Input
                id="future-end"
                type={form.calendarType === "timed" ? "datetime-local" : "date"}
                value={form.end}
                onChange={(event) => update("end", event.target.value)}
                required
              />
            </div>
          </div>
          {form.calendarType === "timed" ? (
            <div className="space-y-1">
              <Label htmlFor="future-timezone">Time zone</Label>
              <Input
                id="future-timezone"
                value={form.timezone}
                onChange={(event) => update("timezone", event.target.value)}
                required
              />
            </div>
          ) : null}
        </fieldset>
        {step ? <p role="status">{step}</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={!authenticatedPubkey || pending || !!restored.error}
          onClick={() => void publish()}
        >
          {creation ? "Retry saved Event Market" : "Publish Event Market"}
        </Button>
        {!authenticatedPubkey ? (
          <p className="text-sm text-[var(--text-muted)]">
            Connect the organizer signer to publish.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
