import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"

type NostrTag = string[]

interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: NostrTag[]
  content: string
  sig: string
}

interface NostrFilter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  [key: `#${string}`]: string[] | undefined
}

interface RelayMessage {
  type: string
  payload: unknown[]
}

const RELAY_PORT = Number(process.env.RELAY_PORT ?? "7777")
const RELAY_HOST = process.env.RELAY_HOST ?? "127.0.0.1"
const RELAY_DATA_DIR = process.env.RELAY_DATA_DIR ?? "context/relay-bun"
const EVENTS_FILE = path.join(RELAY_DATA_DIR, "events.jsonl")

const eventsById = new Map<string, NostrEvent>()
const clients = new Set<
  ServerWebSocket<{ subscriptions: Map<string, NostrFilter[]> }>
>()

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

function normalizeFilter(raw: unknown): NostrFilter | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const filter: NostrFilter = {}

  if (isStringArray(source.ids)) filter.ids = source.ids
  if (isStringArray(source.authors)) filter.authors = source.authors
  if (
    Array.isArray(source.kinds) &&
    source.kinds.every((v) => typeof v === "number")
  ) {
    filter.kinds = source.kinds as number[]
  }
  if (typeof source.since === "number") filter.since = source.since
  if (typeof source.until === "number") filter.until = source.until
  if (typeof source.limit === "number") filter.limit = source.limit

  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("#") && isStringArray(value)) {
      filter[key as `#${string}`] = value
    }
  }

  return filter
}

function normalizeEvent(raw: unknown): NostrEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>

  if (typeof source.id !== "string") return null
  if (typeof source.pubkey !== "string") return null
  if (typeof source.created_at !== "number") return null
  if (typeof source.kind !== "number") return null
  if (
    !Array.isArray(source.tags) ||
    !source.tags.every(
      (t) => Array.isArray(t) && t.every((v) => typeof v === "string")
    )
  ) {
    return null
  }
  if (typeof source.content !== "string") return null
  if (typeof source.sig !== "string") return null

  return {
    id: source.id,
    pubkey: source.pubkey,
    created_at: source.created_at,
    kind: source.kind,
    tags: source.tags as NostrTag[],
    content: source.content,
    sig: source.sig,
  }
}

function eventMatchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (
    filter.ids &&
    !filter.ids.some((idPrefix) => event.id.startsWith(idPrefix))
  ) {
    return false
  }

  if (
    filter.authors &&
    !filter.authors.some((authorPrefix) =>
      event.pubkey.startsWith(authorPrefix)
    )
  ) {
    return false
  }

  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false
  }

  if (typeof filter.since === "number" && event.created_at < filter.since) {
    return false
  }

  if (typeof filter.until === "number" && event.created_at > filter.until) {
    return false
  }

  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !value || value.length === 0) continue
    const tagName = key.slice(1)
    const hasTagMatch = event.tags.some(
      (tag) => tag[0] === tagName && value.includes(tag[1] ?? "")
    )
    if (!hasTagMatch) return false
  }

  return true
}

function queryEvents(filters: NostrFilter[]): NostrEvent[] {
  const deduped = new Map<string, NostrEvent>()
  const allEvents = Array.from(eventsById.values())

  for (const filter of filters) {
    const matches = allEvents
      .filter((event) => eventMatchesFilter(event, filter))
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))

    const limited =
      typeof filter.limit === "number"
        ? matches.slice(0, filter.limit)
        : matches
    for (const event of limited) deduped.set(event.id, event)
  }

  return Array.from(deduped.values()).sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)
  )
}

function loadPersistedEvents() {
  if (!existsSync(EVENTS_FILE)) return
  const lines = readFileSync(EVENTS_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    try {
      const parsed = normalizeEvent(JSON.parse(line))
      if (parsed) eventsById.set(parsed.id, parsed)
    } catch {
      // Ignore malformed persisted lines.
    }
  }
}

function persistEvent(event: NostrEvent) {
  appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, "utf8")
}

function send(
  ws: ServerWebSocket<{ subscriptions: Map<string, NostrFilter[]> }>,
  data: unknown[]
) {
  ws.send(JSON.stringify(data))
}

