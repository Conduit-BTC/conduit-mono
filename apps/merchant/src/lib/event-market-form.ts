export type OrganizerCalendarType = "timed" | "date"

export const MAX_ORGANIZER_EVENT_DATES = 32

export interface OrganizerEventDateRow {
  id: string
  start: string
  end: string
}

export interface OrganizerEventMarketFormValues {
  calendarType: OrganizerCalendarType
  title: string
  summary: string
  imageUrl: string
  eventLocation: string
  eventGeohash: string
  start: string
  end: string
  timezone: string
}

export type OrganizerEventMarketFormField =
  | "title"
  | "summary"
  | "imageUrl"
  | "eventLocation"
  | "start"
  | "end"
  | "timezone"

export interface OrganizerEventMarketFormValidation {
  canPublish: boolean
  firstError: string | null
  errors: Partial<Record<OrganizerEventMarketFormField, string>>
}

export interface OrganizerEventValidationOptions {
  requireFutureStart?: boolean
  nowMs?: number
  /** Saved publishing plans store the NIP-52 exclusive date, including v1 plans. */
  endDateIsExclusive?: boolean
}

export interface OrganizerEventRepeat {
  frequency: "weekly" | "monthly"
  weekdays: number[]
  ends: "on_date" | "after_count"
  throughDate: string
  count: number
}

