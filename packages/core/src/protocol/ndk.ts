import NDK, {
  NDKRelayStatus,
  type NDKEvent,
  type NDKFilter,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { config } from "../config"
import {
  getGeneralReadRelayUrls,
  setActiveRelaySettingsScope,
} from "./relay-settings"
import {
  partitionByHealth,
  recordRelayFailure,
  recordRelaySuccess,
} from "./relay-health"
import {
  runWithRelayNetworkBudget,
  type RelayNetworkBudgetClass,
} from "./relay-network-budget"
import {
  recordRelayCapabilityReadFailure,
  recordRelayCapabilityReadSuccess,
} from "./relay-capability-cache"
import {
  createRelayFrontierReadOutcome,
  type NostrPlainEvent,
  type RelayFrontierExecutor,
  type RelayFrontierReadFilter,
  type RelayFrontierReadOutcome,
  type RelayFrontierSourceBucket,
} from "./relay-frontier"

export type NdkConnectionState = "idle" | "connecting" | "connected" | "error"

export interface NdkState {
  status: NdkConnectionState
  connectedRelays: string[]
  error: string | null
}

export interface FetchEventsFanoutOptions {
  relayUrls?: string[]
  sourceBucket?: RelayFrontierSourceBucket
  sourceBucketsByRelayUrl?: Record<string, RelayFrontierSourceBucket>
  connectTimeoutMs?: number
  fetchTimeoutMs?: number
  skipHealthFilter?: boolean
  budgetClass?: RelayNetworkBudgetClass
  signal?: AbortSignal
}

export interface FetchEventsFanoutProgress {
  relayUrl: string
  events: NDKEvent[]
  mergedEvents: NDKEvent[]
  outcome: RelayFrontierReadOutcome
}

export interface FetchEventsFanoutResult {
  events: NDKEvent[]
  outcomes: RelayFrontierReadOutcome[]
}

const EVENT_SOURCE_RELAY_URLS = "__conduitSourceRelayUrls"

type EventWithSourceRelayUrls = NDKEvent & {
  [EVENT_SOURCE_RELAY_URLS]?: string[]
}

type Listener = () => void

let ndkInstance: NDK | null = null
let state: NdkState = {
  status: "idle",
  connectedRelays: [],
  error: null,
}
let connectPromise: Promise<void> | null = null
let requirePromise: Promise<NDK> | null = null
let ndkGeneration = 0
const listeners = new Set<Listener>()

function setState(partial: Partial<NdkState>): void {
  state = { ...state, ...partial }
  listeners.forEach((fn) => fn())
}

function getConnectedRelayUrls(ndk: NDK): string[] {
  return Array.from(ndk.pool?.relays?.entries() ?? [])
    .filter(([, relay]) => relay.status >= NDKRelayStatus.CONNECTED)
    .map(([url]) => url)
}

function uniqueRelayUrls(urls: readonly string[]): string[] {
  return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)))
}

function attachEventSourceRelayUrl(event: NDKEvent, relayUrl: string): void {
  const eventWithSources = event as EventWithSourceRelayUrls
  const next = uniqueRelayUrls([
    ...(eventWithSources[EVENT_SOURCE_RELAY_URLS] ?? []),
    relayUrl,
  ])

  Object.defineProperty(eventWithSources, EVENT_SOURCE_RELAY_URLS, {
    value: next,
    enumerable: false,
    configurable: true,
  })
}

export function getEventSourceRelayUrls(event: NDKEvent): string[] {
  return [
    ...((event as EventWithSourceRelayUrls)[EVENT_SOURCE_RELAY_URLS] ?? []),
  ]
}

export function subscribeNdkState(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getNdkState(): NdkState {
  return state
}

export function getNdk(): NDK {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: getGeneralReadRelayUrls({
        fallbackRelayUrls: config.defaultRelays,
      }),
    })
  }
  return ndkInstance
}

function sleep<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

const FETCH_TIMEOUT = Symbol("fetch-timeout")

