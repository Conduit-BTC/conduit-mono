import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  validateEvent,
  verifyEvent,
  type Event as NostrEvent,
} from "nostr-tools/pure"
import {
  isAddressableKind,
  isEphemeralKind,
  isReplaceableKind,
} from "nostr-tools/kinds"

type NostrFilter = {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  [key: `#${string}`]: string[] | undefined
}

type RelayMessage = {
  type: string
  payload: unknown[]
}

type RelaySocketData = {
  subscriptions: Map<string, NostrFilter[]>
  challenge: string
  authenticatedPubkey: string | null
}

export type RelayFaultMode =
  "none" | "reject-writes" | "drop-acks" | "delay-reads" | "partial-reads"

export interface RelayServerOptions {
  hostname?: string
  port?: number
  persistence?: boolean
  dataDir?: string
  faultMode?: RelayFaultMode
  readDelayMs?: number
  partialReadLimit?: number
  now?: () => number
}

type StoreEventResult =
  | { accepted: true; status: "duplicate" | "ephemeral" | "stored" }
  | { accepted: false; status: "invalid" | "superseded" }

type ProtectedReadPlan =
  | { status: "public" }
  | { status: "invalid" }
  | { status: "protected"; recipient: string }

const GIFT_WRAP_KIND = 1_059
const NIP42_AUTH_KIND = 22_242
const NIP42_AUTH_FRESHNESS_SECONDS = 10 * 60
const HEX_IDENTIFIER_PATTERN = /^[0-9a-f]{64}$/
const FILTER_TAG_KEY_PATTERN = /^#[A-Za-z]$/
const NIP01_FILTER_KEYS = new Set([
  "ids",
  "authors",
  "kinds",
  "since",
  "until",
  "limit",
])

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key)
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  )
}

function isIdentifierArray(value: unknown): value is string[] {
  return (
    isNonEmptyStringArray(value) &&
    value.every((item) => HEX_IDENTIFIER_PATTERN.test(item))
  )
}

function normalizeFilter(raw: unknown): NostrFilter | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const filter: NostrFilter = {}

  if (hasOwn(source, "ids")) {
    if (!isIdentifierArray(source.ids)) return null
    filter.ids = source.ids
  }
  if (hasOwn(source, "authors")) {
    if (!isIdentifierArray(source.authors)) return null
    filter.authors = source.authors
  }
  if (hasOwn(source, "kinds")) {
    if (
      !Array.isArray(source.kinds) ||
      source.kinds.length === 0 ||
      !source.kinds.every(
        (value) =>
          Number.isSafeInteger(value) &&
          Number(value) >= 0 &&
          Number(value) <= 65_535
      )
    ) {
      return null
    }
    filter.kinds = source.kinds as number[]
  }
  if (hasOwn(source, "since")) {
    if (!Number.isSafeInteger(source.since) || Number(source.since) < 0) {
      return null
    }
    filter.since = source.since as number
  }
  if (hasOwn(source, "until")) {
    if (!Number.isSafeInteger(source.until) || Number(source.until) < 0) {
      return null
    }
    filter.until = source.until as number
  }
  if (hasOwn(source, "limit")) {
    if (!Number.isSafeInteger(source.limit) || Number(source.limit) < 0) {
      return null
    }
    filter.limit = source.limit as number
  }

  for (const [key, value] of Object.entries(source)) {
    if (NIP01_FILTER_KEYS.has(key)) continue
    if (!key.startsWith("#")) return null
    if (!FILTER_TAG_KEY_PATTERN.test(key) || !isNonEmptyStringArray(value)) {
      return null
    }
    if (["#e", "#p"].includes(key) && !isIdentifierArray(value)) return null
    filter[key as `#${string}`] = value
  }

  return filter
}

export function normalizeRelayEvent(raw: unknown): NostrEvent | null {
  if (!validateEvent(raw)) return null
  const source = raw as NostrEvent
  if (
    typeof source.id !== "string" ||
    typeof source.sig !== "string" ||
    !Number.isSafeInteger(source.kind) ||
    source.kind < 0 ||
    source.kind > 65_535 ||
    source.tags.some((tag) => tag.length === 0)
  ) {
    return null
  }

  const event = {
    id: source.id,
    pubkey: source.pubkey,
    created_at: source.created_at,
    kind: source.kind,
    tags: source.tags,
    content: source.content,
    sig: source.sig,
  }

  try {
    return verifyEvent(event) ? event : null
  } catch {
    return null
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
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (typeof filter.since === "number" && event.created_at < filter.since) {
    return false
  }
  if (typeof filter.until === "number" && event.created_at > filter.until) {
    return false
  }

  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !value || value.length === 0) continue
    const tagName = key.slice(1)
    if (
      !event.tags.some(
        (tag) => tag[0] === tagName && value.includes(tag[1] ?? "")
      )
    ) {
      return false
    }
  }

  return true
}

