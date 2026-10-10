import { CalendarDays, Plus, Trash2 } from "lucide-react"
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import {
  MAX_ORGANIZER_EVENT_DATES,
  type OrganizerEventDateRow,
  type OrganizerEventMarketFormValues,
  type OrganizerEventRepeat,
} from "../lib/event-market-form"
import { EventTimezoneField } from "./EventAuthoringFields"

export type EventRepeatMode = "none" | "weekly" | "monthly" | "custom"
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

function EventDateRangeFields({
  id,
  type,
  start,
  end,
  onChange,
}: {
  id: string
  type: "date" | "timed"
  start: string
  end: string
  onChange: (field: "start" | "end", value: string) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={`${id}-start`}>Start</Label>
        <Input
          id={`${id}-start`}
          type={type === "date" ? "date" : "datetime-local"}
          value={start}
          required
          onChange={(event) => onChange("start", event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-end`}>End</Label>
        <Input
          id={`${id}-end`}
          type={type === "date" ? "date" : "datetime-local"}
          value={end}
          required
          min={start}
          onChange={(event) => onChange("end", event.target.value)}
        />
      </div>
    </div>
  )
}

export function EventScheduleFields({
  form,
  onFormChange,
  mode,
  onModeChange,
  repeat,
  onRepeatChange,
  rows,
  onRowsChange,
  error,
}: {
  form: OrganizerEventMarketFormValues
  onFormChange: (form: OrganizerEventMarketFormValues) => void
  mode: EventRepeatMode
  onModeChange: (mode: EventRepeatMode) => void
  repeat: OrganizerEventRepeat
  onRepeatChange: (repeat: OrganizerEventRepeat) => void
  rows: OrganizerEventDateRow[]
  onRowsChange: (rows: OrganizerEventDateRow[]) => void
  error: string
}) {
  function changeRange(field: "start" | "end", value: string) {
    if (
      field === "start" &&
      value &&
      !form.start &&
      mode === "weekly" &&
      !repeat.weekdays.length
    )
      onRepeatChange({
        ...repeat,
        weekdays: [new Date(`${value.slice(0, 10)}T00:00:00Z`).getUTCDay()],
      })
    onFormChange({
      ...form,
      [field]: value,
      ...(field === "start" &&
      form.calendarType === "date" &&
      (!form.end || form.end < value)
        ? { end: value }
        : {}),
    })
  }
  function changeType(allDay: boolean) {
    const calendarType = allDay ? "date" : "timed"
    const value = (value: string, hour: string) =>
      !value
        ? ""
        : allDay
          ? value.slice(0, 10)
          : value.includes("T")
            ? value
            : `${value}T${hour}`
    const start = value(form.start, "09:00")
    const end = value(form.end || form.start, "17:00")
    onFormChange({ ...form, calendarType, start, end })
    if (mode === "custom")
      onRowsChange(
        rows.map((row) => ({
          ...row,
          start: value(row.start, "09:00"),
          end: value(row.end || row.start, "17:00"),
        }))
      )
  }
  function changeMode(next: EventRepeatMode) {
    if (next === "weekly" && !repeat.weekdays.length && form.start) {
      onRepeatChange({
        ...repeat,
        weekdays: [
          new Date(`${form.start.slice(0, 10)}T00:00:00Z`).getUTCDay(),
        ],
      })
    }
    if (next === "custom")
      onRowsChange(
        rows.length
          ? rows
          : [{ id: crypto.randomUUID(), start: form.start, end: form.end }]
      )
    onModeChange(next)
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-balance font-medium">Date and time</h3>
        <Label
          htmlFor="future-all-day"
          className="flex min-h-11 cursor-pointer items-center gap-2"
        >
          <Checkbox
            id="future-all-day"
            checked={form.calendarType === "date"}
            onCheckedChange={changeType}
          />
          All day
        </Label>
      </div>
      {mode !== "custom" ? (
        <EventDateRangeFields
          id="future"
          type={form.calendarType}
          start={form.start}
          end={form.end}
          onChange={changeRange}
        />
      ) : null}
      {form.calendarType === "timed" ? (
        <EventTimezoneField
          id="future-timezone"
          value={form.timezone}
          onChange={(timezone) => onFormChange({ ...form, timezone })}
        />
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="future-repeat">Repeat</Label>
        <Select
          value={mode}
          onValueChange={(next) => changeMode(next as EventRepeatMode)}
        >
          <SelectTrigger id="future-repeat">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Does not repeat</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
            <SelectItem value="custom">Custom dates</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {mode === "weekly" || mode === "monthly" ? (
        <div className="space-y-4 rounded-[var(--radius-md)] border border-[var(--border)] p-4">
          {mode === "weekly" ? (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Repeat on</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {WEEKDAYS.map((label, day) => (
                  <Label
                    key={day}
                    htmlFor={`future-weekday-${day}`}
                    className="flex min-h-11 cursor-pointer items-center gap-2"
                  >
                    <Checkbox
                      id={`future-weekday-${day}`}
                      checked={repeat.weekdays.includes(day)}
                      onCheckedChange={(checked) =>
                        onRepeatChange({
                          ...repeat,
                          weekdays: checked
                            ? [...repeat.weekdays, day]
                            : repeat.weekdays.filter((value) => value !== day),
                        })
                      }
                    />
                    {label}
                  </Label>
                ))}
              </div>
            </fieldset>
          ) : (
            <p className="text-pretty text-sm text-[var(--text-secondary)]">
              Repeats on the same day of the month. Months without that date are
              skipped.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="future-repeat-ends">Ends</Label>
              <Select
                value={repeat.ends}
                onValueChange={(ends) =>
                  onRepeatChange({
                    ...repeat,
                    ends: ends as OrganizerEventRepeat["ends"],
                  })
                }
              >
                <SelectTrigger id="future-repeat-ends">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="after_count">
                    After a number of dates
                  </SelectItem>
                  <SelectItem value="on_date">On a date</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              {repeat.ends === "after_count" ? (
                <>
                  <Label htmlFor="future-repeat-count">Number of dates</Label>
                  <Input
                    id="future-repeat-count"
                    type="number"
                    min={1}
                    max={MAX_ORGANIZER_EVENT_DATES}
                    value={repeat.count || ""}
                    onChange={(event) =>
                      onRepeatChange({
                        ...repeat,
                        count: Number(event.target.value),
                      })
                    }
                  />
                </>
              ) : (
                <>
                  <Label htmlFor="future-repeat-until">Repeat until</Label>
                  <Input
                    id="future-repeat-until"
                    type="date"
                    min={form.start.slice(0, 10)}
                    value={repeat.throughDate}
                    onChange={(event) =>
                      onRepeatChange({
                        ...repeat,
                        throughDate: event.target.value,
                      })
                    }
                  />
                </>
              )}
            </div>
          </div>
          {rows.length ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium tabular-nums">
                <CalendarDays className="size-4" aria-hidden="true" />
                {rows.length} {rows.length === 1 ? "date" : "dates"}
              </p>
              <ol
                aria-label="Repeating dates preview"
                className="max-h-60 space-y-1 overflow-y-auto text-sm tabular-nums text-[var(--text-secondary)]"
              >
                {rows.map((row) => (
                  <li key={row.id}>
                    {row.start.replace("T", " ")}
                    {row.end !== row.start
                      ? ` – ${row.end.replace("T", " ")}`
                      : " · All day"}
                  </li>
                ))}
              </ol>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => changeMode("custom")}
              >
                Edit individual dates
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {mode === "custom" ? (
        <div className="space-y-3">
          {rows.map((row, index) => (
            <div
              key={row.id}
              className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-balance font-medium">Date {index + 1}</h4>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove date ${index + 1}`}
                  onClick={() =>
                    onRowsChange(rows.filter((item) => item.id !== row.id))
                  }
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Remove
                </Button>
              </div>
              <EventDateRangeFields
                id={`future-date-${row.id}`}
                type={form.calendarType}
                start={row.start}
                end={row.end}
                onChange={(field, value) =>
                  onRowsChange(
                    rows.map((item) =>
                      item.id === row.id
                        ? {
                            ...item,
                            [field]: value,
                            ...(field === "start" &&
                            form.calendarType === "date" &&
                            (!item.end || item.end < value)
                              ? { end: value }
                              : {}),
                          }
                        : item
                    )
                  )
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={rows.length >= MAX_ORGANIZER_EVENT_DATES}
            onClick={() =>
              onRowsChange([
                ...rows,
                { id: crypto.randomUUID(), start: "", end: "" },
              ])
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            Add date
          </Button>
        </div>
      ) : null}
      {mode !== "none" ? (
        <p className="text-pretty text-xs text-[var(--text-muted)]">
          Publish up to {MAX_ORGANIZER_EVENT_DATES} dates at a time. You can add
          more dates later.
        </p>
      ) : null}
      {error ? (
        <p
          role="status"
          className="text-pretty text-sm text-[var(--text-secondary)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
