export type OrganizerCalendarType = "timed" | "date"

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
  organizerHandoffEnabled: boolean
  pickupTitle: string
  pickupLocation: string
  pickupGeohash: string
  pickupCountry: string
  pickupPrice: string
  pickupCurrency: string
}

export type OrganizerEventMarketFormField =
  | "title"
  | "summary"
  | "imageUrl"
  | "eventLocation"
  | "start"
  | "end"
  | "timezone"
  | "pickupLocation"
  | "pickupCountry"

export interface OrganizerEventMarketFormValidation {
  canPublish: boolean
  firstError: string | null
  errors: Partial<Record<OrganizerEventMarketFormField, string>>
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
  pickup?: {
    title: string
    location?: string
    geohash?: string
    country: string
    price: string
    currency: string
  }
  collection: {
    title: string
    summary: string
    imageUrl: string
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
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
  if (calendarType === "date") parsed.setDate(parsed.getDate() + 1)
  else parsed.setMinutes(parsed.getMinutes() + 1)
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
    organizerHandoffEnabled: false,
    pickupTitle: "Event pickup",
    pickupLocation: "",
    pickupGeohash: "",
    pickupCountry: "US",
    pickupPrice: "0",
    pickupCurrency: "SAT",
  }
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

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
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
  const utcGuess = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second
  )

  let epochMs = utcGuess
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const observed = timezoneParts(epochMs, timezone)
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    )
    const correction = utcGuess - observedAsUtc
    if (correction === 0) break
    epochMs += correction
  }

  const roundTrip = timezoneParts(epochMs, timezone)
  if (
    roundTrip.year !== desired.year ||
    roundTrip.month !== desired.month ||
    roundTrip.day !== desired.day ||
    roundTrip.hour !== desired.hour ||
    roundTrip.minute !== desired.minute ||
    roundTrip.second !== desired.second
  ) {
    throw new Error(
      "That local time does not exist in the selected timezone. Choose another time."
    )
  }

  return Math.floor(epochMs / 1000)
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
  options: { requireFutureStart?: boolean; nowMs?: number } = {}
): OrganizerEventMarketFormValidation {
  const errors: OrganizerEventMarketFormValidation["errors"] = {}
  const title = form.title.trim()
  const summary = form.summary.trim()
  const imageUrl = form.imageUrl.trim()
  const eventLocation = form.eventLocation.trim()
  const timezone = form.timezone.trim()
  const pickupCountry = form.pickupCountry.trim().toUpperCase()

  if (!title) addError(errors, "title", "Add an event title.")
  if (!summary) addError(errors, "summary", "Add a public event summary.")
  if (!imageUrl) {
    addError(errors, "imageUrl", "Add an event image URL.")
  } else if (!/^https:\/\//i.test(imageUrl)) {
    addError(errors, "imageUrl", "Event image URL must start with https://.")
  }
  if (!eventLocation) {
    addError(errors, "eventLocation", "Add the public event location.")
  }
  if (form.organizerHandoffEnabled) {
    if (!/^[A-Z]{2}$/.test(pickupCountry)) {
      addError(errors, "pickupCountry", "Use a two-letter country code.")
    }
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
    } else if (form.end && form.start && form.end <= form.start) {
      addError(errors, "end", "End date must be after the start date.")
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
  options: { requireFutureStart?: boolean; nowMs?: number } = {}
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
          : end
        : undefined,
      timezone: timed ? timezone : undefined,
    },
    pickup: form.organizerHandoffEnabled
      ? {
          title: "Event pickup",
          location:
            normalizedOptional(form.pickupLocation) ??
            normalizedOptional(form.eventLocation),
          geohash:
            normalizedOptional(form.pickupGeohash) ??
            normalizedOptional(form.eventGeohash),
          country: form.pickupCountry.trim().toUpperCase(),
          price: "0",
          currency: "SAT",
        }
      : undefined,
    collection: {
      title: form.title.trim(),
      summary: form.summary.trim(),
      imageUrl: form.imageUrl.trim(),
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