function classifyProtectedRead(filters: NostrFilter[]): ProtectedReadPlan {
  const protectedFilters = filters.filter(
    (filter) =>
      filter.kinds === undefined || filter.kinds.includes(GIFT_WRAP_KIND)
  )
  if (protectedFilters.length === 0) return { status: "public" }
  if (protectedFilters.length !== filters.length) return { status: "invalid" }

  let recipient: string | undefined
  for (const filter of protectedFilters) {
    const recipients = filter["#p"]
    if (
      filter.kinds?.length !== 1 ||
      filter.kinds[0] !== GIFT_WRAP_KIND ||
      recipients?.length !== 1 ||
      !HEX_IDENTIFIER_PATTERN.test(recipients[0])
    ) {
      return { status: "invalid" }
    }
    if (recipient && recipient !== recipients[0]) {
      return { status: "invalid" }
    }
    recipient = recipients[0]
  }

  return recipient ? { status: "protected", recipient } : { status: "invalid" }
}

function replacementKey(event: NostrEvent): string | null {
  if (isReplaceableKind(event.kind)) {
    return `${event.kind}:${event.pubkey}`
  }
  if (isAddressableKind(event.kind)) {
    const dTag = event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""
    return `${event.kind}:${event.pubkey}:${dTag}`
  }
  return null
}

function isNewerReplacement(
  candidate: NostrEvent,
  current: NostrEvent
): boolean {
  return (
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
  )
}

export class RelayEventStore {
  private readonly eventsById = new Map<string, NostrEvent>()
  private readonly replacementIds = new Map<string, string>()
  private readonly visibleAtById = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.eventsById.size
  }

  store(event: NostrEvent, visibilityDelayMs = 0): StoreEventResult {
    if (!verifyEvent(event)) return { accepted: false, status: "invalid" }
    if (this.eventsById.has(event.id)) {
      return { accepted: true, status: "duplicate" }
    }
    if (isEphemeralKind(event.kind)) {
      return { accepted: true, status: "ephemeral" }
    }

    const key = replacementKey(event)
    if (key) {
      const currentId = this.replacementIds.get(key)
      const current = currentId ? this.eventsById.get(currentId) : undefined
      if (current && !isNewerReplacement(event, current)) {
        return { accepted: false, status: "superseded" }
      }
      if (current) {
        this.eventsById.delete(current.id)
        this.visibleAtById.delete(current.id)
      }
      this.replacementIds.set(key, event.id)
    }

    this.eventsById.set(event.id, event)
    this.visibleAtById.set(event.id, this.now() + visibilityDelayMs)
    return { accepted: true, status: "stored" }
  }

  query(filters: NostrFilter[], partialReadLimit?: number): NostrEvent[] {
    const visibleEvents = Array.from(this.eventsById.values()).filter(
      (event) => (this.visibleAtById.get(event.id) ?? 0) <= this.now()
    )
    const deduped = new Map<string, NostrEvent>()

    for (const filter of filters) {
      const matches = visibleEvents
        .filter((event) => eventMatchesFilter(event, filter))
        .sort(
          (left, right) =>
            right.created_at - left.created_at ||
            left.id.localeCompare(right.id)
        )
      const limited =
        typeof filter.limit === "number"
          ? matches.slice(0, filter.limit)
          : matches
      for (const event of limited) deduped.set(event.id, event)
    }

    const results = Array.from(deduped.values()).sort(
      (left, right) =>
        right.created_at - left.created_at || left.id.localeCompare(right.id)
    )
    return typeof partialReadLimit === "number"
      ? results.slice(0, partialReadLimit)
      : results
  }
}

function parseMessage(raw: string): RelayMessage | null {
  try {
    const parsed = JSON.parse(raw)
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      typeof parsed[0] !== "string"
    ) {
      return null
    }
    return { type: parsed[0], payload: parsed.slice(1) }
  } catch {
    return null
  }
}

