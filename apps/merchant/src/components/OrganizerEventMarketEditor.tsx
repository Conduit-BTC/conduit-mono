import { useMemo, useState, type ReactNode } from "react"
import {
  Button,
  Checkbox,
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
  SignedActionStatus,
  Textarea,
  cn,
  type SignedActionStatusState,
} from "@conduit/ui"
import {
  createEmptyOrganizerEventMarketForm,
  getOrganizerEventEndMinimum,
  getOrganizerEventStartMinimum,
  getOrganizerEventTimezoneOptions,
  isOrganizerEventMarketFormDirty,
  validateOrganizerEventMarketForm,
  type OrganizerEventMarketFormField,
  type OrganizerEventMarketFormValues,
} from "../lib/event-market-form"

function FieldError({
  field,
  errors,
}: {
  field: OrganizerEventMarketFormField
  errors: Partial<Record<OrganizerEventMarketFormField, string>>
}) {
  const message = errors[field]
  return message ? (
    <p
      id={`event-market-${field}-error`}
      className="text-xs leading-5 text-error"
      role="alert"
    >
      {message}
    </p>
  ) : null
}

function RequiredFieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string
  children: ReactNode
}) {
  return (
    <Label htmlFor={htmlFor} className="flex items-center gap-2">
      <span>{children}</span>
      <span className="text-xs font-normal text-[var(--text-muted)]">
        Required
      </span>
    </Label>
  )
}

function describedBy(
  ...ids: Array<string | false | undefined>
): string | undefined {
  const value = ids.filter(Boolean).join(" ")
  return value || undefined
}

