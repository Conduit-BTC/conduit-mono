import { useEffect, useMemo, useState } from "react"
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
    <p className="text-xs leading-5 text-error" role="alert">
      {message}
    </p>
  ) : null
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

  useEffect(() => {
    if (!open) return
    setForm(initialForm ?? createEmptyOrganizerEventMarketForm())
    setSubmitted(false)
  }, [initialForm, open])

  const validation = useMemo(
    () => validateOrganizerEventMarketForm(form),
    [form]
  )
  const errors = submitted ? validation.errors : {}
  const pending =
    actionState === "awaiting_signature" || actionState === "publishing"
  const dateBased = form.calendarType === "date"

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
            if (validation.canPublish && !pending) onSubmit(form)
          }}
        >
          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Public event
              </h3>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                Everything here is published publicly. Keep private handoff and
                attendee details out of these fields.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="event-market-title">Title</Label>
                <Input
                  id="event-market-title"
                  value={form.title}
                  onChange={(event) => update("title", event.target.value)}
                  aria-invalid={!!errors.title}
                />
                <FieldError field="title" errors={errors} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="event-market-summary">Public summary</Label>
                <Textarea
                  id="event-market-summary"
                  className="min-h-24"
                  value={form.summary}
                  onChange={(event) => update("summary", event.target.value)}
                  aria-invalid={!!errors.summary}
                />
                <FieldError field="summary" errors={errors} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="event-market-image">Image URL</Label>
                <Input
                  id="event-market-image"
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={form.imageUrl}
                  onChange={(event) => update("imageUrl", event.target.value)}
                  aria-invalid={!!errors.imageUrl}
                />
                <FieldError field="imageUrl" errors={errors} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="event-market-location">Public location</Label>
                <Input
                  id="event-market-location"
                  value={form.eventLocation}
                  onChange={(event) =>
                    update("eventLocation", event.target.value)
                  }
                  aria-invalid={!!errors.eventLocation}
                />
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
                <Label htmlFor="event-market-start">Start</Label>
                <Input
                  id="event-market-start"
                  type={dateBased ? "date" : "datetime-local"}
                  value={form.start}
                  onChange={(event) => update("start", event.target.value)}
                  aria-invalid={!!errors.start}
                />
                <FieldError field="start" errors={errors} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="event-market-end">End (optional)</Label>
                <Input
                  id="event-market-end"
                  type={dateBased ? "date" : "datetime-local"}
                  value={form.end}
                  onChange={(event) => update("end", event.target.value)}
                  aria-invalid={!!errors.end}
                />
                <FieldError field="end" errors={errors} />
              </div>
              {!dateBased && (
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="event-market-timezone">IANA timezone</Label>
                  <Input
                    id="event-market-timezone"
                    placeholder="America/New_York"
                    value={form.timezone}
                    onChange={(event) => update("timezone", event.target.value)}
                    aria-invalid={!!errors.timezone}
                  />
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
                  Organizer can hand out merchant products
                </Label>
                <p className="text-xs leading-5 text-[var(--text-muted)]">
                  Adds a public organizer pickup option. Merchants may then
                  delegate handoff and share only the minimum receipt evidence
                  needed for you to release an item.
                </p>
              </div>
            </div>
            {form.organizerHandoffEnabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Public organizer pickup
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                    This exact handoff point is public. Buyer contact, order
                    notes, invoices, and payment details are never published.
                  </p>
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="event-market-pickup-title">
                    Pickup title
                  </Label>
                  <Input
                    id="event-market-pickup-title"
                    value={form.pickupTitle}
                    onChange={(event) =>
                      update("pickupTitle", event.target.value)
                    }
                    aria-invalid={!!errors.pickupTitle}
                  />
                  <FieldError field="pickupTitle" errors={errors} />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="event-market-pickup-location">
                    Public handoff location
                  </Label>
                  <Input
                    id="event-market-pickup-location"
                    value={form.pickupLocation}
                    onChange={(event) =>
                      update("pickupLocation", event.target.value)
                    }
                    aria-invalid={!!errors.pickupLocation}
                  />
                  <FieldError field="pickupLocation" errors={errors} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="event-market-pickup-geohash">
                    Pickup geohash (optional)
                  </Label>
                  <Input
                    id="event-market-pickup-geohash"
                    value={form.pickupGeohash}
                    onChange={(event) =>
                      update("pickupGeohash", event.target.value)
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="event-market-pickup-country">
                    Country code
                  </Label>
                  <Input
                    id="event-market-pickup-country"
                    maxLength={2}
                    className="uppercase"
                    value={form.pickupCountry}
                    onChange={(event) =>
                      update("pickupCountry", event.target.value.toUpperCase())
                    }
                    aria-invalid={!!errors.pickupCountry}
                  />
                  <FieldError field="pickupCountry" errors={errors} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="event-market-pickup-price">
                    Pickup price
                  </Label>
                  <Input
                    id="event-market-pickup-price"
                    type="text"
                    inputMode="decimal"
                    value={form.pickupPrice}
                    onChange={(event) =>
                      update("pickupPrice", event.target.value)
                    }
                    aria-invalid={!!errors.pickupPrice}
                  />
                  <FieldError field="pickupPrice" errors={errors} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="event-market-pickup-currency">Currency</Label>
                  <Input
                    id="event-market-pickup-currency"
                    className="uppercase"
                    value={form.pickupCurrency}
                    onChange={(event) =>
                      update("pickupCurrency", event.target.value.toUpperCase())
                    }
                    aria-invalid={!!errors.pickupCurrency}
                  />
                  <FieldError field="pickupCurrency" errors={errors} />
                </div>
              </div>
            )}
          </section>

          <div
            className={cn(
              "rounded-xl border px-4 py-3 text-xs leading-5",
              actionState === "error"
                ? "border-error/30 bg-error/10 text-error"
                : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-secondary)]"
            )}
          >
            <SignedActionStatus
              state={actionState}
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
            <Button type="submit" disabled={pending}>
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