function parseFaultMode(raw: string | undefined): RelayFaultMode {
  const value = raw?.trim() || "none"
  if (
    value === "none" ||
    value === "reject-writes" ||
    value === "drop-acks" ||
    value === "delay-reads" ||
    value === "partial-reads"
  ) {
    return value
  }
  throw new Error(`Unsupported RELAY_FAULT_MODE: ${value}`)
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function relayServerOptionsFromEnv(
  env: Record<string, string | undefined> = process.env
): RelayServerOptions {
  return {
    hostname: env.RELAY_HOST ?? "127.0.0.1",
    port: positiveInteger(env.RELAY_PORT, 7777),
    persistence: env.RELAY_EPHEMERAL !== "true",
    dataDir: env.RELAY_DATA_DIR ?? "context/relay-bun",
    faultMode: parseFaultMode(env.RELAY_FAULT_MODE),
    readDelayMs: positiveInteger(env.RELAY_READ_DELAY_MS, 250),
    partialReadLimit: positiveInteger(env.RELAY_PARTIAL_READ_LIMIT, 1),
  }
}

export function startRelayServer(options: RelayServerOptions = {}) {
  const hostname = options.hostname ?? "127.0.0.1"
  const port = options.port ?? 7777
  const persistence = options.persistence ?? true
  const dataDir = options.dataDir ?? "context/relay-bun"
  const eventsFile = path.join(dataDir, "events.jsonl")
  const faultMode = options.faultMode ?? "none"
  const readDelayMs = options.readDelayMs ?? 250
  const partialReadLimit = options.partialReadLimit ?? 1
  const now = options.now ?? Date.now
  const store = new RelayEventStore(now)
  const clients = new Set<ServerWebSocket<RelaySocketData>>()
  const counters = {
    eventAccepted: 0,
    eventRejected: 0,
    requests: 0,
    protectedRequests: 0,
    authChallenges: 0,
    authAccepted: 0,
    authRejected: 0,
    requestKindCounts: {} as Record<string, number>,
  }

  const persistEvent = (event: NostrEvent): void => {
    if (!persistence) return
    appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, "utf8")
  }

  if (persistence) {
    mkdirSync(dataDir, { recursive: true })
    if (existsSync(eventsFile)) {
      const lines = readFileSync(eventsFile, "utf8").split("\n")
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = normalizeRelayEvent(JSON.parse(line))
          if (event) store.store(event)
        } catch {
          // A malformed persisted line is ignored without exposing its payload.
        }
      }
    }
  }

  const send = (
    ws: ServerWebSocket<RelaySocketData>,
    frame: unknown[]
  ): void => {
    ws.send(JSON.stringify(frame))
  }

  const broadcast = (event: NostrEvent): void => {
    for (const ws of clients) {
      for (const [subscriptionId, filters] of ws.data.subscriptions) {
        if (filters.some((filter) => eventMatchesFilter(event, filter))) {
          send(ws, ["EVENT", subscriptionId, event])
        }
      }
    }
  }

  const handleEvent = (
    ws: ServerWebSocket<RelaySocketData>,
    payload: unknown[]
  ): void => {
    const candidateId =
      payload[0] && typeof payload[0] === "object"
        ? ((payload[0] as Record<string, unknown>).id ?? "")
        : ""
    const event = normalizeRelayEvent(payload[0])
    if (!event) {
      counters.eventRejected += 1
      send(ws, [
        "OK",
        typeof candidateId === "string" ? candidateId : "",
        false,
        "invalid: event id or signature verification failed",
      ])
      return
    }
    if (faultMode === "reject-writes") {
      counters.eventRejected += 1
      send(ws, ["OK", event.id, false, "blocked: injected write rejection"])
      return
    }

    const visibilityDelayMs = faultMode === "delay-reads" ? readDelayMs : 0
    const result = store.store(event, visibilityDelayMs)
    if (!result.accepted) {
      counters.eventRejected += 1
      send(ws, [
        "OK",
        event.id,
        false,
        result.status === "superseded"
          ? "duplicate: newer replaceable event already stored"
          : "invalid: event id or signature verification failed",
      ])
      return
    }

    counters.eventAccepted += 1
    if (result.status === "stored") persistEvent(event)
    if (event.kind !== NIP42_AUTH_KIND) {
      const broadcastDelayMs = faultMode === "delay-reads" ? readDelayMs : 0
      if (broadcastDelayMs > 0) {
        setTimeout(() => broadcast(event), broadcastDelayMs)
      } else {
        broadcast(event)
      }
    }
    if (faultMode !== "drop-acks") {
      send(ws, [
        "OK",
        event.id,
        true,
        result.status === "duplicate" ? "duplicate: accepted" : "saved",
      ])
    }
  }

  const handleReq = (
    ws: ServerWebSocket<RelaySocketData>,
    payload: unknown[]
  ): void => {
    const subscriptionId = payload[0]
    if (typeof subscriptionId !== "string") {
      send(ws, ["NOTICE", "REQ missing subscription id"])
      return
    }
    const rawFilters = payload.slice(1)
    const parsedFilters = rawFilters.map(normalizeFilter)
    if (
      rawFilters.length === 0 ||
      parsedFilters.some((filter) => filter === null)
    ) {
      send(ws, ["CLOSED", subscriptionId, "invalid: malformed filter"])
      return
    }
    const filters = parsedFilters as NostrFilter[]
    for (const kind of new Set(
      filters.flatMap((filter) => filter.kinds ?? [])
    )) {
      const key = String(kind)
      if (
        key in counters.requestKindCounts ||
        Object.keys(counters.requestKindCounts).length < 32
      ) {
        counters.requestKindCounts[key] =
          (counters.requestKindCounts[key] ?? 0) + 1
      }
    }

    const protectedRead = classifyProtectedRead(filters)
    if (protectedRead.status === "invalid") {
      send(ws, [
        "CLOSED",
        subscriptionId,
        "restricted: protected reads require one authenticated recipient",
      ])
      return
    }
    if (protectedRead.status === "protected" && !ws.data.authenticatedPubkey) {
      counters.protectedRequests += 1
      counters.authChallenges += 1
      send(ws, ["AUTH", ws.data.challenge])
      send(ws, [
        "CLOSED",
        subscriptionId,
        "auth-required: authenticate for protected reads",
      ])
      return
    }
    if (
      protectedRead.status === "protected" &&
      protectedRead.recipient !== ws.data.authenticatedPubkey
    ) {
      send(ws, [
        "CLOSED",
        subscriptionId,
        "restricted: authenticated account does not match recipient",
      ])
      return
    }

    counters.requests += 1
    ws.data.subscriptions.set(subscriptionId, filters)
    const matches = store.query(
      filters,
      faultMode === "partial-reads" ? partialReadLimit : undefined
    )
    for (const event of matches) send(ws, ["EVENT", subscriptionId, event])
    send(ws, ["EOSE", subscriptionId])
  }

  const handleAuth = (
    ws: ServerWebSocket<RelaySocketData>,
    payload: unknown[]
  ): void => {
    const event = normalizeRelayEvent(payload[0])
    const relayUrl = `ws://${hostname}:${server.port}`
    const hasChallenge = event?.tags.some(
      (tag) => tag[0] === "challenge" && tag[1] === ws.data.challenge
    )
    const hasRelay = event?.tags.some(
      (tag) => tag[0] === "relay" && tag[1] === relayUrl
    )
    const isFresh =
      event !== null &&
      Math.abs(Math.floor(now() / 1_000) - event.created_at) <=
        NIP42_AUTH_FRESHNESS_SECONDS
    const valid =
      event?.kind === NIP42_AUTH_KIND &&
      event.content === "" &&
      isFresh &&
      hasChallenge === true &&
      hasRelay === true
    if (!event || !valid) {
      counters.authRejected += 1
      send(ws, [
        "OK",
        event?.id ?? "",
        false,
        "invalid: NIP-42 authentication failed",
      ])
      return
    }
    ws.data.authenticatedPubkey = event.pubkey
    counters.authAccepted += 1
    send(ws, ["OK", event.id, true, "authenticated"])
  }

  const server = Bun.serve<RelaySocketData>({
    hostname,
    port,
    fetch(request, serverInstance) {
      const url = new URL(request.url)
      const corsHeaders = {
        "Access-Control-Allow-Headers": "Accept, Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders })
      }
      if (url.pathname === "/health") {
        return Response.json(
          {
            status: "ok",
            storedEventCount: store.size,
            faultMode,
            counters,
          },
          { headers: corsHeaders }
        )
      }
      if (
        serverInstance.upgrade(request, {
          data: {
            subscriptions: new Map(),
            challenge: crypto.randomUUID(),
            authenticatedPubkey: null,
          },
        })
      ) {
        return
      }
      if (request.headers.get("accept")?.includes("application/nostr+json")) {
        return Response.json(
          {
            name: "Conduit local test relay",
            description: "Ephemeral relay for deterministic local testing",
            supported_nips: [1, 11, 42],
            software: "https://github.com/Conduit-BTC/conduit-mono",
            limitation: {
              auth_required: false,
              payment_required: false,
            },
          },
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/nostr+json",
            },
          }
        )
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
          case "CLOSE": {
            const subscriptionId = parsed.payload[0]
            if (typeof subscriptionId === "string") {
              ws.data.subscriptions.delete(subscriptionId)
            }
            return
          }
          case "AUTH":
            handleAuth(ws, parsed.payload)
            return
          default:
            send(ws, ["NOTICE", `Unsupported message type: ${parsed.type}`])
        }
      },
    },
  })

  return { server, store, faultMode, persistence, counters }
}

if (import.meta.main) {
  const relay = startRelayServer(relayServerOptionsFromEnv())
  const address = `ws://${relay.server.hostname}:${relay.server.port}`
  console.log(`Conduit Bun relay listening on ${address}`)
  console.log(`Storage: ${relay.persistence ? "persistent" : "ephemeral"}`)
  console.log(`Fault mode: ${relay.faultMode}`)

  const shutdown = (): void => {
    relay.server.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