function parseMessage(raw: string): RelayMessage | null {
  try {
    const parsed = JSON.parse(raw)
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      typeof parsed[0] !== "string"
    )
      return null
    return { type: parsed[0], payload: parsed.slice(1) }
  } catch {
    return null
  }
}

function replaySubscription(
  ws: ServerWebSocket<{ subscriptions: Map<string, NostrFilter[]> }>,
  subId: string,
  filters: NostrFilter[]
) {
  const matches = queryEvents(filters)
  for (const event of matches) send(ws, ["EVENT", subId, event])
  send(ws, ["EOSE", subId])
}

function broadcastEvent(event: NostrEvent) {
  for (const ws of clients) {
    for (const [subId, filters] of ws.data.subscriptions.entries()) {
      if (filters.some((filter) => eventMatchesFilter(event, filter))) {
        send(ws, ["EVENT", subId, event])
      }
    }
  }
}

function handleEvent(
  ws: ServerWebSocket<{ subscriptions: Map<string, NostrFilter[]> }>,
  payload: unknown[]
) {
  const maybeEvent = normalizeEvent(payload[0])
  if (!maybeEvent) {
    send(ws, ["NOTICE", "Invalid event payload"])
    return
  }

  const alreadyExists = eventsById.has(maybeEvent.id)
  if (!alreadyExists) {
    eventsById.set(maybeEvent.id, maybeEvent)
    persistEvent(maybeEvent)
    broadcastEvent(maybeEvent)
  }

  send(ws, [
    "OK",
    maybeEvent.id,
    true,
    alreadyExists ? "duplicate: accepted" : "saved",
  ])
}

function handleReq(
  ws: ServerWebSocket<{ subscriptions: Map<string, NostrFilter[]> }>,
  payload: unknown[]
) {
  const subId = payload[0]
  if (typeof subId !== "string") {
    send(ws, ["NOTICE", "REQ missing subscription id"])
    return
  }

  const rawFilters = payload.slice(1)
  const filters = rawFilters
    .map((filter) => normalizeFilter(filter))
    .filter((filter): filter is NostrFilter => filter !== null)

  if (filters.length === 0) {
    send(ws, ["NOTICE", `REQ ${subId} has no valid filters`])
    send(ws, ["EOSE", subId])
    return
  }

  ws.data.subscriptions.set(subId, filters)
  replaySubscription(ws, subId, filters)
}

function handleClose(
  ws: ServerWebSocket<{ subscriptions: Map<string, NostrFilter[]> }>,
  payload: unknown[]
) {
  const subId = payload[0]
  if (typeof subId === "string") {
    ws.data.subscriptions.delete(subId)
  }
}

mkdirSync(RELAY_DATA_DIR, { recursive: true })
loadPersistedEvents()

const server = Bun.serve<{ subscriptions: Map<string, NostrFilter[]> }>({
  hostname: RELAY_HOST,
  port: RELAY_PORT,
  fetch(req, serverInstance) {
    if (serverInstance.upgrade(req, { data: { subscriptions: new Map() } })) {
      return
    }
    return new Response("Conduit Bun relay is running", { status: 200 })
  },
  websocket: {
    open(ws) {
      clients.add(ws)
    },
    close(ws) {
      clients.delete(ws)
    },
    message(ws, message) {
      const raw =
        typeof message === "string"
          ? message
          : Buffer.from(message).toString("utf8")
      const parsed = parseMessage(raw)
      if (!parsed) {
        send(ws, ["NOTICE", "Invalid relay message"])
        return
      }

      switch (parsed.type) {
        case "EVENT":
          handleEvent(ws, parsed.payload)
          return
        case "REQ":
          handleReq(ws, parsed.payload)
          return
        case "CLOSE":
          handleClose(ws, parsed.payload)
          return
        default:
          send(ws, ["NOTICE", `Unsupported message type: ${parsed.type}`])
      }
    },
  },
})

console.log(`Conduit Bun relay listening on ws://${RELAY_HOST}:${RELAY_PORT}`)
console.log(`Persisted events file: ${EVENTS_FILE}`)
console.log(`Loaded events: ${eventsById.size}`)

const shutdown = () => {
  server.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
