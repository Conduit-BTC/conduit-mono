import { useState } from "react"
import {
  encodeEventMarketNaddr,
  publishEventMarketRoster,
  publishFutureEventMarketCalendar,
  retainSignedEventMarketEvidence,
  useAuth,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@conduit/ui"
import {
  createEmptyOrganizerEventMarketForm,
  prepareOrganizerEventMarketForm,
  slugifyEventMarketTitle,
  type OrganizerEventMarketFormValues,
} from "../lib/event-market-form"

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
  const [form, setForm] = useState<OrganizerEventMarketFormValues>(
    createEmptyOrganizerEventMarketForm
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [step, setStep] = useState("")
  const organizerPubkey = accountPubkey ?? ""
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null

  function update<K extends keyof OrganizerEventMarketFormValues>(
    key: K,
    value: OrganizerEventMarketFormValues[K]
  ): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function publish(): Promise<void> {
    if (!authenticatedPubkey || pending) return
    setPending(true)
    setError("")
    try {
      const prepared = prepareOrganizerEventMarketForm(form, {
        requireFutureStart: true,
      })
      const dTag = `${slugifyEventMarketTitle(form.title) || "event"}-${crypto.randomUUID().slice(0, 8)}`
      const calendarDTag = `${dTag}-calendar`
      const marketCoordinate = `30409:${organizerPubkey}:${dTag}`
      const calendarCoordinate = `${prepared.calendar.kind}:${organizerPubkey}:${calendarDTag}`
      const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
      const calendar =
        prepared.calendar.kind === 31922
          ? {
              kind: 31922 as const,
              dTag: calendarDTag,
              title: prepared.calendar.title,
              summary: prepared.calendar.summary,
              image: prepared.calendar.imageUrl,
              locations: [prepared.calendar.location],
              geohash: prepared.calendar.geohash,
              start: prepared.calendar.start as string,
              end: prepared.calendar.end as string | undefined,
            }
          : {
              kind: 31923 as const,
              dTag: calendarDTag,
              title: prepared.calendar.title,
              summary: prepared.calendar.summary,
              image: prepared.calendar.imageUrl,
              locations: [prepared.calendar.location],
              geohash: prepared.calendar.geohash,
              start: prepared.calendar.start as number,
              end: prepared.calendar.end as number | undefined,
              startTzid: prepared.calendar.timezone,
              endTzid: prepared.calendar.timezone,
            }
      setStep("Publishing signed calendar…")
      await publishFutureEventMarketCalendar({
        organizerPubkey,
        authenticatedPubkey,
        calendar,
        shouldContinue,
        onSignedLocal: (event) =>
          retainSignedEventMarketEvidence(marketCoordinate, event),
      })
      setStep("Publishing signed Event Market…")
      const result = await publishEventMarketRoster({
        organizerPubkey,
        authenticatedPubkey,
        dTag,
        calendarCoordinate,
        state: "open",
        merchants: [],
        shouldContinue,
        onSignedLocal: (event) =>
          retainSignedEventMarketEvidence(marketCoordinate, event),
      })
      onPublished(
        encodeEventMarketNaddr(
          marketCoordinate,
          result.delivery.successfulRelayUrls
        )
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Event Market publication failed."
      )
    } finally {
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
        {step ? <p role="status">{step}</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-[var(--destructive)]">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={!authenticatedPubkey || pending}
          onClick={() => void publish()}
        >
          Publish Event Market
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