export interface PreparedOrganizerEventMarketForm {
  calendar: {
    kind: 31922 | 31923
    title: string
    summary: string
    imageUrl: string
    location: string
    geohash?: string
    start: string | number
    end?: string | number
    timezone?: string
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
const DEFAULT_ORGANIZER_EVENT_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

function localDateInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function localDateTimeInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${localDateInputValue(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function getOrganizerEventStartMinimum(
  calendarType: OrganizerCalendarType,
  nowMs = Date.now()
): string {
  const now = new Date(nowMs)
  if (calendarType === "date") return localDateInputValue(now)
  const nextMinute = new Date(Math.ceil((nowMs + 1) / 60_000) * 60_000)
  return localDateTimeInputValue(nextMinute)
}

export function getOrganizerEventEndMinimum(
  calendarType: OrganizerCalendarType,
  start: string,
  fallbackStartMinimum: string
): string {
  if (!start) return fallbackStartMinimum
  const parsed = new Date(calendarType === "date" ? `${start}T00:00:00` : start)
  if (!Number.isFinite(parsed.getTime())) return fallbackStartMinimum
  if (calendarType === "timed") parsed.setMinutes(parsed.getMinutes() + 1)
  return calendarType === "date"
    ? localDateInputValue(parsed)
    : localDateTimeInputValue(parsed)
}

export function createEmptyOrganizerEventMarketForm(): OrganizerEventMarketFormValues {
  return {
    calendarType: "timed",
    title: "",
    summary: "",
    imageUrl: "",
    eventLocation: "",
    eventGeohash: "",
    start: "",
    end: "",
    timezone: browserTimezone(),
  }
}

export function isOrganizerEventMarketFormDirty(
  form: OrganizerEventMarketFormValues,
  initialForm: OrganizerEventMarketFormValues
): boolean {
  return (
    Object.keys(form) as Array<keyof OrganizerEventMarketFormValues>
  ).some((field) => form[field] !== initialForm[field])
}

function isValidCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value)
  if (!match) return false

  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  )
}

function shiftCalendarDate(value: string, days: number): string {
  if (!isValidCalendarDate(value)) throw new Error("Add a valid calendar date.")
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The date shown in the form is the last day of the event. */
export function getOrganizerInclusiveEndDate(
  start: string,
  exclusiveEnd?: string
): string {
  return exclusiveEnd ? shiftCalendarDate(exclusiveEnd, -1) : start
}

/** Keep date arithmetic in civil calendar days, independent of timezone/DST. */
export function getOrganizerExclusiveEndDate(
  start: string,
  inclusiveEnd: string
): string {
  if (
    !isValidCalendarDate(start) ||
    !isValidCalendarDate(inclusiveEnd) ||
    inclusiveEnd < start
  )
    throw new Error("End date must be on or after the start date.")
  return shiftCalendarDate(inclusiveEnd, 1)
}

export function toStoredOrganizerEventForm(
  form: OrganizerEventMarketFormValues
): OrganizerEventMarketFormValues {
  return {
    ...form,
    end:
      form.calendarType === "date" && form.end
        ? getOrganizerExclusiveEndDate(form.start, form.end)
        : form.end,
  }
}

export function fromStoredOrganizerEventForm(
  form: OrganizerEventMarketFormValues
): OrganizerEventMarketFormValues {
  return {
    ...form,
    end:
      form.calendarType === "date"
        ? getOrganizerInclusiveEndDate(form.start, form.end)
        : form.end,
  }
}

/** Expand the form's repeat choice to finite, editable NIP-52 occurrences. */
export function generateOrganizerRecurringDates(
  form: OrganizerEventMarketFormValues,
  repeat: OrganizerEventRepeat
): OrganizerEventDateRow[] {
  const firstDate = form.start.slice(0, 10)
  const lastDate = form.end.slice(0, 10)
  if (!isValidCalendarDate(firstDate) || !isValidCalendarDate(lastDate))
    throw new Error("Choose the event's start and end before repeating it.")
  if (form.calendarType === "date") {
    getOrganizerExclusiveEndDate(firstDate, lastDate)
  } else {
    try {
      if (
        localDateTimeToEpochSeconds(form.end, form.timezone) <=
        localDateTimeToEpochSeconds(form.start, form.timezone)
      )
        throw new Error("End time must be after the start time.")
    } catch (cause) {
      throw new Error(
        `${firstDate}: ${cause instanceof Error ? cause.message : "Invalid local hours."}`,
        { cause }
      )
    }
  }
  if (
    repeat.ends === "after_count" &&
    (!Number.isInteger(repeat.count) ||
      repeat.count < 1 ||
      repeat.count > MAX_ORGANIZER_EVENT_DATES)
  )
    throw new Error(`Choose 1 to ${MAX_ORGANIZER_EVENT_DATES} occurrences.`)
  if (
    repeat.ends === "on_date" &&
    (!isValidCalendarDate(repeat.throughDate) || repeat.throughDate < firstDate)
  )
    throw new Error("Repeat until must be on or after the event's first date.")
  if (
    repeat.frequency === "weekly" &&
    (!repeat.weekdays.length ||
      repeat.weekdays.some(
        (day) => !Number.isInteger(day) || day < 0 || day > 6
      ))
  )
    throw new Error("Choose at least one weekday.")
  const daySpan =
    (Date.parse(`${lastDate}T00:00:00Z`) -
      Date.parse(`${firstDate}T00:00:00Z`)) /
    86_400_000
  const rows: OrganizerEventDateRow[] = []
  const weekdays = new Set(repeat.weekdays)
  const first = new Date(`${firstDate}T00:00:00Z`)
  let cursor = firstDate
  let monthOffset = 0
  while (
    repeat.ends === "after_count"
      ? rows.length < repeat.count
      : cursor <= repeat.throughDate
  ) {
    const day = new Date(`${cursor}T00:00:00Z`)
    if (repeat.frequency === "monthly" || weekdays.has(day.getUTCDay())) {
      const endDate = shiftCalendarDate(cursor, daySpan)
      const start = cursor + form.start.slice(10)
      const end = endDate + form.end.slice(10)
      if (form.calendarType === "timed") {
        try {
          if (
            localDateTimeToEpochSeconds(end, form.timezone) <=
            localDateTimeToEpochSeconds(start, form.timezone)
          )
            throw new Error("End must be after start in the selected timezone.")
        } catch (cause) {
          throw new Error(
            `${cursor}: ${cause instanceof Error ? cause.message : "Invalid local hours."}`,
            { cause }
          )
        }
      }
      rows.push({ id: `${repeat.frequency}-${cursor}`, start, end })
      if (rows.length > MAX_ORGANIZER_EVENT_DATES)
        throw new Error(
          `Generate at most ${MAX_ORGANIZER_EVENT_DATES} dates at a time.`
        )
    }
    if (repeat.frequency === "weekly") cursor = shiftCalendarDate(cursor, 1)
    else {
      // A monthly event on the 31st skips months without a 31st; it never moves earlier.
      do {
        monthOffset += 1
        const next = new Date(
          Date.UTC(
            first.getUTCFullYear(),
            first.getUTCMonth() + monthOffset,
            first.getUTCDate()
          )
        )
        const expectedMonth = (first.getUTCMonth() + monthOffset) % 12
        if (next.getUTCMonth() === expectedMonth) {
          cursor = next.toISOString().slice(0, 10)
          break
        }
      } while (monthOffset <= MAX_ORGANIZER_EVENT_DATES * 12)
    }
  }
  if (!rows.length)
    throw new Error("No selected dates fall in that repeat range.")
  return rows
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

export function getOrganizerEventTimezoneOptions(
  ...preferredTimezones: string[]
): string[] {
  const candidates = [
    ...preferredTimezones,
    browserTimezone(),
    ...DEFAULT_ORGANIZER_EVENT_TIMEZONES,
  ]
  return Array.from(
    new Set(
      candidates
        .map((timezone) => timezone.trim())
        .filter((timezone) => timezone && isValidTimezone(timezone))
    )
  )
}

function timezoneParts(epochMs: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs))

  const values = new Map(parts.map((part) => [part.type, part.value]))
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  }
}