export function OrganizerEventMarketEditor({
  open,
  initialForm,
  actionState,
  actionError,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  initialForm?: OrganizerEventMarketFormValues | null
  actionState: SignedActionStatusState
  actionError?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (form: OrganizerEventMarketFormValues) => void
}) {
  const [form, setForm] = useState<OrganizerEventMarketFormValues>(
    () => initialForm ?? createEmptyOrganizerEventMarketForm()
  )
  const [submitted, setSubmitted] = useState(false)
  const [minimumReferenceMs] = useState(() => Date.now())

  const validation = useMemo(
    () =>
      validateOrganizerEventMarketForm(form, {
        requireFutureStart: !initialForm,
        nowMs: minimumReferenceMs,
      }),
    [form, initialForm, minimumReferenceMs]
  )
  const errors = submitted ? validation.errors : {}
  const pending =
    actionState === "awaiting_signature" || actionState === "publishing"
  const dateBased = form.calendarType === "date"
  const isDirty = initialForm
    ? isOrganizerEventMarketFormDirty(form, initialForm)
    : true
  const displayedActionState =
    actionState === "idle" || actionState === "dirty"
      ? initialForm && !isDirty
        ? "idle"
        : "dirty"
      : actionState
  const timezoneOptions = useMemo(
    () => getOrganizerEventTimezoneOptions(form.timezone),
    [form.timezone]
  )
  const startMinimum = getOrganizerEventStartMinimum(
    form.calendarType,
    minimumReferenceMs
  )
  const endMinimum = getOrganizerEventEndMinimum(
    form.calendarType,
    form.start,
    startMinimum
  )

  function update<K extends keyof OrganizerEventMarketFormValues>(
    key: K,
    value: OrganizerEventMarketFormValues[K]
  ): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-3xl"
        onPointerDownOutside={(event) => pending && event.preventDefault()}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {initialForm ? "Update event market" : "Create event market"}
          </DialogTitle>
          <DialogDescription>
            Publish the calendar event and organizer-owned catalog from your
            connected signer. Organizer handoff is optional.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault()
            setSubmitted(true)
            if (
              validation.canPublish &&
              !pending &&
              (!initialForm || isDirty)
            ) {
              onSubmit(form)
            }
          }}
        >
          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Public event
              </h3>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                Everything here is published publicly. Keep private handoff and
                attendee details out of these fields. Fields marked Required
                must be completed before publishing.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <RequiredFieldLabel htmlFor="event-market-title">
                  Title
                </RequiredFieldLabel>
                <Input
                  id="event-market-title"
                  required
                  value={form.title}
                  onChange={(event) => update("title", event.target.value)}
                  aria-invalid={!!errors.title}
                  aria-describedby={
                    errors.title ? "event-market-title-error" : undefined
                  }
                />
                <FieldError field="title" errors={errors} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <RequiredFieldLabel htmlFor="event-market-summary">
                  Public summary
                </RequiredFieldLabel>
                <Textarea
                  id="event-market-summary"
                  className="min-h-24"
                  required
                  value={form.summary}
                  onChange={(event) => update("summary", event.target.value)}
                  aria-invalid={!!errors.summary}
                  aria-describedby={describedBy(
                    "event-market-summary-help",
                    errors.summary && "event-market-summary-error"
                  )}
                />
                <p
                  id="event-market-summary-help"
                  className="text-xs leading-5 text-[var(--text-muted)]"
                >
                  Brief public description shown with the event.
                </p>
                <FieldError field="summary" errors={errors} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <RequiredFieldLabel htmlFor="event-market-image">
                  Image URL
                </RequiredFieldLabel>
                <Input
                  id="event-market-image"
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  required
                  value={form.imageUrl}
                  onChange={(event) => update("imageUrl", event.target.value)}
                  aria-invalid={!!errors.imageUrl}
                  aria-describedby={describedBy(
                    "event-market-image-help",
                    errors.imageUrl && "event-market-imageUrl-error"
                  )}
                />
                <p
                  id="event-market-image-help"
                  className="text-xs leading-5 text-[var(--text-muted)]"
                >
                  Paste a direct HTTPS image URL. Image upload is not available
                  in this form yet.
                </p>
                <FieldError field="imageUrl" errors={errors} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <RequiredFieldLabel htmlFor="event-market-location">
                  Public location
                </RequiredFieldLabel>
                <Input
                  id="event-market-location"
                  required
                  value={form.eventLocation}
                  onChange={(event) =>
                    update("eventLocation", event.target.value)
                  }
                  aria-invalid={!!errors.eventLocation}
                  aria-describedby={describedBy(
                    "event-market-location-help",
                    errors.eventLocation && "event-market-eventLocation-error"
                  )}
                />
                <p
                  id="event-market-location-help"
                  className="text-xs leading-5 text-[var(--text-muted)]"
                >
                  Venue, public address, or meeting point attendees can find.
                </p>
                <FieldError field="eventLocation" errors={errors} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-market-geohash">
                  Event geohash (optional)
                </Label>
                <Input
                  id="event-market-geohash"
                  value={form.eventGeohash}
                  onChange={(event) =>
                    update("eventGeohash", event.target.value)
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-market-calendar-type">Timing</Label>
                <Select
                  value={form.calendarType}
                  onValueChange={(value) =>
                    update(
                      "calendarType",
                      value as OrganizerEventMarketFormValues["calendarType"]
                    )
                  }
                >
                  <SelectTrigger id="event-market-calendar-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="timed">Date and time</SelectItem>
                    <SelectItem value="date">All day</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <RequiredFieldLabel htmlFor="event-market-start">
                  Start
                </RequiredFieldLabel>
                <Input
                  id="event-market-start"
                  type={dateBased ? "date" : "datetime-local"}
                  min={initialForm ? undefined : startMinimum}
                  required
                  value={form.start}
                  onChange={(event) => update("start", event.target.value)}
                  aria-invalid={!!errors.start}
                  aria-describedby={
                    errors.start ? "event-market-start-error" : undefined
                  }
                />
                <FieldError field="start" errors={errors} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-market-end">End (optional)</Label>
                <Input
                  id="event-market-end"
                  type={dateBased ? "date" : "datetime-local"}
                  min={endMinimum}
                  value={form.end}
                  onChange={(event) => update("end", event.target.value)}
                  aria-invalid={!!errors.end}
                  aria-describedby={
                    errors.end ? "event-market-end-error" : undefined
                  }
                />
                <FieldError field="end" errors={errors} />
              </div>
              {!dateBased && (
                <div className="grid gap-1.5 sm:col-span-2">
                  <RequiredFieldLabel htmlFor="event-market-timezone">
                    Event timezone
                  </RequiredFieldLabel>
                  <Select
                    value={form.timezone}
                    onValueChange={(value) => update("timezone", value)}
                  >
                    <SelectTrigger
                      id="event-market-timezone"
                      aria-required="true"
                      aria-invalid={!!errors.timezone}
                      aria-describedby={describedBy(
                        "event-market-timezone-help",
                        errors.timezone && "event-market-timezone-error"
                      )}
                    >
                      <SelectValue placeholder="Choose an IANA timezone" />
                    </SelectTrigger>
                    <SelectContent>
                      {timezoneOptions.map((timezone) => (
                        <SelectItem key={timezone} value={timezone}>
                          {timezone}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p
                    id="event-market-timezone-help"
                    className="text-xs leading-5 text-[var(--text-muted)]"
                  >
                    Detected from this browser. Choose the timezone local to the
                    event.
                  </p>
                  <FieldError field="timezone" errors={errors} />
                </div>
              )}
            </div>
          </section>

          <section className="space-y-4 border-t border-[var(--border)] pt-5">
            <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
              <Checkbox
                id="event-market-organizer-handoff"
                checked={form.organizerHandoffEnabled}
                onCheckedChange={(checked) =>
                  update("organizerHandoffEnabled", checked)
                }
              />
              <div className="grid gap-1">
                <Label htmlFor="event-market-organizer-handoff">
                  Organizer can hand out products
                </Label>
                <p className="text-pretty text-xs leading-5 text-[var(--text-muted)]">
                  Merchants confirm payment, mark products ready, and stay
                  available remotely. You receive a pickup code and their signed
                  handoff instruction, not independent payment proof or buyer
                  payment details.
                </p>
              </div>
            </div>
            {form.organizerHandoffEnabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Organizer handoff details
                  </h3>
                  <p className="mt-1 text-pretty text-xs leading-5 text-[var(--text-muted)]">
                    Pickup uses the event venue and adds no charge. Add a public
                    area hint only when buyers need more direction. Private
                    order and payment details are never published.
                  </p>
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="event-market-pickup-location">
                    Pickup point or area (optional)
                  </Label>
                  <Input
                    id="event-market-pickup-location"
                    placeholder="Registration desk, north hall, booth 12…"
                    value={form.pickupLocation}
                    onChange={(event) =>
                      update("pickupLocation", event.target.value)
                    }
                    aria-invalid={!!errors.pickupLocation}
                    aria-describedby={
                      errors.pickupLocation
                        ? "event-market-pickupLocation-error"
                        : undefined
                    }
                  />
                  <FieldError field="pickupLocation" errors={errors} />
                </div>
                <div className="grid gap-1.5 sm:max-w-40">
                  <RequiredFieldLabel htmlFor="event-market-pickup-country">
                    Event country
                  </RequiredFieldLabel>
                  <Input
                    id="event-market-pickup-country"
                    maxLength={2}
                    className="uppercase"
                    required
                    value={form.pickupCountry}
                    onChange={(event) =>
                      update("pickupCountry", event.target.value.toUpperCase())
                    }
                    aria-invalid={!!errors.pickupCountry}
                    aria-describedby={
                      errors.pickupCountry
                        ? "event-market-pickupCountry-error"
                        : undefined
                    }
                  />
                  <FieldError field="pickupCountry" errors={errors} />
                </div>
              </div>
            )}
          </section>

          <div
            className={cn(
              "rounded-xl border px-4 py-3 text-xs leading-5",
              displayedActionState === "error"
                ? "border-error/30 bg-error/10 text-error"
                : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-secondary)]"
            )}
          >
            <SignedActionStatus
              state={displayedActionState}
              message={
                displayedActionState === "idle"
                  ? "No changes to publish."
                  : undefined
              }
              dirtyMessage={
                form.organizerHandoffEnabled
                  ? "Publish the event, organizer pickup, and catalog from your signer."
                  : "Publish the event and catalog from your signer."
              }
              awaitingSignatureMessage="Confirm each organizer record in your signer."
              publishingMessage={
                form.organizerHandoffEnabled
                  ? "Publishing the signed event, pickup, and catalog records."
                  : "Publishing the signed event and catalog records."
              }
              successMessage="Organizer event market published."
              errorMessage={actionError}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || (!!initialForm && !isDirty)}
            >
              {pending
                ? "Waiting for signer…"
                : initialForm
                  ? "Publish update"
                  : "Publish event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