async function fetchEventsFromRelay(
  relayUrl: string,
  filter: NDKFilter,
  connectTimeoutMs: number,
  fetchTimeoutMs: number,
  budgetClass: RelayNetworkBudgetClass = "visible_marketplace_read",
  sourceBucket: RelayFrontierSourceBucket = "unknown"
): Promise<{ events: NDKEvent[]; outcome: RelayFrontierReadOutcome }> {
  const startedAt = Date.now()
  const ndk = new NDK({
    explicitRelayUrls: [relayUrl],
  })

  try {
    const connected = await Promise.race([
      ndk
        .connect(connectTimeoutMs)
        .then(() => true)
        .catch(() => false),
      sleep(connectTimeoutMs + 250, false),
    ])

    if (!connected) {
      recordRelayFailure(relayUrl)
      void recordRelayCapabilityReadFailure(relayUrl, {
        timedOut: true,
        eventKind: Array.isArray(filter.kinds) ? filter.kinds[0] : undefined,
      }).catch(() => undefined)
      return {
        events: [],
        outcome: createRelayFrontierReadOutcome({
          adapter: "ndk",
          relayUrl,
          sourceBucket,
          priorityClass: budgetClass,
          startedAt,
          eventsReceived: 0,
          timedOut: true,
        }),
      }
    }

    const events = await Promise.race([
      ndk.fetchEvents(filter),
      sleep(fetchTimeoutMs, FETCH_TIMEOUT),
    ])

    if (events === FETCH_TIMEOUT) {
      recordRelayFailure(relayUrl)
      void recordRelayCapabilityReadFailure(relayUrl, {
        timedOut: true,
        eventKind: Array.isArray(filter.kinds) ? filter.kinds[0] : undefined,
      }).catch(() => undefined)
      return {
        events: [],
        outcome: createRelayFrontierReadOutcome({
          adapter: "ndk",
          relayUrl,
          sourceBucket,
          priorityClass: budgetClass,
          startedAt,
          eventsReceived: 0,
          timedOut: true,
        }),
      }
    }

    recordRelaySuccess(relayUrl)
    const fetched = Array.from(events) as NDKEvent[]
    void recordRelayCapabilityReadSuccess(
      relayUrl,
      fetched
        .map((event) => event.kind)
        .filter((kind): kind is number => typeof kind === "number")
    ).catch(() => undefined)
    for (const event of fetched) {
      attachEventSourceRelayUrl(event, relayUrl)
    }
    return {
      events: fetched,
      outcome: createRelayFrontierReadOutcome({
        adapter: "ndk",
        relayUrl,
        sourceBucket,
        priorityClass: budgetClass,
        startedAt,
        eventsReceived: fetched.length,
        eventsReturned: fetched.length,
      }),
    }
  } catch (error) {
    recordRelayFailure(relayUrl)
    void recordRelayCapabilityReadFailure(relayUrl, {
      eventKind: Array.isArray(filter.kinds) ? filter.kinds[0] : undefined,
    }).catch(() => undefined)
    return {
      events: [],
      outcome: createRelayFrontierReadOutcome({
        adapter: "ndk",
        relayUrl,
        sourceBucket,
        priorityClass: budgetClass,
        startedAt,
        eventsReceived: 0,
        errorMessage: error instanceof Error ? error.message : "relay error",
      }),
    }
  } finally {
    for (const [, relay] of ndk.pool?.relays?.entries() ?? []) {
      relay.disconnect()
    }
  }
}

function resolveFanoutRelayUrls(options: FetchEventsFanoutOptions): string[] {
  const dedupedUrls = (
    options.relayUrls && options.relayUrls.length > 0
      ? options.relayUrls
      : getGeneralReadRelayUrls({ fallbackRelayUrls: config.defaultRelays })
  )
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url, index, all) => all.indexOf(url) === index)

  return options.skipHealthFilter
    ? dedupedUrls
    : (() => {
        const { healthy, parked } = partitionByHealth(dedupedUrls)
        // If health filter would leave no relays, fall back to the full set
        // so a transient cooldown does not silently break reads.
        return healthy.length > 0
          ? healthy
          : parked.length > 0
            ? dedupedUrls
            : []
      })()
}