export function epochSecondsToLocalDateTime(
  epochSeconds: number,
  timezone: string
): string {
  if (!Number.isFinite(epochSeconds) || !isValidTimezone(timezone)) return ""
  const parts = timezoneParts(epochSeconds * 1_000, timezone)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

export function localDateTimeToEpochSeconds(
  value: string,
  timezone: string
): number {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value)
  if (!match || !isValidTimezone(timezone)) {
    throw new Error("Enter a valid local date, time, and timezone.")
  }

  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  }
  if (
    !isValidCalendarDate(value.slice(0, 10)) ||
    desired.hour > 23 ||
    desired.minute > 59 ||
    desired.second > 59
  ) {
    throw new Error("Enter a valid local date, time, and timezone.")
  }
  const utcGuess = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second
  )

  // Sampling either side of the local day finds both offsets at a DST fold.
  // A single round trip can silently choose one of two valid instants.
  const offsets = new Set<number>()
  for (const probe of [
    utcGuess - 86_400_000,
    utcGuess,
    utcGuess + 86_400_000,
  ]) {
    const observed = timezoneParts(probe, timezone)
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    )
    offsets.add(observedAsUtc - probe)
  }
  const matches = [...offsets]
    .map((offset) => utcGuess - offset)
    .filter((epochMs) => {
      const roundTrip = timezoneParts(epochMs, timezone)
      return (
        roundTrip.year === desired.year &&
        roundTrip.month === desired.month &&
        roundTrip.day === desired.day &&
        roundTrip.hour === desired.hour &&
        roundTrip.minute === desired.minute &&
        roundTrip.second === desired.second
      )
    })
  if (matches.length === 0) {
    throw new Error(
      "That local time does not exist in the selected timezone. Choose another time."
    )
  }
  if (matches.length > 1) {
    throw new Error(
      "That local time occurs twice in the selected timezone. Choose another time."
    )
  }

  return Math.floor(matches[0] / 1000)
}

export function prepareOrganizerEventMarketDates(
  form: OrganizerEventMarketFormValues,
  rows: OrganizerEventDateRow[],
  options: OrganizerEventValidationOptions = {}
): PreparedOrganizerEventMarketForm[] {
  if (rows.length === 0 || rows.length > MAX_ORGANIZER_EVENT_DATES) {
    throw new Error(`Add 1 to ${MAX_ORGANIZER_EVENT_DATES} dates.`)
  }
  const seen = new Set<string>()
  return rows.map((row, index) => {
    let prepared: PreparedOrganizerEventMarketForm
    try {
      prepared = prepareOrganizerEventMarketForm(
        { ...form, start: row.start, end: row.end },
        options
      )
    } catch (cause) {
      throw new Error(
        `Date ${index + 1}: ${cause instanceof Error ? cause.message : "Invalid date."}`,
        { cause }
      )
    }
    const key = `${prepared.calendar.kind}:${String(prepared.calendar.start)}`
    if (seen.has(key))
      throw new Error(`Date ${index + 1} duplicates another start.`)
    seen.add(key)
    return prepared
  })
}