function mergeEventsInto(
  merged: Map<string, NDKEvent>,
  events: NDKEvent[]
): void {
  for (const event of events) {
    const fallbackId = `${event.pubkey}:${event.kind}:${event.created_at ?? 0}`
    const key = event.id || fallbackId
    const existing = merged.get(key)
    if (existing) {
      for (const relayUrl of getEventSourceRelayUrls(event)) {
        attachEventSourceRelayUrl(existing, relayUrl)
      }
      continue
    }
    merged.set(key, event)
  }
}

export async function fetchEventsFanout(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {}
): Promise<NDKEvent[]> {
  return (await fetchEventsFanoutWithOutcomes(filter, options)).events
}

export async function fetchEventsFanoutWithOutcomes(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {}
): Promise<FetchEventsFanoutResult> {
  const relayUrls = resolveFanoutRelayUrls(options)

  if (relayUrls.length === 0) return { events: [], outcomes: [] }

  const connectTimeoutMs = options.connectTimeoutMs ?? 4_000
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 8_000
  const getSourceBucket = (relayUrl: string): RelayFrontierSourceBucket =>
    options.sourceBucketsByRelayUrl?.[relayUrl] ??
    options.sourceBucket ??
    "unknown"

  const perRelayResults = await Promise.all(
    relayUrls.map((relayUrl) =>
      runWithRelayNetworkBudget(
        () =>
          fetchEventsFromRelay(
            relayUrl,
            filter,
            connectTimeoutMs,
            fetchTimeoutMs,
            options.budgetClass,
            getSourceBucket(relayUrl)
          ),
        {
          budgetClass: options.budgetClass,
          relayUrl,
          signal: options.signal,
        }
      )
    )
  )

  const merged = new Map<string, NDKEvent>()
  for (const { events } of perRelayResults) {
    mergeEventsInto(merged, events)
  }

  return {
    events: Array.from(merged.values()),
    outcomes: perRelayResults.map((result) => result.outcome),
  }
}

export async function fetchEventsFanoutProgressive(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {},
  onProgress: (progress: FetchEventsFanoutProgress) => void | Promise<void>
): Promise<NDKEvent[]> {
  const relayUrls = resolveFanoutRelayUrls(options)
  if (relayUrls.length === 0) return []

  const connectTimeoutMs = options.connectTimeoutMs ?? 4_000
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 8_000
  const merged = new Map<string, NDKEvent>()
  const getSourceBucket = (relayUrl: string): RelayFrontierSourceBucket =>
    options.sourceBucketsByRelayUrl?.[relayUrl] ??
    options.sourceBucket ??
    "unknown"

  await Promise.all(
    relayUrls.map(async (relayUrl) => {
      const events = await runWithRelayNetworkBudget(
        () =>
          fetchEventsFromRelay(
            relayUrl,
            filter,
            connectTimeoutMs,
            fetchTimeoutMs,
            options.budgetClass,
            getSourceBucket(relayUrl)
          ),
        {
          budgetClass: options.budgetClass,
          relayUrl,
          signal: options.signal,
        }
      )
      mergeEventsInto(merged, events.events)
      await onProgress({
        relayUrl,
        events: events.events,
        mergedEvents: Array.from(merged.values()),
        outcome: events.outcome,
      })
    })
  )

  return Array.from(merged.values())
}

export function toNostrPlainEvent(event: NDKEvent): NostrPlainEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at ?? 0,
    kind: event.kind ?? 0,
    tags: event.tags ?? [],
    content: event.content ?? "",
    sig: event.sig,
  }
}

function toNdkFilter(filter: RelayFrontierReadFilter): NDKFilter {
  return filter as NDKFilter
}

export const ndkRelayFrontierExecutor: RelayFrontierExecutor = {
  adapter: "ndk",
  async read(input) {
    const eventsById = new Map<string, NostrPlainEvent>()
    const outcomes: RelayFrontierReadOutcome[] = []

    for (const filter of input.filters) {
      const result = await fetchEventsFanoutWithOutcomes(toNdkFilter(filter), {
        relayUrls: input.relayUrls,
        sourceBucket: input.sourceBucket,
        sourceBucketsByRelayUrl: input.sourceBucketsByRelayUrl,
        connectTimeoutMs: input.deadlineMs,
        fetchTimeoutMs: input.deadlineMs,
        budgetClass: input.priorityClass,
        signal: input.signal,
      })
      for (const event of result.events) {
        const plain = toNostrPlainEvent(event)
        eventsById.set(plain.id, plain)
      }
      outcomes.push(...result.outcomes)
    }

    return {
      events: Array.from(eventsById.values()),
      outcomes,
    }
  },
}

export async function connectNdk(timeoutMs = 10_000): Promise<void> {
  const ndk = getNdk()
  const generation = ndkGeneration

  // If already connected with live relays, skip
  if (state.status === "connected" && getConnectedRelayUrls(ndk).length > 0) {
    return
  }

  if (connectPromise) {
    await connectPromise
    return
  }

  if (generation === ndkGeneration) {
    setState({ status: "connecting", error: null })
  }

  connectPromise = (async () => {
    try {
      await ndk.connect(timeoutMs)
      if (generation !== ndkGeneration) return

      const connected = getConnectedRelayUrls(ndk)

      if (connected.length > 0) {
        setState({
          status: "connected",
          connectedRelays: connected,
          error: null,
        })
      } else {
        setState({
          status: "error",
          error: "No relays responded within timeout",
          connectedRelays: [],
        })
      }
    } catch (err) {
      if (generation !== ndkGeneration) return
      setState({
        status: "error",
        error:
          err instanceof Error ? err.message : "Failed to connect to relays",
        connectedRelays: [],
      })
    } finally {
      if (generation === ndkGeneration) {
        connectPromise = null
      }
    }
  })()

  await connectPromise
}

export async function requireNdkConnected(timeoutMs = 10_000): Promise<NDK> {
  // Deduplicate concurrent callers — only one retry path runs at a time
  if (requirePromise) {
    return requirePromise
  }

  const generation = ndkGeneration
  const promise = (async () => {
    try {
      await connectNdk(timeoutMs)
      if (generation !== ndkGeneration) {
        return requireNdkConnected(timeoutMs)
      }

      let ndk = getNdk()
      if (getConnectedRelayUrls(ndk).length > 0) {
        setState({
          status: "connected",
          connectedRelays: getConnectedRelayUrls(ndk),
          error: null,
        })
        return ndk
      }

      // First attempt failed — reset the NDK instance for fresh websocket connections and retry
      const savedSigner = ndk.signer
      ndkInstance = null
      connectPromise = null
      ndk = getNdk()
      if (savedSigner) ndk.signer = savedSigner

      await connectNdk(timeoutMs * 2)
      if (generation !== ndkGeneration) {
        return requireNdkConnected(timeoutMs)
      }

      const retryRelays = getConnectedRelayUrls(ndk)
      if (retryRelays.length === 0) {
        throw new Error(state.error ?? "Failed to connect to relays")
      }

      setState({
        status: "connected",
        connectedRelays: retryRelays,
        error: null,
      })
      return ndk
    } finally {
      if (generation === ndkGeneration) {
        requirePromise = null
      }
    }
  })()

  requirePromise = promise
  return requirePromise
}

export function setSigner(signer: NDKSigner): void {
  const ndk = getNdk()
  ndk.signer = signer
}

export function removeSigner(): void {
  const ndk = getNdk()
  ndk.signer = undefined
}

export function disconnectNdk(): void {
  ndkGeneration += 1
  if (ndkInstance) {
    ndkInstance.signer = undefined
    ndkInstance = null
  }
  connectPromise = null
  requirePromise = null
  setState({
    status: "idle",
    connectedRelays: [],
    error: null,
  })
}

export function refreshNdkRelaySettings(scope?: string | null): void {
  ndkGeneration += 1
  if (scope !== undefined) {
    setActiveRelaySettingsScope(scope)
  }

  const savedSigner = ndkInstance?.signer

  if (ndkInstance) {
    for (const [, relay] of ndkInstance.pool?.relays?.entries() ?? []) {
      relay.disconnect()
    }
  }

  ndkInstance = null
  connectPromise = null
  requirePromise = null

  const ndk = getNdk()
  if (savedSigner) ndk.signer = savedSigner

  setState({
    status: "idle",
    connectedRelays: [],
    error: null,
  })
}