function addError(
  errors: OrganizerEventMarketFormValidation["errors"],
  field: OrganizerEventMarketFormField,
  message: string
): void {
  if (!errors[field]) errors[field] = message
}

function normalizedOptional(value: string): string | undefined {
  const normalized = value.trim()
  return normalized || undefined
}

export function validateOrganizerEventMarketForm(
  form: OrganizerEventMarketFormValues,
  options: OrganizerEventValidationOptions = {}
): OrganizerEventMarketFormValidation {
  const errors: OrganizerEventMarketFormValidation["errors"] = {}
  const title = form.title.trim()
  const summary = form.summary.trim()
  const imageUrl = form.imageUrl.trim()
  const eventLocation = form.eventLocation.trim()
  const timezone = form.timezone.trim()

  if (!title) addError(errors, "title", "Add an event title.")
  if (!summary) addError(errors, "summary", "Add a public event summary.")
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
    addError(errors, "imageUrl", "Event image URL must start with https://.")
  }
  if (!eventLocation) {
    addError(errors, "eventLocation", "Add the public event location.")
  }

  if (form.calendarType === "date") {
    if (!isValidCalendarDate(form.start)) {
      addError(errors, "start", "Add a valid start date.")
    } else if (
      options.requireFutureStart &&
      form.start <
        getOrganizerEventStartMinimum("date", options.nowMs ?? Date.now())
    ) {
      addError(errors, "start", "Start date must be today or later.")
    }
    if (form.end && !isValidCalendarDate(form.end)) {
      addError(errors, "end", "Add a valid end date.")
    } else if (
      form.end &&
      form.start &&
      (form.end < form.start ||
        (options.endDateIsExclusive && form.end === form.start))
    ) {
      addError(
        errors,
        "end",
        options.endDateIsExclusive
          ? "End date must be after the start date."
          : "End date must be on or after the start date."
      )
    }
  } else {
    if (!timezone || !isValidTimezone(timezone)) {
      addError(errors, "timezone", "Choose a valid IANA timezone.")
    }
    let start: number | null = null
    if (!form.start) {
      addError(errors, "start", "Add a start date and time.")
    } else if (!errors.timezone) {
      try {
        start = localDateTimeToEpochSeconds(form.start, timezone)
        if (
          options.requireFutureStart &&
          start * 1_000 <= (options.nowMs ?? Date.now())
        ) {
          addError(errors, "start", "Start time must be in the future.")
        }
      } catch (error) {
        addError(
          errors,
          "start",
          error instanceof Error ? error.message : "Add a valid start time."
        )
      }
    }
    if (form.end && !errors.timezone) {
      try {
        const end = localDateTimeToEpochSeconds(form.end, timezone)
        if (start !== null && end <= start) {
          addError(errors, "end", "End time must be after the start time.")
        }
      } catch (error) {
        addError(
          errors,
          "end",
          error instanceof Error ? error.message : "Add a valid end time."
        )
      }
    }
  }

  const firstError = Object.values(errors)[0] ?? null
  return { canPublish: !firstError, firstError, errors }
}

export function prepareOrganizerEventMarketForm(
  form: OrganizerEventMarketFormValues,
  options: OrganizerEventValidationOptions = {}
): PreparedOrganizerEventMarketForm {
  const validation = validateOrganizerEventMarketForm(form, options)
  if (!validation.canPublish) {
    throw new Error(validation.firstError ?? "Event market form is invalid.")
  }

  const timed = form.calendarType === "timed"
  const timezone = form.timezone.trim()
  const end = normalizedOptional(form.end)
  return {
    calendar: {
      kind: timed ? 31923 : 31922,
      title: form.title.trim(),
      summary: form.summary.trim(),
      imageUrl: form.imageUrl.trim(),
      location: form.eventLocation.trim(),
      geohash: normalizedOptional(form.eventGeohash),
      start: timed
        ? localDateTimeToEpochSeconds(form.start, timezone)
        : form.start,
      end: end
        ? timed
          ? localDateTimeToEpochSeconds(end, timezone)
          : options.endDateIsExclusive
            ? end
            : getOrganizerExclusiveEndDate(form.start, end)
        : undefined,
      timezone: timed ? timezone : undefined,
    },
  }
}

export function slugifyEventMarketTitle(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "event"
  )
}
