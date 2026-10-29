import { expect, test, type Page } from "@playwright/test"
import { sameSignedPublicEvent } from "@conduit/core/protocol/verified-public-event"
import { nip19, nip44 } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"
import { createWrap } from "nostr-tools/nip59"

import { buildEventMarketCalendarDraft } from "@conduit/core/protocol/event-market"
import { buildEventMarketOrderRumorTags } from "@conduit/core/protocol/orders"
import { resolveFutureMarketReceiptMerchandiseEvidence } from "@conduit/core/protocol/future-market-merchandise"
import {
  orderSchema,
  type FutureMarketReadyReceiptSchema,
} from "@conduit/core/schemas"
import {
  buildEventMarketAssignmentDraft,
  parseEventMarketAssignmentEvent,
} from "@conduit/core/protocol/event-market-assignment"
import { createEventMarketStockAuthorityRumor } from "@conduit/core/protocol/event-market-stock-authority"
import type { InboxProjection } from "../packages/core/src/protocol/commerce-inbox-store"
import { interceptBlossom } from "./helpers/blossom"
import {
  observePrepaidConfirmationTrigger,
  recordSmokeDiagnostic,
} from "./helpers/smoke-diagnostics"
import { admitFixtureEvent } from "../tests/helpers/admit-event"
import { getFutureMarketClaimRef } from "@conduit/core/protocol/future-market-handoff"
import { formatEventGuestReceipt } from "@conduit/core/protocol/event-guest-checkout"
import {
  classifyStockAcceptanceError,
  observeStockAcceptance,
} from "./helpers/stock-acceptance-diagnostics"
import { recordEventStockControlFailure } from "./helpers/smoke-diagnostics"

// Protocol-bearing fixtures and private receipt files must not enter browser artifacts.
test.use({ trace: "off", video: "off", screenshot: "off" })

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const merchantUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
}`

const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER_PUBKEY = getPublicKey(ORGANIZER_SECRET)
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const BUYER_SECRET = generateSecretKey()
const BUYER_PUBKEY = getPublicKey(BUYER_SECRET)
const MERCHANT_TEMPLATE_D_TAG = "synthetic-existing-product"
const MERCHANT_TEMPLATE_TITLE = "Existing merchant mug"
const FIXTURE_RELAY_PORT = process.env.PLAYWRIGHT_RELAY_PORT ?? "7777"
const FIXTURE_RELAY = `ws://127.0.0.1:${FIXTURE_RELAY_PORT}`
const SYNTHETIC_IDENTITY_SEARCH_KEY = "__conduit_e2e_identity"
const SYNTHETIC_IDENTITY_STORAGE_KEY = "conduit:e2e:identity"
const SYNTHETIC_SIGNER_UNAVAILABLE_KEY = "conduit:e2e:signer-unavailable"
const browserSourceRoot = (relative: string) =>
  `/@fs/${process.cwd().replace(/\\/g, "/").replace(/^\/+/, "")}/${relative}`

const syntheticIdentities = {
  organizer: {
    pubkey: ORGANIZER_PUBKEY,
    secret: ORGANIZER_SECRET,
  },
  merchant: {
    pubkey: MERCHANT_PUBKEY,
    secret: MERCHANT_SECRET,
  },
  buyer: {
    pubkey: BUYER_PUBKEY,
    secret: BUYER_SECRET,
  },
} as const

type SyntheticIdentity = keyof typeof syntheticIdentities

function savedCreationFixture(summary = "x".repeat(1_001)) {
  const dTag = "saved-creation-recovery"
  return {
    version: 1,
    organizerPubkey: ORGANIZER_PUBKEY,
    dTag,
    marketCoordinate: `30409:${ORGANIZER_PUBKEY}:${dTag}`,
    calendarCoordinate: `31923:${ORGANIZER_PUBKEY}:${dTag}-calendar`,
    form: {
      calendarType: "timed" as const,
      imageUrl: "",
      eventGeohash: "",
      title: "Saved community fair",
      summary,
      eventLocation: "Public hall",
      start: "2030-06-01T10:00",
      end: "2030-06-01T16:00",
      timezone: "UTC",
    },
  }
}

async function storeSavedCreation(
  page: Page,
  creation: ReturnType<typeof savedCreationFixture>
) {
  await page.evaluate((saved) => {
    localStorage.setItem(
      `conduit:future-event-market-creation:v1:${saved.organizerPubkey}`,
      JSON.stringify(saved)
    )
  }, creation)
  await page.reload()
}

type UnsignedEvent = {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

type SignedEvent = UnsignedEvent & {
  id: string
  pubkey: string
  sig: string
}

type PrivateRumor = {
  id: string
  kind: number
  pubkey: string
  created_at: number
  tags: string[][]
  content: string
}

type DecryptedPrivatePublication = {
  publicationIndex: number
  wrap: SignedEvent
  seal: SignedEvent
  rumor: PrivateRumor
}

type RelayFilter = {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  search?: string
  [key: `#${string}`]: string[] | number[] | number | undefined
}

type PublishedEvent = {
  relayUrl: string
  event: SignedEvent
}

type HeldPublicationAck = {
  captured: Promise<SignedEvent>
  release: () => void
}

type HeldRelayRequest = {
  captured: Promise<RelayRequest>
  release: () => void
}

type HeldRelayEventResponse = {
  captured: Promise<{
    request: RelayRequest
    heldEventIds: string[]
  }>
  release: () => void
}

type RelayRequest = {
  clientId?: string
  relayUrl: string
  subscriptionId: string
  filters: RelayFilter[]
  matchedEventIds: string[]
}

function signEvent(secret: Uint8Array, input: UnsignedEvent): SignedEvent {
  return finalizeEvent(input, secret)
}

function signedHistoricalAcceptedStatus(
  orderId: string,
  status = "accepted",
  createdAt = Math.floor(Date.now() / 1_000)
): SignedEvent[] {
  const rumorDraft = {
    kind: 16,
    pubkey: MERCHANT_PUBKEY,
    created_at: createdAt,
    tags: [
      ["p", BUYER_PUBKEY],
      ["type", "status_update"],
      ["order", orderId],
      ["status", status],
    ],
    content: JSON.stringify({
      status,
      orderId,
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      createdAt: createdAt * 1_000,
    }),
  }
  const rumor = { ...rumorDraft, id: getEventHash(rumorDraft) }
  return [BUYER_PUBKEY, MERCHANT_PUBKEY].map((recipientPubkey) => {
    const seal = signEvent(MERCHANT_SECRET, {
      kind: 13,
      created_at: createdAt,
      tags: [],
      content: nip44.v2.encrypt(
        JSON.stringify(rumor),
        nip44.v2.utils.getConversationKey(MERCHANT_SECRET, recipientPubkey)
      ),
    })
    return createWrap(seal, recipientPubkey) as SignedEvent
  })
}

function eventCoordinate(event: SignedEvent): string {
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1]
  if (!dTag) throw new Error(`Signed kind-${event.kind} fixture has no d tag.`)
  return `${event.kind}:${event.pubkey}:${dTag}`
}

function signedAssignment(
  market: SignedEvent,
  occurrence: SignedEvent,
  product: SignedEvent,
  quantity = 5,
  fulfillmentMethods: Array<"pickup" | "shipping" | "digital"> = ["pickup"]
): SignedEvent {
  const stock = product.tags.find((tag) => tag[0] === "stock")?.[1]
  return signEvent(MERCHANT_SECRET, {
    ...buildEventMarketAssignmentDraft({
      marketCoordinate: eventCoordinate(market),
      occurrenceCoordinate: eventCoordinate(occurrence),
      productCoordinate: eventCoordinate(product),
      merchantPubkey: MERCHANT_PUBKEY,
      state: "active",
      inventory:
        stock === undefined
          ? { mode: "untracked" }
          : { mode: "tracked", quantity: Math.min(quantity, Number(stock)) },
      fulfillmentMethods,
    }),
    created_at: product.created_at,
  })
}

function eventMatchesFilter(event: SignedEvent, filter: RelayFilter): boolean {
  if (filter.ids && !filter.ids.some((prefix) => event.id.startsWith(prefix))) {
    return false
  }
  if (
    filter.authors &&
    !filter.authors.some((prefix) => event.pubkey.startsWith(prefix))
  ) {
    return false
  }
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (
    filter.search &&
    ![
      event.content,
      ...event.tags.filter((tag) => tag[0] === "title").map((tag) => tag[1]),
    ]
      .join(" ")
      .toLowerCase()
      .includes(filter.search.toLowerCase())
  )
    return false
  if (typeof filter.since === "number" && event.created_at < filter.since) {
    return false
  }
  if (typeof filter.until === "number" && event.created_at > filter.until) {
    return false
  }

  for (const [key, rawValues] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(rawValues)) continue
    const values = rawValues.filter(
      (value): value is string => typeof value === "string"
    )
    const tagName = key.slice(1)
    if (
      values.length > 0 &&
      !event.tags.some(
        (tag) => tag[0] === tagName && values.includes(tag[1] ?? "")
      )
    ) {
      return false
    }
  }
  return true
}

function parseRelayFrame(message: string): unknown[] | null {
  try {
    const parsed = JSON.parse(message)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isRelayFilter(value: unknown): value is RelayFilter {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isSignedEvent(value: unknown): value is SignedEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const event = value as Partial<SignedEvent>
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.sig === "string" &&
    typeof event.kind === "number" &&
    typeof event.created_at === "number" &&
    typeof event.content === "string" &&
    Array.isArray(event.tags)
  )
}

function createRelayHarness() {
  const eventsById = new Map<string, SignedEvent>()
  const publications: PublishedEvent[] = []
  const requests: RelayRequest[] = []
  const incompleteRequests: RelayRequest[] = []
  let heldPublicationAck: {
    predicate: (event: SignedEvent) => boolean
    capture: (event: SignedEvent) => void
    released: Promise<void>
  } | null = null
  let heldRelayRequest: {
    predicate: (request: RelayRequest) => boolean
    capture: (request: RelayRequest) => void
    released: Promise<void>
    captured: boolean
  } | null = null
  let heldRelayEventResponse: {
    predicate: (request: RelayRequest, event: SignedEvent) => boolean
    capture: (value: { request: RelayRequest; heldEventIds: string[] }) => void
    released: Promise<void>
    captured: boolean
  } | null = null
  const incompleteReadKinds = new Set<number>()
  const rejectedKinds = new Set<number>()
  const rejectedReadKinds = new Set<number>()
  let rejectReads = false
  let rejectMarketDiscovery = false
  let omitMarketDiscovery = false
  let rejectExactMarkets = false

  return {
    publications,
    requests,
    incompleteRequests,
    incompleteReadsForKind(kind: number) {
      incompleteReadKinds.add(kind)
    },
    rejectReadKind(kind: number, reject: boolean) {
      if (reject) rejectedReadKinds.add(kind)
      else rejectedReadKinds.delete(kind)
    },
    rejectExactMarkets(reject: boolean) {
      rejectExactMarkets = reject
    },
    rejectMarketDiscovery(reject: boolean) {
      rejectMarketDiscovery = reject
    },
    omitMarketDiscovery(omit: boolean) {
      omitMarketDiscovery = omit
    },
    rejectReads(reject: boolean) {
      rejectReads = reject
    },
    holdNextPublicationAck(
      predicate: (event: SignedEvent) => boolean
    ): HeldPublicationAck {
      if (heldPublicationAck) {
        throw new Error("A synthetic relay publication ACK is already held.")
      }
      let capture!: (event: SignedEvent) => void
      let release!: () => void
      const captured = new Promise<SignedEvent>((resolve) => {
        capture = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      heldPublicationAck = { predicate, capture, released }
      return { captured, release }
    },
    holdRelayRequests(
      predicate: (request: RelayRequest) => boolean
    ): HeldRelayRequest {
      if (heldRelayRequest || heldRelayEventResponse) {
        throw new Error("Synthetic relay requests are already being held.")
      }
      let capture!: (request: RelayRequest) => void
      let resolveRelease!: () => void
      const captured = new Promise<RelayRequest>((resolve) => {
        capture = resolve
      })
      const released = new Promise<void>((resolve) => {
        resolveRelease = resolve
      })
      const release = () => {
        heldRelayRequest = null
        resolveRelease()
      }
      heldRelayRequest = { predicate, capture, released, captured: false }
      return { captured, release }
    },
    holdRelayEventResponses(
      predicate: (request: RelayRequest, event: SignedEvent) => boolean
    ): HeldRelayEventResponse {
      if (heldRelayRequest || heldRelayEventResponse) {
        throw new Error("Synthetic relay responses are already being held.")
      }
      let capture!: (value: {
        request: RelayRequest
        heldEventIds: string[]
      }) => void
      let resolveRelease!: () => void
      const captured = new Promise<{
        request: RelayRequest
        heldEventIds: string[]
      }>((resolve) => {
        capture = resolve
      })
      const released = new Promise<void>((resolve) => {
        resolveRelease = resolve
      })
      const release = () => {
        heldRelayEventResponse = null
        resolveRelease()
      }
      heldRelayEventResponse = {
        predicate,
        capture,
        released,
        captured: false,
      }
      return { captured, release }
    },
    rejectKind(kind: number, reject: boolean) {
      if (reject) rejectedKinds.add(kind)
      else rejectedKinds.delete(kind)
    },
    seed(...events: SignedEvent[]) {
      for (const event of events) {
        if (!verifyEvent(event)) {
          throw new Error(`Synthetic kind-${event.kind} seed is not signed.`)
        }
        eventsById.set(event.id, event)
      }
    },
    remove(...events: SignedEvent[]) {
      for (const event of events) eventsById.delete(event.id)
    },
    events(): SignedEvent[] {
      return Array.from(eventsById.values())
    },
    async install(page: Page, clientId?: string): Promise<void> {
      await page.routeWebSocket(FIXTURE_RELAY, (socket) => {
        socket.onMessage((message) => {
          if (typeof message !== "string") return
          const frame = parseRelayFrame(message)
          if (!frame || typeof frame[0] !== "string") return

          if (frame[0] === "REQ" && typeof frame[1] === "string") {
            const subscriptionId = frame[1]
            const filters = frame.slice(2).filter(isRelayFilter)
            const request: RelayRequest = {
              ...(clientId ? { clientId } : {}),
              relayUrl: socket.url(),
              subscriptionId,
              filters: structuredClone(filters),
              matchedEventIds: [],
            }
            requests.push(request)
            const respond = () => {
              if (
                rejectReads ||
                filters.some((filter) =>
                  filter.kinds?.some((kind) => rejectedReadKinds.has(kind))
                ) ||
                (rejectExactMarkets &&
                  filters.some(
                    (filter) => filter.kinds?.includes(30409) && filter["#d"]
                  )) ||
                (rejectMarketDiscovery &&
                  filters.some(
                    (filter) => filter.kinds?.includes(30409) && !filter["#d"]
                  ))
              ) {
                socket.send(
                  JSON.stringify([
                    "CLOSED",
                    subscriptionId,
                    "error: synthetic read unavailable",
                  ])
                )
                return
              }
              const limitedMatchesById = new Map<string, SignedEvent>()
              for (const filter of filters) {
                if (
                  omitMarketDiscovery &&
                  filter.kinds?.includes(30409) &&
                  !filter["#d"]
                )
                  continue
                const filterMatches = Array.from(eventsById.values())
                  .filter((event) => eventMatchesFilter(event, filter))
                  .sort(
                    (left, right) =>
                      right.created_at - left.created_at ||
                      left.id.localeCompare(right.id)
                  )
                const limit =
                  typeof filter.limit === "number"
                    ? Math.max(0, Math.floor(filter.limit))
                    : filterMatches.length
                for (const event of filterMatches.slice(0, limit)) {
                  limitedMatchesById.set(event.id, event)
                }
              }
              const limitedMatches = Array.from(limitedMatchesById.values())
              const heldResponse = heldRelayEventResponse
              const heldMatches = heldResponse
                ? limitedMatches.filter((event) =>
                    heldResponse.predicate(request, event)
                  )
                : []
              const immediateMatches =
                heldMatches.length > 0
                  ? limitedMatches.filter(
                      (event) =>
                        !heldMatches.some((held) => held.id === event.id)
                    )
                  : limitedMatches
              request.matchedEventIds = immediateMatches.map(
                (event) => event.id
              )
              for (const event of immediateMatches) {
                socket.send(JSON.stringify(["EVENT", subscriptionId, event]))
              }
              if (
                filters.some((filter) =>
                  filter.kinds?.some((kind) => incompleteReadKinds.has(kind))
                )
              ) {
                incompleteRequests.push(structuredClone(request))
                socket.send(
                  JSON.stringify([
                    "CLOSED",
                    subscriptionId,
                    "error: synthetic incomplete read",
                  ])
                )
                return
              }
              if (heldResponse && heldMatches.length > 0) {
                if (!heldResponse.captured) {
                  heldResponse.captured = true
                  heldResponse.capture({
                    request: structuredClone(request),
                    heldEventIds: heldMatches.map((event) => event.id),
                  })
                }
                void heldResponse.released.then(() => {
                  request.matchedEventIds.push(
                    ...heldMatches.map((event) => event.id)
                  )
                  for (const event of heldMatches) {
                    socket.send(
                      JSON.stringify(["EVENT", subscriptionId, event])
                    )
                  }
                  socket.send(JSON.stringify(["EOSE", subscriptionId]))
                })
                return
              }
              socket.send(JSON.stringify(["EOSE", subscriptionId]))
            }
            const heldRequest = heldRelayRequest
            if (heldRequest?.predicate(request)) {
              if (!heldRequest.captured) {
                heldRequest.captured = true
                heldRequest.capture(structuredClone(request))
              }
              void heldRequest.released.then(respond)
              return
            }
            respond()
            return
          }

          if (
            frame[0] === "EVENT" &&
            isSignedEvent(frame[1]) &&
            verifyEvent(frame[1])
          ) {
            const event = structuredClone(frame[1])
            publications.push({ relayUrl: socket.url(), event })
            if (rejectedKinds.has(event.kind)) {
              socket.send(
                JSON.stringify([
                  "OK",
                  event.id,
                  false,
                  "error: synthetic temporary rejection",
                ])
              )
              return
            }
            eventsById.set(event.id, event)
            const heldAck = heldPublicationAck
            if (heldAck?.predicate(event)) {
              heldPublicationAck = null
              heldAck.capture(event)
              void heldAck.released.then(() => {
                socket.send(JSON.stringify(["OK", event.id, true, "saved"]))
              })
              return
            }
            socket.send(JSON.stringify(["OK", event.id, true, "saved"]))
          }
        })
      })
    },
  }
}

function identitySecret(identity: SyntheticIdentity): Uint8Array {
  return syntheticIdentities[identity].secret
}

function isSyntheticIdentity(value: string): value is SyntheticIdentity {
  return value === "organizer" || value === "merchant" || value === "buyer"
}

async function installSyntheticSigner(page: Page): Promise<void> {
  await page.exposeFunction(
    "__conduitSignSyntheticEvent",
    (identity: string, event: UnsignedEvent) => {
      if (!isSyntheticIdentity(identity)) {
        throw new Error("Synthetic signer identity is invalid.")
      }
      return signEvent(identitySecret(identity), {
        kind: event.kind,
        created_at: event.created_at,
        tags: event.tags,
        content: event.content,
      })
    }
  )
  await page.exposeFunction(
    "__conduitEncryptSyntheticNip44",
    (identity: string, peerPubkey: string, plaintext: string) => {
      if (!isSyntheticIdentity(identity)) {
        throw new Error("Synthetic signer identity is invalid.")
      }
      const conversationKey = nip44.v2.utils.getConversationKey(
        identitySecret(identity),
        peerPubkey
      )
      return nip44.v2.encrypt(plaintext, conversationKey)
    }
  )
  await page.exposeFunction(
    "__conduitDecryptSyntheticNip44",
    (identity: string, peerPubkey: string, ciphertext: string) => {
      if (!isSyntheticIdentity(identity)) {
        throw new Error("Synthetic signer identity is invalid.")
      }
      const conversationKey = nip44.v2.utils.getConversationKey(
        identitySecret(identity),
        peerPubkey
      )
      return nip44.v2.decrypt(ciphertext, conversationKey)
    }
  )
  await page.addInitScript(
    ({ identities, relayUrl, searchKey, storageKey, unavailableKey }) => {
      type Identity = keyof typeof identities
      const requested = new URL(window.location.href).searchParams.get(
        searchKey
      )
      if (requested && requested in identities) {
        const identity = requested as Identity
        localStorage.setItem(storageKey, identity)
        localStorage.setItem("conduit:auth", identities[identity].pubkey)
      }

      const currentIdentity = (): Identity => {
        const identity = localStorage.getItem(storageKey)
        if (identity && identity in identities) return identity as Identity
        throw new Error("Choose a synthetic signer identity before app boot.")
      }
      const signer = window as typeof window & {
        __conduitSyntheticSignAttempts?: number
        __conduitSignSyntheticEvent: (
          identity: Identity,
          event: UnsignedEvent
        ) => Promise<SignedEvent>
        __conduitEncryptSyntheticNip44: (
          identity: Identity,
          peerPubkey: string,
          plaintext: string
        ) => Promise<string>
        __conduitDecryptSyntheticNip44: (
          identity: Identity,
          peerPubkey: string,
          ciphertext: string
        ) => Promise<string>
      }
      signer.__conduitSyntheticSignAttempts = 0
      const signerUnavailable = localStorage.getItem(unavailableKey) === "1"
      Object.defineProperty(window, "nostr", {
        configurable: true,
        value: {
          async getPublicKey() {
            return identities[currentIdentity()].pubkey
          },
          async getRelays() {
            return { [relayUrl]: { read: true, write: true } }
          },
          async signEvent(event: UnsignedEvent) {
            if (localStorage.getItem(unavailableKey) === "1") {
              signer.__conduitSyntheticSignAttempts =
                (signer.__conduitSyntheticSignAttempts ?? 0) + 1
              throw new Error("Synthetic signer is unavailable.")
            }
            return await signer.__conduitSignSyntheticEvent(
              currentIdentity(),
              event
            )
          },
          nip44: {
            encrypt: signerUnavailable
              ? undefined
              : async (peerPubkey: string, plaintext: string) =>
                  await signer.__conduitEncryptSyntheticNip44(
                    currentIdentity(),
                    peerPubkey,
                    plaintext
                  ),
            async decrypt(peerPubkey: string, ciphertext: string) {
              return await signer.__conduitDecryptSyntheticNip44(
                currentIdentity(),
                peerPubkey,
                ciphertext
              )
            },
          },
        },
      })
    },
    {
      identities: {
        organizer: { pubkey: ORGANIZER_PUBKEY },
        merchant: { pubkey: MERCHANT_PUBKEY },
        buyer: { pubkey: BUYER_PUBKEY },
      },
      relayUrl: FIXTURE_RELAY,
      searchKey: SYNTHETIC_IDENTITY_SEARCH_KEY,
      storageKey: SYNTHETIC_IDENTITY_STORAGE_KEY,
      unavailableKey: SYNTHETIC_SIGNER_UNAVAILABLE_KEY,
    }
  )
}

function identityUrl(
  baseUrl: string,
  path: string,
  identity: SyntheticIdentity,
  search: Record<string, string> = {}
): string {
  const url = new URL(path, baseUrl)
  url.searchParams.set(SYNTHETIC_IDENTITY_SEARCH_KEY, identity)
  for (const [key, value] of Object.entries(search)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

async function gotoAs(
  page: Page,
  baseUrl: string,
  path: string,
  identity: SyntheticIdentity,
  search: Record<string, string> = {}
): Promise<void> {
  await page.goto(identityUrl(baseUrl, path, identity, search))
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const nostr = (
          window as typeof window & {
            nostr?: { getPublicKey?: () => Promise<string> }
          }
        ).nostr
        return await nostr?.getPublicKey?.()
      })
    )
    .toBe(syntheticIdentities[identity].pubkey)
}

async function waitForSavedMerchantDecision(
  page: Page,
  marketCoordinate: string,
  action: "approve" | "revoke"
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ coordinate, merchant, action }) =>
          new Promise<boolean>((resolve, reject) => {
            const request = indexedDB.open("conduit")
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
              const database = request.result
              const transaction = database.transaction(
                "eventMarketMerchantDecisionJobs",
                "readonly"
              )
              const jobs = transaction
                .objectStore("eventMarketMerchantDecisionJobs")
                .getAll()
              jobs.onerror = () => reject(jobs.error)
              jobs.onsuccess = () =>
                resolve(
                  jobs.result.some(
                    (job) =>
                      job.marketCoordinate === coordinate &&
                      job.merchantPubkey === merchant &&
                      job.action === action &&
                      job.status === "acknowledged"
                  )
                )
              transaction.oncomplete = () => database.close()
              transaction.onabort = () => {
                database.close()
                reject(transaction.error)
              }
            }
          }),
        { coordinate: marketCoordinate, merchant: MERCHANT_PUBKEY, action }
      )
    )
    .toBe(true)
}

function uniquePublishedEvents(
  publications: readonly PublishedEvent[]
): SignedEvent[] {
  const unique = new Map<string, SignedEvent>()
  for (const publication of publications) {
    if (!unique.has(publication.event.id)) {
      unique.set(publication.event.id, publication.event)
    }
  }
  return Array.from(unique.values())
}

type RelayHarness = ReturnType<typeof createRelayHarness>

function createInboxDeclaration(
  identity: SyntheticIdentity,
  createdAt: number
): SignedEvent {
  return signEvent(identitySecret(identity), {
    kind: 10050,
    created_at: createdAt,
    tags: [["relay", FIXTURE_RELAY]],
    content: "",
  })
}

function createFollowList(
  identity: SyntheticIdentity,
  followedPubkeys: readonly string[],
  createdAt: number
): SignedEvent {
  return signEvent(identitySecret(identity), {
    kind: 3,
    created_at: createdAt,
    tags: followedPubkeys.map((pubkey) => ["p", pubkey]),
    content: "",
  })
}

function decryptPrivateWrap(
  wrap: SignedEvent,
  recipientSecret: Uint8Array
): { seal: SignedEvent; rumor: PrivateRumor } {
  if (wrap.kind !== 1059) throw new Error("Expected a kind-1059 gift wrap.")
  const wrapKey = nip44.v2.utils.getConversationKey(
    recipientSecret,
    wrap.pubkey
  )
  const seal = JSON.parse(
    nip44.v2.decrypt(wrap.content, wrapKey)
  ) as SignedEvent
  if (seal.kind !== 13 || !verifyEvent(seal)) {
    throw new Error("Synthetic gift wrap seal is invalid.")
  }
  const rumorKey = nip44.v2.utils.getConversationKey(
    recipientSecret,
    seal.pubkey
  )
  const rumor = JSON.parse(
    nip44.v2.decrypt(seal.content, rumorKey)
  ) as PrivateRumor
  if (
    (rumor.kind !== 16 && rumor.kind !== 14) ||
    typeof rumor.id !== "string" ||
    typeof rumor.pubkey !== "string" ||
    !Array.isArray(rumor.tags)
  ) {
    throw new Error("Synthetic private rumor is invalid.")
  }
  return { seal, rumor }
}

function decryptPrivatePublications(
  publications: readonly PublishedEvent[],
  recipientSecret: Uint8Array,
  startIndex = 0
): DecryptedPrivatePublication[] {
  const messages: DecryptedPrivatePublication[] = []
  for (let index = startIndex; index < publications.length; index += 1) {
    const wrap = publications[index]!.event
    if (wrap.kind !== 1059) continue
    try {
      const { seal, rumor } = decryptPrivateWrap(wrap, recipientSecret)
      messages.push({ publicationIndex: index, wrap, seal, rumor })
    } catch {
      // A stateful relay carries wraps for all three synthetic principals.
    }
  }
  return messages
}

function rumorType(rumor: PrivateRumor): string | undefined {
  return rumor.tags.find((tag) => tag[0] === "type")?.[1]
}

function formatPickupClaimCode(claimRef: string): string {
  if (!/^[0-9a-f]{64}$/i.test(claimRef)) {
    throw new Error("Synthetic pickup claim is invalid.")
  }
  const short = claimRef.slice(0, 12).toUpperCase()
  return `${short.slice(0, 4)}-${short.slice(4, 8)}-${short.slice(8, 12)}`
}

function uniquePrivatePublications(
  messages: readonly DecryptedPrivatePublication[]
): DecryptedPrivatePublication[] {
  const unique = new Map<string, DecryptedPrivatePublication>()
  for (const message of messages) {
    if (!unique.has(message.rumor.id)) unique.set(message.rumor.id, message)
  }
  return Array.from(unique.values())
}

async function installSyntheticEnvironment(
  page: Page,
  relay: RelayHarness,
  relayClientId?: string
): Promise<void> {
  await relay.install(page, relayClientId)
  await installSyntheticSigner(page)
  await page.route("https://event-market-e2e.conduit.market/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({
        name: "Synthetic in-browser relay",
        supported_nips: [1, 9, 11, 17, 33, 52, 65, 99],
      }),
    })
  )
  await page.route("https://cdn.conduit.market/conduit-test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#ddd7ca"/></svg>',
    })
  )
}

function createMerchantTemplateProductEvent(createdAt: number): SignedEvent {
  return signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: createdAt,
    content: "A reusable merchant product template.",
    tags: [
      ["d", MERCHANT_TEMPLATE_D_TAG],
      ["title", MERCHANT_TEMPLATE_TITLE],
      ["summary", "A reusable merchant product template."],
      ["price", "2500", "SATS"],
      ["type", "simple", "physical"],
      ["stock", "9"],
      ["image", "https://cdn.conduit.market/conduit-test/template-product.svg"],
      ["t", "existing"],
      ["t", "merchant"],
      ["t", "template"],
    ],
  })
}

test("Merchant explicitly enables and disables event-only selling without changing product identity @merchant @commerce @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  relay.seed(
    createMerchantTemplateProductEvent(Math.floor(Date.now() / 1000) - 10)
  )
  await gotoAs(page, merchantUrl, "/network", "merchant")
  await enablePrivateInbox(page)
  await page.goto(`${merchantUrl}/products`)
  for (const choice of [true, undefined, false]) {
    const before = uniquePublishedEvents(relay.publications).filter(
      (event) => event.kind === 30402
    ).length
    const edit = page.getByRole("button", { name: "Edit", exact: true }).first()
    await expect(edit).toBeVisible()
    await edit.evaluate((element) =>
      element.scrollIntoView({ behavior: "instant", block: "center" })
    )
    await edit.click()
    const dialog = page.getByRole("dialog", {
      name: "Edit listing",
      exact: true,
    })
    await expect(dialog).toBeVisible()
    const eventOnly = dialog.getByRole("checkbox", {
      name: "Sell only at events",
      exact: true,
    })
    await expect(eventOnly).toBeChecked({ checked: choice !== true })
    if (choice === undefined) {
      await dialog
        .getByLabel("Title", { exact: true })
        .fill("Event-only mug revised")
    } else {
      await eventOnly.setChecked(choice)
    }
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click()
    await expect
      .poll(
        () =>
          uniquePublishedEvents(relay.publications).filter(
            (event) => event.kind === 30402
          ).length
      )
      .toBe(before + 1)
    await expect(dialog).toBeHidden()
    const signed = uniquePublishedEvents(relay.publications)
      .filter((event) => event.kind === 30402)
      .at(-1)!
    expect(eventCoordinate(signed)).toBe(
      `30402:${MERCHANT_PUBKEY}:${MERCHANT_TEMPLATE_D_TAG}`
    )
    expect(
      signed.tags.some((tag) => tag[0] === "visibility" && tag[1] === "hidden")
    ).toBe(choice !== false)
    expect(
      signed.tags.some(
        (tag) => tag[0] === "conduit_event_only" && tag[1] === "1"
      )
    ).toBe(choice !== false)
    expect(signed.tags.find((tag) => tag[0] === "stock")?.[1]).toBe("9")
    await page.reload()
  }
})

function seedHistoricalEvent(relay: RelayHarness, title: string) {
  const createdAt = Math.floor(Date.now() / 1000) - 100
  const calendar = signEvent(ORGANIZER_SECRET, {
    kind: 31923,
    created_at: createdAt,
    content: "Historical schedule",
    tags: [
      ["d", "historical-fair"],
      ["title", title],
      ["start", "1790000000"],
      ["end", "1790003600"],
      ["D", "20717"],
      ["location", "Historical Hall"],
    ],
  })
  const collection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: createdAt + 1,
    content: "Historical event catalog",
    tags: [
      ["d", "historical-fair"],
      ["title", title],
      ["summary", "Historical event catalog"],
      ["a", eventCoordinate(calendar)],
      ["conduit_event_market", "1", "closed"],
    ],
  })
  relay.seed(calendar, collection)
  return {
    calendar,
    collection,
    reference: nip19.naddrEncode({
      kind: 30405,
      pubkey: ORGANIZER_PUBKEY,
      identifier: "historical-fair",
      relays: [FIXTURE_RELAY],
    }),
  }
}

test("old collection event links require reposting and never activate commerce @market @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const { reference } = seedHistoricalEvent(relay, "Old Fair")
  const publicationCount = relay.publications.length
  await gotoAs(page, marketUrl, `/events/${reference}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "This event needs to be reposted" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /Add to cart/i })).toHaveCount(
    0
  )
  await gotoAs(page, merchantUrl, `/events/${reference}`, "organizer")
  await expect(page.getByText(/repost/i).first()).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: /Approve merchant|Publish product|Update event/i,
    })
  ).toHaveCount(0)
  expect(relay.publications).toHaveLength(publicationCount)
})

test("future Event Market catalog follows signed merchant approval and current product revisions @market", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000)
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "future-fair",
      title: "Future Fair",
      start: createdAt + 7_200,
      end: createdAt + 10_800,
    }),
    created_at: createdAt,
  })
  const marketTags = (
    assignment: string,
    merchantApproved: boolean,
    previous?: string
  ) => [
    ["d", "future-fair"],
    ["a", eventCoordinate(calendar)],
    ["event_market", "2", "open"],
    ...(merchantApproved
      ? [["merchant", MERCHANT_PUBKEY, "merchant_present", assignment]]
      : []),
    ...(previous ? [["prev", previous]] : []),
  ]
  const approval = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: marketTags("Booth 12", true),
  })
  const grant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(approval)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  const productTags = (tagged: boolean) => [
    ["d", "future-soap"],
    ["title", "Future Fair soap"],
    ["image", "https://cdn.conduit.market/conduit-test/template-product.svg"],
    ["price", "12", "USD"],
    ["type", "simple", "physical"],
    ["stock", "5"],
    ...(tagged ? [["a", eventCoordinate(approval)]] : []),
  ]
  const product = signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: createdAt,
    content: "Handmade soap",
    tags: productTags(true),
  })
  const unapprovedProducts = Array.from({ length: 48 }, (_, index) =>
    signEvent(BUYER_SECRET, {
      kind: 30402,
      created_at: createdAt + index + 1,
      content: "Unapproved catalog listing",
      tags: [
        ["d", `unapproved-${index}`],
        ["title", `Unapproved catalog listing ${index}`],
        ["price", "1", "USD"],
        ["type", "simple", "physical"],
        ["a", eventCoordinate(approval)],
      ],
    })
  )
  const assignment = signedAssignment(approval, calendar, product)
  relay.seed(
    calendar,
    approval,
    grant,
    product,
    assignment,
    ...unapprovedProducts,
    createFollowList("buyer", [ORGANIZER_PUBKEY], createdAt + 1),
    createFollowList("merchant", [ORGANIZER_PUBKEY], createdAt + 1)
  )
  const marketNaddr = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "future-fair",
  })
  await gotoAs(page, marketUrl, "/events?source=following", "buyer")
  await expect(
    page.getByRole("button", { name: /^Open Future Fair\./ })
  ).toBeVisible()
  await page.getByRole("button", { name: /^Open Future Fair\./ }).click()
  expect(
    nip19.decode(new URL(page.url()).pathname.split("/").pop()!).data
  ).toMatchObject({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "future-fair",
  })
  await expect(
    page.getByRole("img", { name: "Future Fair event QR code" })
  ).toBeVisible()
  await gotoAs(page, merchantUrl, "/events", "merchant")
  await expect(
    page.getByRole("button", { name: /^Open Future Fair\./ })
  ).toBeVisible()
  await page.getByRole("button", { name: /^Open Future Fair\./ }).click()
  expect(
    nip19.decode(new URL(page.url()).pathname.split("/").pop()!).data
  ).toMatchObject({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "future-fair",
  })
  const beforeCatalog = relay.requests.length
  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Future Fair", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: /^Unapproved catalog listing/ })
  ).toHaveCount(0)
  await expect(page.getByText(/Merchant booth: Booth 12/)).toBeVisible()
  const discoveryRequests = relay.requests.slice(beforeCatalog)
  expect(
    discoveryRequests.some((request) =>
      request.filters.some((filter) => filter.kinds?.includes(3841))
    )
  ).toBe(false)
  expect(
    discoveryRequests.some((request) =>
      request.filters.some(
        (filter) =>
          filter.kinds?.includes(30410) &&
          filter.authors?.length === 1 &&
          filter.authors[0] === MERCHANT_PUBKEY
      )
    )
  ).toBe(true)
  await gotoAs(
    page,
    marketUrl,
    `/events/${marketNaddr}?merchant=${nip19.npubEncode(MERCHANT_PUBKEY)}`,
    "buyer"
  )
  const boothQr = page.getByRole("img", { name: /booth QR code/ })
  await expect(boothQr).toBeVisible()
  const boothUrl = await boothQr.locator("..").locator("p").textContent()
  expect(new URL(boothUrl!).searchParams.get("merchant")).toBe(
    nip19.npubEncode(MERCHANT_PUBKEY)
  )
  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("button", { name: /^Add .+ to cart$/ })
  ).toBeEnabled()
  await page.getByRole("heading", { name: "Future Fair soap" }).click()
  await expect(page).toHaveURL(/\/products\/.*[?&]event=/)
  const directProductUrl = page.url()
  await expect(
    page.getByRole("button", { name: /Add 1 to cart/ })
  ).toBeEnabled()
  await page.goBack()
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toBeVisible()

  const removal = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt + 1,
    content: "",
    tags: marketTags("Booth 12", false, approval.id),
  })
  const revoke = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt + 1,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(approval)],
      ["p", MERCHANT_PUBKEY],
      ["state", "revoked"],
      ["seq", "1"],
      ["auth_parent", grant.id],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  relay.seed(removal, revoke)
  await page.getByRole("button", { name: "Refresh event records" }).click()
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toHaveCount(0)
  await page.goto(directProductUrl)
  await expect(
    page.getByText(/not currently eligible at this Event Market/)
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /Add 1 to cart/ })).toHaveCount(
    0
  )
  await page.goBack()

  const reapproval = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt + 2,
    content: "",
    tags: marketTags("Booth 14", true, removal.id),
  })
  const regrant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt + 2,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(approval)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "2"],
      ["auth_parent", revoke.id],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  relay.seed(reapproval, regrant)
  await page.getByRole("button", { name: "Refresh event records" }).click()
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toBeVisible()
  await expect(page.getByText(/Merchant booth: Booth 14/)).toBeVisible()

  relay.seed(
    signEvent(MERCHANT_SECRET, {
      kind: 30402,
      created_at: createdAt + 3,
      content: "Handmade soap",
      tags: productTags(false),
    })
  )
  await page.getByRole("button", { name: "Refresh event records" }).click()
  // Removing the old product's event tag does not remove its independent
  // occurrence assignment.
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toBeVisible()
  relay.seed(
    signEvent(MERCHANT_SECRET, {
      ...buildEventMarketAssignmentDraft({
        marketCoordinate: eventCoordinate(approval),
        occurrenceCoordinate: eventCoordinate(calendar),
        productCoordinate: eventCoordinate(product),
        merchantPubkey: MERCHANT_PUBKEY,
        state: "removed",
        inventory: { mode: "tracked", quantity: 0 },
        fulfillmentMethods: [],
        previousEventId: assignment.id,
      }),
      created_at: createdAt + 4,
    })
  )
  await page.getByRole("button", { name: "Refresh event records" }).click()
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toHaveCount(0)
  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByText("Your cart is empty", { exact: true })
  ).toBeVisible()
  await page.goto(directProductUrl)
  await expect(
    page.getByText(/not currently eligible at this Event Market/)
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /Add 1 to cart/ })).toHaveCount(
    0
  )
})

test("signed series dates open one market and keep separate buyer choices @market @merchant @commerce", async ({
  page,
}) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(15_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000)
  const firstStart =
    Math.floor((createdAt + 30 * 86_400) / 86_400) * 86_400 + 10 * 3_600
  const secondStart = firstStart + 7 * 86_400
  const occurrence = (dTag: string, start: number) =>
    signEvent(ORGANIZER_SECRET, {
      kind: 31923,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", dTag],
        ["title", "Series Fair"],
        ["start", String(start)],
        ["end", String(start + 6 * 3_600)],
        ["start_tzid", "UTC"],
        ["end_tzid", "UTC"],
        ["location", "Town Hall"],
        ["D", String(Math.floor(start / 86_400))],
      ],
    })
  const first = occurrence("series-fair-first", firstStart)
  const second = occurrence("series-fair-second", secondStart)
  const schedule = signEvent(ORGANIZER_SECRET, {
    kind: 31924,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "series-fair-schedule"],
      ["title", "Series Fair"],
      ["a", eventCoordinate(first)],
      ["a", eventCoordinate(second)],
    ],
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "series-fair"],
      ["a", eventCoordinate(schedule)],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 12"],
    ],
  })
  const grant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(market)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  const product = signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: createdAt,
    content: "Series soap",
    tags: [
      ["d", "series-soap"],
      ["image", "https://cdn.conduit.market/conduit-test/template-product.svg"],
      ["title", "Series soap"],
      ["price", "12", "USD"],
      ["type", "simple", "physical"],
      ["a", eventCoordinate(market)],
    ],
  })
  relay.seed(
    first,
    second,
    schedule,
    market,
    grant,
    product,
    signedAssignment(market, first, product),
    signedAssignment(market, second, product),
    createFollowList("buyer", [ORGANIZER_PUBKEY], createdAt + 1),
    createFollowList("merchant", [ORGANIZER_PUBKEY], createdAt + 1)
  )
  await gotoAs(page, marketUrl, "/events?source=following", "buyer")
  await expect(
    page.getByRole("button", { name: /^Open Series Fair\./ })
  ).toHaveCount(2)
  await page
    .getByRole("button", { name: /^Open Series Fair\./ })
    .first()
    .click()
  expect(new URL(page.url()).searchParams.get("occurrence")).toBe(
    eventCoordinate(first)
  )
  relay.incompleteReadsForKind(31923)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Series soap" })).toBeVisible()
  await page.getByRole("combobox", { name: "Choose date" }).click()
  await page.getByRole("option").last().click()
  expect(new URL(page.url()).searchParams.get("occurrence")).toBe(
    eventCoordinate(second)
  )
  expect(
    relay.incompleteRequests.some((request) =>
      request.matchedEventIds.includes(second.id)
    )
  ).toBe(true)
  const selectedDateLabel = await page
    .getByRole("combobox", { name: "Choose date" })
    .textContent()
  await page.evaluate(() => {
    const target = window as typeof window & { __eventMarketSharedUrl?: string }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (url: string) => {
          target.__eventMarketSharedUrl = url
        },
      },
    })
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        target.__eventMarketSharedUrl = data.url
      },
    })
  })
  await page.getByRole("button", { name: "Share event Series Fair" }).click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as typeof window & { __eventMarketSharedUrl?: string })
            .__eventMarketSharedUrl
        )
      )
    )
    .toBe(true)
  const sharedUrl = await page.evaluate(
    () =>
      (window as typeof window & { __eventMarketSharedUrl?: string })
        .__eventMarketSharedUrl!
  )
  const qrUrl = await page
    .getByRole("img", { name: "Series Fair event QR code" })
    .locator("..")
    .locator("p")
    .textContent()
  for (const destination of [sharedUrl, qrUrl!]) {
    expect(
      new URL(destination).searchParams.get("occurrence") ===
        eventCoordinate(second)
    ).toBe(true)
    await page.goto(destination)
    await expect(
      page.getByRole("heading", { name: "Series soap" })
    ).toBeVisible()
    expect(
      new URL(page.url()).searchParams.get("occurrence") ===
        eventCoordinate(second)
    ).toBe(true)
    expect(
      (await page
        .getByRole("combobox", { name: "Choose date" })
        .textContent()) === selectedDateLabel
    ).toBe(true)
    await expect(
      page.getByRole("button", { name: /^Add .+ to cart$/ })
    ).toBeEnabled()
  }
  await gotoAs(
    page,
    marketUrl,
    `/products/${encodeURIComponent(eventCoordinate(product))}?event=${encodeURIComponent(nip19.naddrEncode({ kind: 30409, pubkey: ORGANIZER_PUBKEY, identifier: "series-fair" }))}`,
    "buyer"
  )
  await page.getByRole("combobox", { name: "Choose date" }).click()
  await page.getByRole("option").last().click()
  expect(new URL(page.url()).searchParams.get("occurrence")).toBe(
    eventCoordinate(second)
  )
  await expect(
    page.getByRole("button", { name: /^Add \d+ to cart$/ })
  ).toBeEnabled()
  await gotoAs(page, merchantUrl, "/events", "merchant")
  await expect(
    page.getByRole("button", { name: /^Open Series Fair\./ })
  ).toHaveCount(2)
  relay.remove(second)
  await gotoAs(
    page,
    marketUrl,
    `/events/${nip19.naddrEncode({ kind: 30409, pubkey: ORGANIZER_PUBKEY, identifier: "series-fair" })}`,
    "buyer"
  )
  await page.getByRole("combobox", { name: "Choose date" }).click()
  await expect(page.getByRole("option").first()).toBeEnabled()
  await expect(page.getByRole("option").last()).toBeDisabled()
})

async function createAssignedPickupOrder(
  page: Page,
  options: {
    zeroCost?: boolean
    organizerHandoff?: boolean
    beforeBuyer?: (input: {
      relay: RelayHarness
      marketNaddr: string
      assignment: SignedEvent
      product: SignedEvent
    }) => Promise<SignedEvent>
  } = {}
) {
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "merchant-fair",
      title: "Merchant Fair",
      start: createdAt + 7_200,
      end: createdAt + 10_800,
      locations: ["100 Public Square"],
    }),
    created_at: createdAt,
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "merchant-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      [
        "merchant",
        MERCHANT_PUBKEY,
        options.organizerHandoff ? "organizer_handoff" : "merchant_present",
        "Booth 7",
      ],
    ],
  })
  const grant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(market)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  const template = createMerchantTemplateProductEvent(createdAt)
  const product = options.zeroCost
    ? signEvent(MERCHANT_SECRET, {
        ...template,
        tags: template.tags.map((tag) =>
          tag[0] === "price" ? ["price", "0", "SATS"] : tag
        ),
      })
    : template
  relay.seed(
    calendar,
    market,
    grant,
    product,
    createInboxDeclaration("merchant", createdAt),
    createInboxDeclaration("buyer", createdAt),
    createInboxDeclaration("organizer", createdAt)
  )
  const marketNaddr = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "merchant-fair",
  })
  const productPath = "/products?eventMarket=" + marketNaddr
  await gotoAs(page, merchantUrl, productPath, "merchant")
  const panel = page.getByRole("region", { name: "Occurrence assignments" })
  await expect(panel).toBeVisible()
  expect(
    await panel.evaluate((element) =>
      parseFloat(getComputedStyle(element).borderTopLeftRadius)
    )
  ).toBeLessThanOrEqual(8)
  await expect(
    panel.getByRole("heading", { name: "Assign products to an event date" })
  ).toBeVisible()
  await panel.getByRole("combobox", { name: "Event date" }).click()
  await page.getByRole("option", { name: /Merchant Fair/ }).click()
  await panel.getByRole("combobox", { name: "Product or variation" }).click()
  await page.getByRole("option", { name: MERCHANT_TEMPLATE_TITLE }).click()
  await panel.getByRole("textbox", { name: "Pickup allocation" }).fill("2")

  const publicationStart = relay.publications.length
  await panel.getByRole("button", { name: "Add to event", exact: true }).click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(
          relay.publications.slice(publicationStart)
        ).filter((event) => event.kind === 30410).length
    )
    .toBe(1)
  const published = uniquePublishedEvents(
    relay.publications.slice(publicationStart)
  )
  const assignment = published.find((event) => event.kind === 30410)!
  expect(verifyEvent(assignment)).toBe(true)
  expect(parseEventMarketAssignmentEvent(assignment)).toMatchObject({
    marketCoordinate: eventCoordinate(market),
    occurrenceCoordinate: eventCoordinate(calendar),
    productCoordinate: eventCoordinate(product),
    merchantPubkey: MERCHANT_PUBKEY,
    state: "active",
    inventory: { mode: "tracked", quantity: 2 },
    fulfillmentMethods: ["pickup"],
  })
  expect(
    published.some(
      (event) =>
        event.kind === 30402 || event.kind === 30406 || event.kind === 30405
    )
  ).toBe(false)
  expect(relay.events().find((event) => event.id === product.id)).toEqual(
    product
  )

  await page.reload()
  const savedPanel = page.getByRole("region", {
    name: "Occurrence assignments",
  })
  await savedPanel.getByRole("combobox", { name: "Event date" }).click()
  await page.getByRole("option", { name: /Merchant Fair/ }).click()
  await savedPanel
    .getByRole("combobox", { name: "Product or variation" })
    .click()
  await page.getByRole("option", { name: MERCHANT_TEMPLATE_TITLE }).click()
  await expect(
    savedPanel.getByRole("textbox", { name: "Pickup allocation" })
  ).toHaveValue("2")
  await expect(
    savedPanel.getByRole("button", { name: "Save allocation" })
  ).toBeVisible()

  const checkoutAssignment = options.beforeBuyer
    ? await options.beforeBuyer({ relay, marketNaddr, assignment, product })
    : assignment
  await gotoAs(page, marketUrl, "/events/" + marketNaddr, "buyer")
  await expect(
    page.getByRole("heading", { name: MERCHANT_TEMPLATE_TITLE })
  ).toBeVisible({ timeout: 25_000 })
  await expect(
    page.getByText(
      options.organizerHandoff
        ? /Organizer pickup: Booth 7/
        : /Merchant booth: Booth 7/
    )
  ).toBeVisible()
  const card = page
    .getByRole("listitem")
    .filter({ hasText: MERCHANT_TEMPLATE_TITLE })
  await card.getByRole("button", { name: /^Add .+ to cart$/ }).click()
  await expect(page.getByRole("button", { name: "Cart, 1 item" })).toBeVisible()
  await gotoAs(page, marketUrl, "/cart", "buyer")
  await page.getByRole("button", { name: "Order", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible()
  const orderStart = relay.publications.length
  await page.getByRole("button", { name: /^Send order$/i }).click()
  await expect(page).toHaveURL(/\/orders(?:\?|$)/, { timeout: 30_000 })
  await expect(
    page.getByRole("heading", { name: "Orders", exact: true })
  ).toBeVisible()
  const orderMessages = () =>
    uniquePrivatePublications(
      decryptPrivatePublications(
        relay.publications,
        MERCHANT_SECRET,
        orderStart
      )
    ).filter((message) => rumorType(message.rumor) === "order")
  await expect.poll(() => orderMessages().length).toBe(1)
  const order = JSON.parse(orderMessages()[0]!.rumor.content) as {
    id: string
    items: Array<{
      fulfillment?: {
        type?: string
        occurrenceAssignment?: { eventId: string }
      }
    }>
  }
  expect(order.items[0]?.fulfillment?.type).toBe("event_market_pickup")
  expect(order.items[0]?.fulfillment?.occurrenceAssignment?.eventId).toBe(
    checkoutAssignment.id
  )

  return {
    relay,
    createdAt,
    calendar,
    market,
    product,
    assignment: checkoutAssignment,
    marketNaddr,
    productPath,
    order,
  }
}

test("Merchant assigns an approved shop product to one date without changing its listing @market @merchant @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const { productPath, order } = await createAssignedPickupOrder(page)
  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  await page.getByRole("button", { name: "Accept order", exact: true }).click()
  // This control exists only after the exact acceptance is read from storage.
  // Publication can replace the transient notice before the next render.
  await expect(
    page.getByRole("button", {
      name: "Retry acceptance publication",
      exact: true,
    })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByText(/Accepted inventory is saved on this device/)
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Accept order", exact: true })
  ).toHaveCount(0)

  await gotoAs(page, merchantUrl, productPath, "merchant")
  const afterOrderPanel = page.getByRole("region", {
    name: "Occurrence assignments",
  })
  await afterOrderPanel.getByRole("combobox", { name: "Event date" }).click()
  await page.getByRole("option", { name: /Merchant Fair/ }).click()
  await afterOrderPanel
    .getByRole("combobox", { name: "Product or variation" })
    .click()
  await page.getByRole("option", { name: MERCHANT_TEMPLATE_TITLE }).click()
  await expect(
    afterOrderPanel.getByRole("textbox", { name: "Pickup allocation" })
  ).toHaveValue("1")
})

test("organizer grants, revokes, and reapproves one merchant without republishing products @market @merchant", async ({
  page,
}) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "organizer-grants-fair",
      title: "Organizer Grants Fair",
      start: createdAt + 7_200,
      end: createdAt + 10_800,
    }),
    created_at: createdAt,
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "organizer-grants-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
    ],
  })
  const product = signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: createdAt,
    content: "Soap",
    tags: [
      ["d", "organizer-grants-soap"],
      ["title", "Organizer Grants soap"],
      ["price", "12", "USD"],
      ["type", "simple", "physical"],
      ["a", eventCoordinate(market)],
    ],
  })
  relay.seed(
    calendar,
    market,
    product,
    signedAssignment(market, calendar, product)
  )
  const marketNaddr = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "organizer-grants-fair",
  })

  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Organizer Grants soap" })
  ).toHaveCount(0)

  await gotoAs(page, merchantUrl, `/events/${marketNaddr}`, "organizer")
  await page
    .getByRole("textbox", { name: "Merchant pubkey" })
    .fill(MERCHANT_PUBKEY)
  await page.getByRole("button", { name: "Review seller" }).click()
  await page
    .getByRole("textbox", { name: "Public assignment" })
    .fill("Booth 12")
  await page.getByRole("button", { name: "Approve merchant" }).click()
  await expect(page.getByText("Approved", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true })
  ).toBeEnabled()
  const approvedWrites = uniquePublishedEvents(relay.publications)
  expect(approvedWrites.map((event) => event.kind)).toContain(3841)
  expect(approvedWrites.map((event) => event.kind)).toContain(30409)
  expect(approvedWrites.some((event) => event.kind === 30402)).toBe(false)

  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Organizer Grants soap" })
  ).toBeVisible()

  await gotoAs(page, merchantUrl, `/events/${marketNaddr}`, "organizer")
  await page.getByRole("button", { name: "Revoke" }).click()
  await expect
    .poll(() =>
      uniquePublishedEvents(relay.publications).some(
        (event) =>
          event.kind === 3841 &&
          event.tags.some((tag) => tag[0] === "state" && tag[1] === "revoked")
      )
    )
    .toBe(true)
  // Refresh can remove this uninvited seller's card with the roster row.
  // Check both published authorities and the settled journal, not transient copy.
  await expect
    .poll(() => {
      const rosters = uniquePublishedEvents(relay.publications).filter(
        (event) => event.kind === 30409
      )
      return rosters
        .at(-1)
        ?.tags.some(
          (tag) => tag[0] === "merchant" && tag[1] === MERCHANT_PUBKEY
        )
    })
    .toBe(false)
  await waitForSavedMerchantDecision(page, eventCoordinate(market), "revoke")
  await expect(
    page.getByRole("button", { name: "Retry saved decision" })
  ).toHaveCount(0)
  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Organizer Grants soap" })
  ).toHaveCount(0)

  await gotoAs(page, merchantUrl, `/events/${marketNaddr}`, "organizer")
  await page
    .getByRole("textbox", { name: "Merchant pubkey" })
    .fill(MERCHANT_PUBKEY)
  await page.getByRole("button", { name: "Review seller" }).click()
  await page
    .getByRole("textbox", { name: "Public assignment" })
    .fill("Booth 14")
  await page.getByRole("button", { name: "Approve merchant" }).click()
  await expect(
    page.getByText(/all still-tagged products reappear/)
  ).toBeVisible()
  await page.getByRole("button", { name: "Confirm reapproval" }).click()
  await expect(page.getByText("Approved", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true })
  ).toBeEnabled()

  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Organizer Grants soap" })
  ).toBeVisible()
  await expect(page.getByText(/Merchant booth: Booth 14/)).toBeVisible()
})

test("Event Market variable products select a purchasable variation before checkout @market @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(300_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "future-handoff-fair",
      title: "Future Handoff Fair",
      start: createdAt + 7_200,
      end: createdAt + 10_800,
      locations: ["Town Hall"],
    }),
    created_at: createdAt,
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "future-handoff-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT_PUBKEY, "organizer_handoff", "Pickup Desk"],
    ],
  })
  const grant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(market)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  const product = (name: string, dTag: string) =>
    signEvent(MERCHANT_SECRET, {
      kind: 30402,
      created_at: createdAt,
      content: name,
      tags: [
        ["d", dTag],
        ["title", name],
        ["price", "0", "SAT"],
        [
          "type",
          dTag === "future-handoff-soap" ? "variable" : "variation",
          "physical",
        ],
        ...(dTag === "future-handoff-candle"
          ? [
              ["a", `30402:${MERCHANT_PUBKEY}:future-handoff-soap`],
              ["spec", "Size", "Large"],
            ]
          : []),
        ["stock", "5"],
        [
          "image",
          "https://cdn.conduit.market/conduit-test/template-product.svg",
        ],
        ["t", "market"],
        ["t", "merchant"],
        ["t", "handmade"],
        ["a", eventCoordinate(market)],
      ],
    })
  const soap = product("Future handoff soap", "future-handoff-soap")
  const candle = product("Future handoff candle", "future-handoff-candle")
  const originalCandleAssignment = signedAssignment(market, calendar, candle)
  const candleStockGrant = createEventMarketStockAuthorityRumor({
    createdAt,
    payload: {
      version: 1,
      type: "grant",
      merchantPubkey: MERCHANT_PUBKEY,
      organizerPubkey: ORGANIZER_PUBKEY,
      writerId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      productCoordinate: eventCoordinate(candle),
      assignmentCoordinate: eventCoordinate(originalCandleAssignment),
      marketCoordinate: eventCoordinate(market),
      occurrenceCoordinate: eventCoordinate(calendar),
      productEventId: candle.id,
      assignmentEventId: originalCandleAssignment.id,
      marketEventId: market.id,
      occurrenceEventId: calendar.id,
      grantEventId: grant.id,
      quantity: 5,
      expiresAtMs: (createdAt + 10_800) * 1_000,
    },
  })
  const committedCandleAssignment = signEvent(MERCHANT_SECRET, {
    ...buildEventMarketAssignmentDraft({
      marketCoordinate: eventCoordinate(market),
      occurrenceCoordinate: eventCoordinate(calendar),
      productCoordinate: eventCoordinate(candle),
      merchantPubkey: MERCHANT_PUBKEY,
      state: "active",
      inventory: { mode: "tracked", quantity: 5 },
      fulfillmentMethods: ["pickup"],
      previousEventId: originalCandleAssignment.id,
      organizerStockPool: {
        state: "active",
        poolId: candleStockGrant.id,
        organizerPubkey: ORGANIZER_PUBKEY,
        quantity: 5,
        importedQuantity: 0,
      },
    }),
    created_at: createdAt + 1,
  })
  const committedPool = parseEventMarketAssignmentEvent(
    committedCandleAssignment
  )?.stockPool
  expect(
    committedPool?.state === "valid" &&
      committedPool.pool.poolId === candleStockGrant.id
  ).toBe(true)
  relay.seed(
    calendar,
    market,
    grant,
    soap,
    candle,
    signedAssignment(market, calendar, soap),
    originalCandleAssignment,
    committedCandleAssignment,
    createInboxDeclaration("organizer", createdAt),
    createInboxDeclaration("merchant", createdAt),
    createInboxDeclaration("buyer", createdAt)
  )
  const marketNaddr = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "future-handoff-fair",
  })
  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible()
  const card = page
    .getByRole("listitem")
    .filter({ hasText: "Future handoff soap" })
  await expect(
    card.getByRole("button", { name: /^Add .+ to cart$/ })
  ).toBeEnabled()
  await card.getByRole("button", { name: /^Add .+ to cart$/ }).click()
  await expect(page).toHaveURL(/\/products\//)
  expect(new URL(page.url()).searchParams.get("event")).toBe(
    eventCoordinate(market)
  )
  await expect(page.getByRole("button", { name: "Cart, 1 item" })).toHaveCount(
    0
  )
  const add = page.getByRole("button", { name: /^Add 1 to cart$/i })
  await expect(add).toBeEnabled()
  await add.click()
  await expect(page.getByRole("button", { name: "Cart, 1 item" })).toBeVisible()
  await gotoAs(page, marketUrl, "/cart", "buyer")
  await page.getByRole("button", { name: "Order", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible()
  await expect(
    page.getByText(/Pickup from event organizer/).first()
  ).toBeVisible()
  const orderStart = relay.publications.length
  await page.getByRole("button", { name: /^Send order$/i }).click()
  await expect(page).toHaveURL(/\/orders(?:\?|$)/)
  const orders = () =>
    uniquePrivatePublications(
      decryptPrivatePublications(
        relay.publications,
        MERCHANT_SECRET,
        orderStart
      )
    ).filter((message) => rumorType(message.rumor) === "order")
  await expect.poll(() => orders().length).toBe(1)
  const order = JSON.parse(orders()[0]!.rumor.content) as {
    items: Array<{
      productId: string
      selectedSpecifications?: Array<{ key: string; value: string }>
      fulfillment?: { type: string; market?: { coordinate: string } }
    }>
  }
  expect(order.items.length === 1).toBe(true)
  expect(order.items[0]?.productId === eventCoordinate(candle)).toBe(true)
  expect(
    JSON.stringify(order.items[0]?.selectedSpecifications) ===
      JSON.stringify([{ key: "Size", value: "Large" }])
  ).toBe(true)
  expect(order.items[0]?.fulfillment?.type).toBe("event_market_pickup")
  expect(
    order.items[0]?.fulfillment?.market?.coordinate === eventCoordinate(market)
  ).toBe(true)
})

test("two historical future market products retain one authenticated order and private organizer release @market @merchant", async ({
  page,
}) => {
  test.setTimeout(300_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "future-handoff-fair",
      title: "Future Handoff Fair",
      start: createdAt + 7_200,
      end: createdAt + 10_800,
      locations: ["Town Hall"],
    }),
    created_at: createdAt,
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "future-handoff-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT_PUBKEY, "organizer_handoff", "Pickup Desk"],
    ],
  })
  const grant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(market)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  const product = (name: string, dTag: string) =>
    signEvent(MERCHANT_SECRET, {
      kind: 30402,
      created_at: createdAt,
      content: name,
      tags: [
        ["d", dTag],
        ["title", name],
        ["price", "0", "SAT"],
        ["type", "simple", "physical"],
        ["stock", "5"],
        [
          "image",
          "https://cdn.conduit.market/conduit-test/template-product.svg",
        ],
        ["t", "market"],
        ["t", "merchant"],
        ["t", "handmade"],
        ["a", eventCoordinate(market)],
      ],
    })
  const soap = product("Future handoff soap", "future-handoff-soap")
  const candle = product("Future handoff candle", "future-handoff-candle")
  const soapAssignment = signedAssignment(market, calendar, soap)
  const candleAssignment = signedAssignment(market, calendar, candle)
  relay.seed(
    calendar,
    market,
    grant,
    soap,
    candle,
    soapAssignment,
    candleAssignment,
    createInboxDeclaration("organizer", createdAt),
    createInboxDeclaration("merchant", createdAt),
    createInboxDeclaration("buyer", createdAt)
  )
  const marketNaddr = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "future-handoff-fair",
  })
  // New organizer checkout requires its finite reserved stock grant. Replay
  // this older release profile through a genuine Buyer-authored NIP-59 order,
  // retaining its exact signed terms rather than bypassing current admission.
  const snapshot = (event: SignedEvent) => ({
    coordinate: eventCoordinate(event),
    eventId: event.id,
    createdAt: event.created_at * 1_000,
    signedEvent: event,
  })
  const order = orderSchema.parse({
    id: "historical-grouped-organizer-handoff",
    buyerPubkey: BUYER_PUBKEY,
    merchantPubkey: MERCHANT_PUBKEY,
    items: [
      { event: soap, assignment: soapAssignment, quantity: 2 },
      { event: candle, assignment: candleAssignment, quantity: 1 },
    ].map(({ event, assignment, quantity }) => ({
      productId: eventCoordinate(event),
      title: event.tags.find((tag) => tag[0] === "title")?.[1],
      format: "physical",
      quantity,
      priceAtPurchase: 0,
      currency: "SATS",
      sourcePrice: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
      shippingCostSats: 0,
      fulfillment: {
        type: "event_market_pickup",
        organizerPubkey: ORGANIZER_PUBKEY,
        merchantPubkey: MERCHANT_PUBKEY,
        payeePubkey: MERCHANT_PUBKEY,
        market: snapshot(market),
        calendar: {
          ...snapshot(calendar),
          start: (createdAt + 7_200) * 1_000,
          end: (createdAt + 10_800) * 1_000,
        },
        grant: {
          kind: 3841,
          pubkey: ORGANIZER_PUBKEY,
          eventId: grant.id,
          createdAt: grant.created_at * 1_000,
          ancestryEventIds: [grant.id],
          observedDeletionEventIds: [],
          signedEvidence: { tip: grant, ancestry: [grant], deletions: [] },
        },
        product: snapshot(event),
        occurrenceAssignment: snapshot(assignment),
        mode: "organizer_handoff",
        assignment: "Pickup Desk",
      },
    })),
    subtotal: 0,
    currency: "SATS",
    shippingCostSats: 0,
    createdAt: (createdAt + 1) * 1_000,
  })
  const originalOrderWraps = signedBuyerOrder(order, createdAt + 1)
  expect(originalOrderWraps).toHaveLength(2)
  expect(originalOrderWraps.every((event) => verifyEvent(event))).toBe(true)
  const originalOrders = uniquePrivatePublications(
    decryptPrivatePublications(
      originalOrderWraps.map((event) => ({ event, relayUrl: FIXTURE_RELAY })),
      MERCHANT_SECRET
    )
  ).filter((message) => rumorType(message.rumor) === "order")
  expect(originalOrders).toHaveLength(1)
  expect(JSON.parse(originalOrders[0]!.rumor.content)).toEqual(order)
  relay.seed(
    ...originalOrderWraps,
    signEvent(ORGANIZER_SECRET, {
      ...market,
      created_at: createdAt + 1,
      tags: [
        ...market.tags,
        ["prev", market.id],
        [
          "merchant",
          getPublicKey(generateSecretKey()),
          "merchant_present",
          "Other booth",
        ],
      ],
    })
  )
  await gotoAs(page, marketUrl, "/orders", "buyer", { order: order.id })
  expect(order.items.reduce((total, item) => total + item.quantity, 0)).toBe(3)
  expect(
    order.items.every((item) => item.fulfillment?.type !== "shipping")
  ).toBe(true)
  expect(order.shippingAddress).toBeUndefined()
  for (const item of order.items) {
    expect(item.fulfillment?.type).toBe("event_market_pickup")
    if (item.fulfillment?.type === "event_market_pickup") {
      expect(item.fulfillment.market.eventId).toBe(market.id)
      expect(
        sameSignedPublicEvent(item.fulfillment.market.signedEvent, market)
      ).toBe(true)
    }
  }
  expect(order.items).toHaveLength(2)
  expect(
    order.items.every(
      (item) =>
        item.fulfillment?.type === "event_market_pickup" &&
        !!item.fulfillment.occurrenceAssignment
    )
  ).toBe(true)
  expect(
    order.items.every(
      (item) => item.fulfillment?.type === "event_market_pickup"
    )
  ).toBe(true)
  const firstPickup = order.items[0]?.fulfillment
  expect(
    firstPickup?.type === "event_market_pickup" &&
      firstPickup.market.coordinate === eventCoordinate(market)
  ).toBe(true)
  const buyerPickup = page.getByTestId("future-market-order-pickup")
  await expect(buyerPickup).toBeVisible()
  await expect(buyerPickup.getByText("Pickup Desk")).toBeVisible()

  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  await expect(
    page.getByText(/Mark 1 × Future handoff candle sold/)
  ).toBeVisible()
  await expect(
    page.getByText(/Mark 2 × Future handoff soap sold/)
  ).toBeVisible()
  await page.getByRole("button", { name: "Accept order", exact: true }).click()
  await expect(
    page.getByRole("alert").filter({
      hasText: /This order needs its delegated fulfillment workflow/,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Accept order", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText(/Accepted inventory is saved on this device/)
  ).toHaveCount(0)
  await test.step("historical signed acceptance precedes the handoff replay", async () => {
    relay.seed(...signedHistoricalAcceptedStatus(order.id))
    await page.reload()
    await expect(
      page.getByRole("button", { name: "Accept order", exact: true })
    ).toHaveCount(0)
  })
  const merchantRelease = page.getByTestId("merchant-future-organizer-handoff")
  await expect(merchantRelease).toBeVisible()
  const prepareRelease = merchantRelease.getByRole("button", {
    name: "Prepare organizer release",
  })
  await expect(prepareRelease).toBeEnabled()
  await prepareRelease.click()
  const releaseDialog = page.getByRole("alertdialog", {
    name: "Confirm organizer release",
  })
  await releaseDialog
    .getByRole("checkbox", {
      name: /I confirm payment is settled or nothing is owed/i,
    })
    .check()
  const releaseStart = relay.publications.length
  await releaseDialog
    .getByRole("button", { name: "Authorize organizer release" })
    .click()
  const readyMessages = () =>
    uniquePrivatePublications(
      decryptPrivatePublications(
        relay.publications,
        ORGANIZER_SECRET,
        releaseStart
      )
    ).filter((message) => rumorType(message.rumor) === "future_market_ready")
  await expect.poll(() => readyMessages().length).toBe(1)
  const readyPayload = JSON.parse(
    readyMessages()[0]!.rumor.content
  ) as FutureMarketReadyReceiptSchema
  for (const item of readyPayload.items) {
    if (item.product.signedEvent) {
      item.product.signedEvent = await admitFixtureEvent(
        item.product.signedEvent
      )
    }
  }
  expect(readyPayload.items).toHaveLength(2)
  expect(
    resolveFutureMarketReceiptMerchandiseEvidence({
      receipt: readyPayload,
      events: [],
      coverage: {
        attemptedRelayCount: 0,
        completeRelayCount: 0,
        partialRelayCount: 0,
        failedRelayCount: 0,
      },
    }).items.map((item) => item.state)
  ).toEqual(["verified", "verified"])
  const serializedReady = JSON.stringify(readyPayload)
  for (const forbidden of [
    order.id,
    BUYER_PUBKEY,
    "invoice",
    "preimage",
    "shippingAddress",
  ]) {
    expect(serializedReady).not.toContain(forbidden)
  }
  const pickupCode = formatPickupClaimCode(readyPayload.claimRef)

  expect(
    readyPayload.items.find(
      (item) => item.product.coordinate === eventCoordinate(soap)
    )?.product.signedEvent?.id
  ).toBe(soap.id)
  await expect(
    merchantRelease.getByText("Release authorized", { exact: true })
  ).toBeVisible()
  const originalReleaseWrapIds = uniquePublishedEvents(
    relay.publications.slice(releaseStart)
  )
    .filter(
      (event) =>
        event.kind === 1059 &&
        event.tags.some(
          (tag) =>
            tag[0] === "p" &&
            (tag[1] === ORGANIZER_PUBKEY || tag[1] === MERCHANT_PUBKEY)
        )
    )
    .map((event) => event.id)
    .sort()
  expect(originalReleaseWrapIds).toHaveLength(2)

  await page.evaluate(
    (unavailableKey) => localStorage.setItem(unavailableKey, "1"),
    SYNTHETIC_SIGNER_UNAVAILABLE_KEY
  )
  await page.reload()
  const savedRelease = page.getByTestId("merchant-future-organizer-handoff")
  const retryExactReceipt = savedRelease.getByRole("button", {
    name: "Retry exact receipt",
  })
  await expect(retryExactReceipt).toBeEnabled()
  await expect(
    savedRelease.getByRole("button", { name: "Revoke release", exact: true })
  ).toBeDisabled()
  await page.evaluate((ownerPubkey) => {
    const pendingKey = `conduit:future-market-handoff-delivery:v2:${ownerPubkey}`
    const pending = JSON.parse(
      localStorage.getItem(pendingKey) ?? "[]"
    ) as Array<{
      type: string
      signedRecipientWrap: { sig: string }
    }>
    const archivePrefix = `conduit:future-market-handoff-delivery:v2:archive:${ownerPubkey}`
    const archivedIds = JSON.parse(
      localStorage.getItem(archivePrefix) ?? "[]"
    ) as string[]
    const key = pending.some((record) => record.type === "future_market_ready")
      ? pendingKey
      : archivedIds.length === 1
        ? `${archivePrefix}:${archivedIds[0]}`
        : null
    if (!key) throw new Error("Expected one saved exact release record.")
    const original = localStorage.getItem(key)
    if (!original) throw new Error("Saved exact release record is unavailable.")
    sessionStorage.setItem("conduit:e2e:saved-release-key", key)
    sessionStorage.setItem("conduit:e2e:saved-release-original", original)
    const value = JSON.parse(original) as
      typeof pending | { type: string; signedRecipientWrap: { sig: string } }
    const record = Array.isArray(value)
      ? value.find((candidate) => candidate.type === "future_market_ready")
      : value
    if (!record) throw new Error("Saved exact release record is unavailable.")
    record.signedRecipientWrap.sig = "0".repeat(128)
    localStorage.setItem(key, JSON.stringify(value))
  }, MERCHANT_PUBKEY)
  const rejectedReplayStart = relay.publications.length
  await retryExactReceipt.click()
  await expect(
    savedRelease.getByText(
      "Future Event Market exact delivery wraps are invalid."
    )
  ).toBeVisible()
  expect(relay.publications).toHaveLength(rejectedReplayStart)
  await page.evaluate(() => {
    const key = sessionStorage.getItem("conduit:e2e:saved-release-key")
    const original = sessionStorage.getItem(
      "conduit:e2e:saved-release-original"
    )
    if (!key || !original)
      throw new Error("Saved exact release test record is unavailable.")
    localStorage.setItem(key, original)
    sessionStorage.removeItem("conduit:e2e:saved-release-key")
    sessionStorage.removeItem("conduit:e2e:saved-release-original")
  })
  const replayStart = relay.publications.length
  await retryExactReceipt.click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications.slice(replayStart)).filter(
          (event) => originalReleaseWrapIds.includes(event.id)
        ).length
    )
    .toBe(2)
  expect(
    uniquePublishedEvents(relay.publications.slice(replayStart))
      .filter((event) => originalReleaseWrapIds.includes(event.id))
      .map((event) => event.id)
      .sort()
  ).toEqual(originalReleaseWrapIds)
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __conduitSyntheticSignAttempts?: number
          }
        ).__conduitSyntheticSignAttempts ?? 0
    )
  ).toBe(0)
  await page.evaluate(
    (unavailableKey) => localStorage.removeItem(unavailableKey),
    SYNTHETIC_SIGNER_UNAVAILABLE_KEY
  )
  relay.remove(soap)
  relay.seed(
    signEvent(MERCHANT_SECRET, {
      kind: 30402,
      created_at: soap.created_at + 1,
      content: "Updated listing after the paid order",
      tags: soap.tags.map((tag) =>
        tag[0] === "title" ? ["title", "Updated soap listing"] : tag
      ),
    })
  )
  // Paid handoff keeps its original organizer approval even after public
  // closure, revocation and pruning. The private merchant release is current.
  const originalMarket = readyPayload.authorityEvidence.find(
    (event) => event.kind === 30409
  )!
  const originalGrant = readyPayload.authorityEvidence.find(
    (event) => event.kind === 3841
  )!
  expect(
    readyPayload.authorityEvidence.some((event) => event.kind === 31923)
  ).toBe(true)
  for (const event of readyPayload.authorityEvidence) relay.remove(event)
  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      kind: 30409,
      created_at: createdAt + 2,
      content: "",
      tags: [
        ...originalMarket.tags.filter(
          (tag) => !["prev", "merchant", "event_market"].includes(tag[0]!)
        ),
        ["event_market", "2", "closed"],
        ["prev", originalMarket.id],
      ],
    }),
    signEvent(ORGANIZER_SECRET, {
      kind: 3841,
      created_at: createdAt + 2,
      content: "",
      tags: [
        ...originalGrant.tags.filter(
          (tag) => !["state", "seq", "auth_parent"].includes(tag[0]!)
        ),
        ["state", "revoked"],
        ["seq", "1"],
        ["auth_parent", originalGrant.id],
      ],
    })
  )
  const beforeOrganizer = relay.requests.length
  await gotoAs(page, merchantUrl, `/events/${marketNaddr}`, "organizer")
  await expect(
    page.getByRole("heading", { name: "Pickup handoffs" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Refresh pickup claims" }).click()
  await expect
    .poll(() =>
      relay.requests.some((request) =>
        request.matchedEventIds.includes(readyMessages()[0]!.wrap.id)
      )
    )
    .toBe(true)
  await expect(page.getByText(`Pickup code ${pickupCode}`)).toBeVisible()
  const claimInput = page.getByLabel("Confirm buyer pickup code")
  await claimInput.fill(pickupCode)
  // The receipt carries the original signed revision, so a relay can prune it
  // after an ordinary listing edit without blocking the already-paid pickup.
  const claimItems = page.getByRole("list", {
    name: "Items for this pickup claim",
  })
  await expect(
    claimItems.getByText("Future handoff soap", { exact: true })
  ).toBeVisible()
  await expect(
    claimItems.getByText("Future handoff candle", { exact: true })
  ).toBeVisible()
  await expect(claimItems.getByText("Qty 2", { exact: true })).toBeVisible()
  await expect(
    claimItems.getByText("Updated soap listing", { exact: true })
  ).toHaveCount(0)
  expect(
    relay.requests
      .slice(beforeOrganizer)
      .some((request) =>
        request.filters.some((filter) => filter.ids?.includes(soap.id))
      )
  ).toBe(false)
  await expect(claimItems.getByText("Qty 1", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Mark handed out" })
  ).toBeEnabled()
  const originalApprovalIds = new Set(
    readyPayload.authorityEvidence.map((event) => event.id)
  )
  expect(
    relay.requests
      .slice(beforeOrganizer)
      .some((request) =>
        request.filters.some((filter) =>
          filter.ids?.some((id) => originalApprovalIds.has(id))
        )
      )
  ).toBe(false)
  relay.rejectKind(1059, true)
  const ackStart = relay.publications.length
  await page.getByRole("button", { name: "Mark handed out" }).click()
  await expect(
    page.getByRole("button", { name: "Retry exact handed-out update" })
  ).toBeEnabled()
  const originalAckIds = await page.evaluate((owner) => {
    const records = JSON.parse(
      localStorage.getItem(
        `conduit:future-market-handoff-delivery:v2:${owner}`
      ) ?? "[]"
    ) as Array<{
      type: string
      signedRecipientWrap: { id: string }
      signedSelfWrap: { id: string }
    }>
    const saved = records.find(
      (record) => record.type === "future_market_handed_out"
    )
    if (!saved) throw new Error("Expected saved exact handoff update.")
    return [saved.signedRecipientWrap.id, saved.signedSelfWrap.id].sort()
  }, ORGANIZER_PUBKEY)
  expect(originalAckIds).toHaveLength(2)
  await page.evaluate(
    (key) => localStorage.setItem(key, "1"),
    SYNTHETIC_SIGNER_UNAVAILABLE_KEY
  )
  await page.reload()
  await expect(
    page.getByText(
      "Connect the organizer signer to read private pickup claims."
    )
  ).toBeVisible()
  const retrySavedAck = page.getByRole("button", {
    name: "Retry saved handoff update",
  })
  await expect(retrySavedAck).toBeEnabled()
  await expect(
    page.getByRole("button", { name: "Mark handed out" })
  ).toHaveCount(0)
  const wrongOwnerStart = relay.publications.length
  await gotoAs(page, merchantUrl, `/events/${marketNaddr}`, "merchant")
  await expect(retrySavedAck).toHaveCount(0)
  expect(relay.publications).toHaveLength(wrongOwnerStart)
  await gotoAs(page, merchantUrl, `/events/${marketNaddr}`, "organizer")
  await expect(retrySavedAck).toBeEnabled()
  await page.evaluate((owner) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.trim() === "Retry saved handoff update"
    )
    if (!button) throw new Error("Expected saved handoff retry control.")
    // Change storage at the action boundary, after the control is rendered.
    button.addEventListener(
      "pointerdown",
      () => {
        const key = `conduit:future-market-handoff-delivery:v2:${owner}`
        const original = localStorage.getItem(key)
        if (!original) throw new Error("Expected saved handoff update.")
        sessionStorage.setItem("conduit:e2e:saved-ack-original", original)
        const records = JSON.parse(original) as Array<{
          signedRecipientWrap: { sig: string }
        }>
        records[0]!.signedRecipientWrap.sig = "0".repeat(128)
        localStorage.setItem(key, JSON.stringify(records))
      },
      { once: true }
    )
  }, ORGANIZER_PUBKEY)
  const invalidAckStart = relay.publications.length
  await retrySavedAck.click()
  await expect(
    page.getByText("Future Event Market exact delivery wraps are invalid.")
  ).toBeVisible()
  expect(relay.publications).toHaveLength(invalidAckStart)
  await page.evaluate((owner) => {
    const original = sessionStorage.getItem("conduit:e2e:saved-ack-original")
    if (!original) throw new Error("Expected original saved handoff update.")
    localStorage.setItem(
      `conduit:future-market-handoff-delivery:v2:${owner}`,
      original
    )
    sessionStorage.removeItem("conduit:e2e:saved-ack-original")
  }, ORGANIZER_PUBKEY)
  await page.reload()
  await expect(retrySavedAck).toBeEnabled()
  relay.rejectKind(1059, false)
  const ackReplayStart = relay.publications.length
  await retrySavedAck.click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications.slice(ackReplayStart)).filter(
          (event) => originalAckIds.includes(event.id)
        ).length
    )
    .toBe(2)
  expect(
    uniquePublishedEvents(relay.publications.slice(ackReplayStart))
      .filter((event) => originalAckIds.includes(event.id))
      .map((event) => event.id)
      .sort()
  ).toEqual(originalAckIds)
  await expect(retrySavedAck).toHaveCount(0)
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __conduitSyntheticSignAttempts?: number
          }
        ).__conduitSyntheticSignAttempts ?? 0
    )
  ).toBe(0)
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    SYNTHETIC_SIGNER_UNAVAILABLE_KEY
  )
  const ackMessages = () =>
    uniquePrivatePublications(
      decryptPrivatePublications(relay.publications, MERCHANT_SECRET, ackStart)
    ).filter(
      (message) => rumorType(message.rumor) === "future_market_handed_out"
    )
  await expect.poll(() => ackMessages().length).toBe(1)
  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  await expect(
    page
      .getByTestId("merchant-future-organizer-handoff")
      .getByText("Organizer handed out")
  ).toBeVisible()
  const complete = page.getByRole("button", {
    name: "Mark picked up / complete",
    exact: true,
  })
  await expect(complete).toBeEnabled()
  const completionStart = relay.publications.length
  await complete.click()
  const completionMessages = () =>
    uniquePrivatePublications(
      decryptPrivatePublications(
        relay.publications,
        BUYER_SECRET,
        completionStart
      )
    ).filter(
      (message) =>
        rumorType(message.rumor) === "status_update" &&
        message.rumor.tags.some(
          (tag) => tag[0] === "status" && tag[1] === "complete"
        )
    )
  await expect.poll(() => completionMessages().length).toBe(1)
  // Recipient publication precedes optional self-copy work and local persistence.
  // Reload must verify the encrypted completion record, not an in-flight send.
  await expect
    .poll(() =>
      page.evaluate(
        async ({ root, principal, rumorId }) => {
          const { getCommerceInbox } = await import(`${root}/commerce-inbox.ts`)
          const owner = getCommerceInbox(principal)
          return (await owner.store.projections()).some(
            ({ projection }: { projection: InboxProjection }) =>
              projection.kind === "order" && projection.message.id === rumorId
          )
        },
        {
          root: browserSourceRoot("packages/core/src/protocol"),
          principal: MERCHANT_PUBKEY,
          rumorId: completionMessages()[0]!.rumor.id,
        }
      )
    )
    .toBe(true)
  await page.reload()
  await expect(
    page
      .getByRole("list", { name: "Order progress" })
      .getByText("Picked up", { exact: true })
  ).toBeVisible()
  await expect(complete).toHaveCount(0)
  expect(completionMessages()).toHaveLength(1)
})

test("organizer customizes repeating all-day dates and resumes exact series bytes after reload @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await page.getByLabel("Event title").fill("Custom Makers")
  await page.getByLabel("Description").fill("Two community event dates")
  await page.getByLabel("Location", { exact: true }).fill("Town Hall")
  await page.getByRole("checkbox", { name: "All day", exact: true }).check()
  await page.getByLabel("Start", { exact: true }).fill("2030-06-01")
  await page.getByRole("combobox", { name: "Repeat", exact: true }).click()
  await page.getByRole("option", { name: "Weekly", exact: true }).click()
  await page.getByLabel("Number of dates").fill("2")
  await page
    .getByRole("button", { name: "Edit individual dates", exact: true })
    .click()
  await page.getByLabel("Start", { exact: true }).nth(1).fill("2030-06-09")
  await expect(page.getByLabel("End", { exact: true }).nth(1)).toHaveValue(
    "2030-06-09"
  )
  relay.rejectKind(31922, true)
  await page.getByRole("button", { name: "Publish event", exact: true }).click()
  const resume = page.getByRole("button", {
    name: "Resume publishing",
    exact: true,
  })
  await expect(resume).toBeEnabled()
  const saved = uniquePublishedEvents(relay.publications).find(
    (event) => event.kind === 31922
  )!
  await page.reload()
  await expect(page.getByLabel("End", { exact: true }).nth(0)).toHaveValue(
    "2030-06-01"
  )
  await expect(page.getByLabel("End", { exact: true }).nth(1)).toHaveValue(
    "2030-06-09"
  )
  relay.rejectKind(31922, false)
  await resume.click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  const calendars = uniquePublishedEvents(relay.publications).filter(
    (event) => event.kind === 31922
  )
  expect(
    calendars.map((event) => event.tags.find((tag) => tag[0] === "end")?.[1])
  ).toEqual(["2030-06-02", "2030-06-10"])
  const retries = relay.publications.filter(
    ({ event }) => event.id === saved.id
  )
  expect(retries.length).toBeGreaterThan(1)
  for (const { event } of retries)
    expect(JSON.stringify(event)).toBe(JSON.stringify(saved))
})

test("event banner supports choosing a file, previewing, replacing and removing it @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const mediaServer = "https://media.conduit.market"
  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      kind: 10063,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["server", mediaServer]],
      content: "",
    })
  )
  const upload = await interceptBlossom(page, mediaServer)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  const banner = page.getByRole("group", {
    name: "Event banner (optional)",
    exact: true,
  })
  await expect(
    banner.getByRole("button", { name: "Add banner", exact: true })
  ).toBeEnabled()
  const chooser = page.waitForEvent("filechooser")
  await banner.getByRole("button", { name: "Add banner", exact: true }).click()
  await (await chooser).setFiles("apps/merchant/public/merchant-icon-192.png")
  await expect(
    banner.getByRole("img", { name: "Event banner preview" })
  ).toBeVisible()
  await expect(
    banner.getByRole("button", { name: "Replace banner", exact: true })
  ).toBeEnabled()
  expect(upload.putCount).toBeGreaterThan(0)
  expect(upload.canonicalAuthorizationCount).toBeGreaterThan(0)
  await banner
    .getByRole("button", { name: "Remove banner", exact: true })
    .click()
  await expect(banner.getByRole("img")).toHaveCount(0)
  await banner.getByRole("button", { name: "Add by URL", exact: true }).click()
  await banner
    .getByLabel("Banner URL", { exact: true })
    .fill("https://cdn.conduit.market/conduit-test/template-product.svg")
  await expect(banner.getByRole("img")).toBeVisible()
  await banner
    .getByRole("button", { name: "Remove banner", exact: true })
    .click()
  await expect(banner.getByLabel("Banner URL", { exact: true })).toHaveValue("")
})

test("merchant directory separates open collapsible My Events and All Events with a scoped empty state @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events", "organizer")
  const my = page.getByRole("region", { name: "My Events timeline" })
  const all = page.getByRole("region", { name: "All Events timeline" })
  await expect(my).toBeVisible()
  await expect(all).toBeVisible()
  await expect(
    all.getByRole("heading", { name: "No events found on your relays" })
  ).toBeVisible()
  await expect(
    page.getByText("Future Event Market", { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Retry", exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: /^My Events/ }).click()
  await expect(my).toBeHidden()
  await expect(all).toBeVisible()
  await page.getByRole("button", { name: /^My Events/ }).click()
  await my.getByRole("button", { name: "Selling At", exact: true }).click()
  await expect(
    my.getByRole("heading", { name: "You aren’t selling at any events" })
  ).toBeVisible()
  await page.getByRole("button", { name: /^All Events/ }).click()
  await expect(all).toBeHidden()
  await expect(my).toBeVisible()
  await page.getByRole("button", { name: "Create event", exact: true }).click()
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText("Create event")
  await expect(
    page.getByRole("button", { name: "Add banner", exact: true })
  ).toBeVisible()
  await expect(page.getByLabel("Choose event banner file")).toHaveAttribute(
    "type",
    "file"
  )
  await expect(page.getByLabel("Banner URL", { exact: true })).toHaveCount(0)
  await expect(
    page.getByText("Event messages ready", { exact: true })
  ).toHaveCount(0)
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Events", exact: true })
    .click()
  await expect(page).toHaveURL(/relation=selling/)
  await expect(
    page
      .getByRole("region", { name: "My Events timeline" })
      .getByRole("button", { name: "Selling At" })
  ).toHaveAttribute("aria-pressed", "true")
})

for (const failedSource of [
  "market discovery",
  "products",
  "all reads",
] as const)
  test(`merchant directory composes availability when ${failedSource} is unavailable @merchant`, async ({
    page,
  }) => {
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    relay.seed(
      createFollowList(
        "merchant",
        [ORGANIZER_PUBKEY],
        Math.floor(Date.now() / 1000) - 10
      )
    )
    if (failedSource === "market discovery") relay.rejectMarketDiscovery(true)
    if (failedSource === "products") relay.rejectReadKind(30402, true)
    if (failedSource === "all reads") relay.rejectReads(true)
    await gotoAs(page, merchantUrl, "/events", "merchant")
    const my = page.getByRole("region", { name: "My Events timeline" })
    const all = page.getByRole("region", { name: "All Events timeline" })
    const unavailable = failedSource === "all reads"
    await expect(
      my.getByRole("heading", {
        name: unavailable
          ? "Couldn’t connect to your relays"
          : "No organizing events found yet",
        exact: true,
      })
    ).toBeVisible()
    await expect(
      all.getByRole("heading", {
        name: unavailable
          ? "Couldn’t connect to your relays"
          : "No events found yet",
        exact: true,
      })
    ).toBeVisible()
    await my.getByRole("button", { name: "Selling At", exact: true }).click()
    await expect(
      my.getByRole("heading", {
        name: unavailable
          ? "Couldn’t connect to your relays"
          : "No selling events found yet",
        exact: true,
      })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Refresh Selling At", exact: true })
    ).toBeEnabled()
    await expect(
      page.getByRole("button", { name: "Refresh All Events", exact: true })
    ).toBeEnabled()
  })

test("merchant personal timeline scopes unavailable discovery with an unrelated product-linked event @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    kind: 31923,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "unrelated-fair"],
      ["title", "Unrelated Fair"],
      ["start", "1893456000"],
      ["D", "21915"],
    ],
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "unrelated-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
    ],
  })
  const template = createMerchantTemplateProductEvent(createdAt)
  const product = signEvent(MERCHANT_SECRET, {
    kind: template.kind,
    created_at: createdAt,
    content: template.content,
    tags: [...template.tags, ["a", eventCoordinate(market)]],
  })
  relay.seed(
    calendar,
    market,
    product,
    createFollowList("merchant", [ORGANIZER_PUBKEY], createdAt)
  )
  // The exact product-linked read succeeds; every broad market discovery fails.
  relay.rejectMarketDiscovery(true)
  await gotoAs(page, merchantUrl, "/events", "merchant")
  const my = page.getByRole("region", { name: "My Events timeline" })
  const all = page.getByRole("region", { name: "All Events timeline" })
  await expect(
    all.getByRole("button", { name: /^Open Unrelated Fair/ })
  ).toBeVisible()
  await expect(
    my.getByRole("heading", { name: "No organizing events found yet" })
  ).toBeVisible()
  await expect(
    my.getByRole("heading", { name: "You aren’t organizing any events" })
  ).toHaveCount(0)
  await my.getByRole("button", { name: "Selling At", exact: true }).click()
  await expect(
    my.getByRole("heading", { name: "No selling events found yet" })
  ).toBeVisible()
  await expect(
    my.getByRole("heading", { name: "You aren’t selling at any events" })
  ).toHaveCount(0)
  relay.rejectMarketDiscovery(false)
  await expect(
    page.getByRole("button", { name: "Refresh Selling At", exact: true })
  ).toBeEnabled()
  const beforeRefresh = relay.requests.length
  await page
    .getByRole("button", { name: "Refresh Selling At", exact: true })
    .click()
  for (const author of [MERCHANT_PUBKEY, ORGANIZER_PUBKEY])
    await expect
      .poll(() =>
        relay.requests
          .slice(beforeRefresh)
          .some((request) =>
            request.filters.some(
              (filter) =>
                filter.kinds?.includes(30409) &&
                filter.authors?.includes(author) &&
                !filter["#d"]
            )
          )
      )
      .toBe(true)
  await expect(
    my.getByRole("heading", { name: "You aren’t selling at any events" })
  ).toBeVisible()
  await expect(
    all.getByRole("button", { name: /^Open Unrelated Fair/ })
  ).toBeVisible()
})

test("merchant directory resolves Organizing and Selling At while calendar discovery is held at 390px @merchant", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  relay.seed(
    createFollowList(
      "merchant",
      [ORGANIZER_PUBKEY],
      Math.floor(Date.now() / 1000)
    )
  )
  const held = relay.holdRelayRequests((request) =>
    request.filters.some(
      (filter) =>
        filter.kinds?.includes(30409) &&
        filter.authors?.includes(ORGANIZER_PUBKEY)
    )
  )
  try {
    await gotoAs(page, merchantUrl, "/events", "merchant")
    await held.captured
    const my = page.getByRole("region", { name: "My Events timeline" })
    const all = page.getByRole("region", { name: "All Events timeline" })
    await expect(
      my.getByRole("heading", { name: "You aren’t organizing any events" })
    ).toBeVisible()
    await expect(
      all.getByRole("status", { name: "Loading events" })
    ).toBeVisible()
    const skeleton = await all
      .getByRole("status", { name: "Loading events" })
      .boundingBox()
    expect(skeleton!.height).toBeLessThanOrEqual(140)
    const organizing = page.getByRole("button", {
      name: "Refresh Organizing",
      exact: true,
    })
    await expect(organizing).toBeEnabled()
    await expect(
      page.getByRole("button", { name: "Refresh All Events", exact: true })
    ).toBeDisabled()
    const heading = await page
      .getByRole("heading", { name: /^My Events/ })
      .boundingBox()
    const refresh = await organizing.boundingBox()
    expect(Math.abs(heading!.y - refresh!.y)).toBeLessThan(12)
    const empty = await my
      .getByRole("heading", { name: "You aren’t organizing any events" })
      .locator("../..")
      .boundingBox()
    expect(empty!.height).toBeLessThanOrEqual(160)
    await expect(
      page.getByText("Some relay checks did not finish.")
    ).toHaveCount(0)
    // Capture only the empty directory, excluding account controls and protocol fixtures.
    await page
      .getByRole("heading", { name: "Events", exact: true })
      .locator("../../..")
      .screenshot({
        path: test.info().outputPath("events-mobile-390.png"),
      })
    const beforeOwnRefresh = relay.requests.length
    await organizing.click()
    await expect
      .poll(() => relay.requests.length)
      .toBeGreaterThan(beforeOwnRefresh)
    await expect(organizing).toBeEnabled()
    const ownRequests = relay.requests.slice(beforeOwnRefresh)
    expect(
      ownRequests.some((request) =>
        request.filters.some(
          (filter) =>
            filter.kinds?.includes(30409) &&
            filter.authors?.includes(MERCHANT_PUBKEY)
        )
      )
    ).toBe(true)
    expect(
      ownRequests.some((request) =>
        request.filters.some((filter) => filter.kinds?.includes(3))
      )
    ).toBe(false)
    expect(
      ownRequests.some((request) =>
        request.filters.some((filter) => filter.kinds?.includes(30402))
      )
    ).toBe(true)
    await my.getByRole("button", { name: "Selling At", exact: true }).click()
    await expect(
      my.getByRole("heading", { name: "No selling events found yet" })
    ).toBeVisible()
    const selling = page.getByRole("button", {
      name: "Refresh Selling At",
      exact: true,
    })
    await expect(selling).toBeEnabled()
    const beforeSellingRefresh = relay.requests.length
    await selling.click()
    await expect
      .poll(() => relay.requests.length)
      .toBeGreaterThan(beforeSellingRefresh)
    await expect(selling).toBeEnabled()
    const sellingRequests = relay.requests.slice(beforeSellingRefresh)
    expect(
      sellingRequests.some((request) =>
        request.filters.some((filter) => filter.kinds?.includes(30402))
      )
    ).toBe(true)
    expect(
      sellingRequests.some((request) =>
        request.filters.some((filter) => filter.kinds?.includes(3))
      )
    ).toBe(true)
    expect(
      sellingRequests.some((request) =>
        request.filters.some(
          (filter) =>
            filter.kinds?.includes(30409) &&
            filter.authors?.includes(MERCHANT_PUBKEY)
        )
      )
    ).toBe(true)
    // The already-running organizer read is neither restarted nor awaited.
    expect(
      sellingRequests.some((request) =>
        request.filters.some(
          (filter) =>
            filter.kinds?.includes(30409) &&
            filter.authors?.includes(ORGANIZER_PUBKEY)
        )
      )
    ).toBe(false)
  } finally {
    held.release()
  }
})

test("merchant directory All Events resolves and refreshes without waiting for merchant products @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const held = relay.holdRelayRequests((request) =>
    request.filters.some(
      (filter) =>
        filter.kinds?.includes(30402) &&
        filter.authors?.includes(MERCHANT_PUBKEY)
    )
  )
  try {
    await gotoAs(page, merchantUrl, "/events", "merchant")
    await held.captured
    const my = page.getByRole("region", { name: "My Events timeline" })
    const all = page.getByRole("region", { name: "All Events timeline" })
    await expect(
      my.getByRole("heading", { name: "No organizing events found yet" })
    ).toBeVisible()
    await expect(
      all.getByRole("heading", { name: "No events found yet" })
    ).toBeVisible()
    await my.getByRole("button", { name: "Selling At", exact: true }).click()
    await expect(
      my.getByRole("status", { name: "Loading events" })
    ).toBeVisible()
    const refresh = page.getByRole("button", {
      name: "Refresh All Events",
      exact: true,
    })
    await expect(refresh).toBeEnabled()
    const before = relay.requests.length
    await refresh.click()
    await expect(refresh).toBeEnabled()
    expect(
      relay.requests
        .slice(before)
        .some((request) =>
          request.filters.some((filter) => filter.kinds?.includes(30402))
        )
    ).toBe(false)
    held.release()
    await expect(
      all.getByRole("heading", { name: "No events found on your relays" })
    ).toBeVisible()
  } finally {
    held.release()
  }
})

for (const failure of ["held", "unavailable"] as const)
  test(`merchant directory Organizing preserves exact product-linked evidence while owner discovery is ${failure} @merchant`, async ({
    page,
  }) => {
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    const createdAt = Math.floor(Date.now() / 1000) - 10
    const calendar = signEvent(ORGANIZER_SECRET, {
      kind: 31923,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", "owned-linked-fair"],
        ["title", "Owned Linked Fair"],
        ["start", "1893456000"],
        ["D", "21915"],
      ],
    })
    const market = signEvent(ORGANIZER_SECRET, {
      kind: 30409,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", "owned-linked-fair"],
        ["a", eventCoordinate(calendar)],
        ["event_market", "2", "open"],
      ],
    })
    const template = createMerchantTemplateProductEvent(createdAt)
    const product = signEvent(ORGANIZER_SECRET, {
      kind: template.kind,
      created_at: createdAt,
      content: template.content,
      tags: [...template.tags, ["a", eventCoordinate(market)]],
    })
    relay.seed(calendar, market, product)
    const held =
      failure === "held"
        ? relay.holdRelayRequests((request) =>
            request.filters.some(
              (filter) =>
                filter.kinds?.includes(30409) &&
                filter.authors?.includes(ORGANIZER_PUBKEY) &&
                !filter["#d"]
            )
          )
        : null
    if (failure === "unavailable") relay.rejectMarketDiscovery(true)
    try {
      await gotoAs(page, merchantUrl, "/events", "organizer")
      if (held) await held.captured
      const my = page.getByRole("region", { name: "My Events timeline" })
      await expect(
        my.getByRole("button", { name: /^Open Owned Linked Fair/ })
      ).toBeVisible()
      await expect(
        my.getByRole("status", { name: "Loading events" })
      ).toHaveCount(0)
      await expect(
        my.getByRole("heading", { name: "Couldn’t connect to your relays" })
      ).toHaveCount(0)
      if (held)
        await expect(
          page.getByRole("button", { name: "Refresh Organizing", exact: true })
        ).toBeDisabled()
    } finally {
      held?.release()
    }
  })

test("merchant directory All Events keeps failed product discovery explicitly incomplete @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  relay.rejectReadKind(30402, true)
  await gotoAs(page, merchantUrl, "/events", "merchant")
  const my = page.getByRole("region", { name: "My Events timeline" })
  const all = page.getByRole("region", { name: "All Events timeline" })
  await my.getByRole("button", { name: "Selling At", exact: true }).click()
  await expect(
    my.getByRole("heading", { name: "No selling events found yet" })
  ).toBeVisible()
  await expect(
    all.getByRole("heading", { name: "No events found yet" })
  ).toBeVisible()
  await expect(
    all.getByRole("heading", { name: "No events found on your relays" })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Refresh All Events", exact: true })
  ).toBeEnabled()
  relay.rejectReadKind(30402, false)
  const beforeRefresh = relay.requests.length
  await page
    .getByRole("button", { name: "Refresh All Events", exact: true })
    .click()
  await expect
    .poll(() =>
      relay.requests
        .slice(beforeRefresh)
        .some((request) =>
          request.filters.some((filter) => filter.kinds?.includes(30402))
        )
    )
    .toBe(true)
  await expect(
    all.getByRole("heading", { name: "No events found on your relays" })
  ).toBeVisible()
})

test("merchant directory Selling At isolates cached refresh results across delimiter-colliding coordinate sets @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const createMarket = (dTag: string, title: string) => {
    const calendar = signEvent(ORGANIZER_SECRET, {
      kind: 31923,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", dTag],
        ["title", title],
        ["start", "1893456000"],
        ["D", "21915"],
      ],
    })
    const market = signEvent(ORGANIZER_SECRET, {
      kind: 30409,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", dTag],
        ["a", eventCoordinate(calendar)],
        ["event_market", "2", "open"],
        ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 1"],
      ],
    })
    relay.seed(calendar, market)
    return market
  }
  const first = createMarket("a", "First Fair")
  const second = createMarket("b", "Second Fair")
  const combined = createMarket(`a,${eventCoordinate(second)}`, "Combined Fair")
  expect(
    [eventCoordinate(first), eventCoordinate(second)].sort().join(",") ===
      eventCoordinate(combined)
  ).toBe(true)
  const template = createMerchantTemplateProductEvent(createdAt)
  const product = signEvent(MERCHANT_SECRET, {
    kind: template.kind,
    created_at: createdAt,
    content: template.content,
    tags: [
      ...template.tags,
      ["a", eventCoordinate(first)],
      ["a", eventCoordinate(second)],
    ],
  })
  relay.seed(product)
  relay.rejectMarketDiscovery(true)
  await gotoAs(page, merchantUrl, "/events?relation=selling", "merchant")
  const my = page.getByRole("region", { name: "My Events timeline" })
  await expect(
    my.getByRole("button", { name: /^Open First Fair/ })
  ).toBeVisible()
  await expect(
    my.getByRole("button", { name: /^Open Second Fair/ })
  ).toBeVisible()
  const refresh = page.getByRole("button", {
    name: "Refresh Selling At",
    exact: true,
  })
  const beforeRefresh = relay.requests.length
  await refresh.click()
  await expect
    .poll(() =>
      relay.requests
        .slice(beforeRefresh)
        .some((request) =>
          request.filters.some(
            (filter) => filter.kinds?.includes(30409) && filter["#d"]
          )
        )
    )
    .toBe(true)
  await expect(refresh).toBeEnabled()
  relay.remove(product)
  relay.seed(
    signEvent(MERCHANT_SECRET, {
      kind: template.kind,
      created_at: createdAt + 1,
      content: template.content,
      tags: [...template.tags, ["a", eventCoordinate(combined)]],
    })
  )
  await refresh.click()
  await expect(
    my.getByRole("button", { name: /^Open Combined Fair/ })
  ).toBeVisible()
  await expect(refresh).toBeEnabled()
  await expect(
    my.getByRole("button", { name: /^Open First Fair/ })
  ).toHaveCount(0)
  await expect(
    my.getByRole("button", { name: /^Open Second Fair/ })
  ).toHaveCount(0)
})

test("merchant directory Selling At retries failed perspective discovery from its own Refresh @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  relay.rejectReadKind(3, true)
  await gotoAs(page, merchantUrl, "/events?relation=selling", "merchant")
  const my = page.getByRole("region", { name: "My Events timeline" })
  await expect(
    my.getByRole("heading", { name: "No selling events found yet" })
  ).toBeVisible()
  // All Events settling confirms perspective lookup has completed its failed attempt.
  await expect(
    page
      .getByRole("region", { name: "All Events timeline" })
      .getByRole("heading", { name: "No events found yet" })
  ).toBeVisible()
  relay.rejectReadKind(3, false)
  const beforeRefresh = relay.requests.length
  await page
    .getByRole("button", { name: "Refresh Selling At", exact: true })
    .click()
  await expect
    .poll(() =>
      relay.requests
        .slice(beforeRefresh)
        .some((request) =>
          request.filters.some((filter) => filter.kinds?.includes(3))
        )
    )
    .toBe(true)
  await expect(
    my.getByRole("heading", { name: "You aren’t selling at any events" })
  ).toBeVisible()
})

test("merchant directory All Events retries failed exact relationship reads from its own Refresh @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    kind: 31923,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "recover-exact-fair"],
      ["title", "Recovered Exact Fair"],
      ["start", "1893456000"],
      ["D", "21915"],
    ],
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "recover-exact-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
    ],
  })
  const template = createMerchantTemplateProductEvent(createdAt)
  relay.seed(
    calendar,
    market,
    signEvent(MERCHANT_SECRET, {
      kind: template.kind,
      created_at: createdAt,
      content: template.content,
      tags: [...template.tags, ["a", eventCoordinate(market)]],
    })
  )
  relay.rejectExactMarkets(true)
  await gotoAs(page, merchantUrl, "/events?relation=selling", "merchant")
  const my = page.getByRole("region", { name: "My Events timeline" })
  const all = page.getByRole("region", { name: "All Events timeline" })
  await expect(
    my.getByRole("heading", { name: "No selling events found yet" })
  ).toBeVisible()
  await expect(
    all.getByRole("heading", { name: "No events found yet" })
  ).toBeVisible()
  relay.rejectExactMarkets(false)
  const beforeRefresh = relay.requests.length
  await page
    .getByRole("button", { name: "Refresh All Events", exact: true })
    .click()
  await expect
    .poll(() =>
      relay.requests
        .slice(beforeRefresh)
        .some((request) =>
          request.filters.some(
            (filter) => filter.kinds?.includes(30409) && filter["#d"]
          )
        )
    )
    .toBe(true)
  await expect(
    all.getByRole("button", { name: /^Open Recovered Exact Fair/ })
  ).toBeVisible()
})

test("merchant directory All Events retries known roster refreshes after exact-read failures @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    kind: 31923,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "known-retry-fair"],
      ["title", "Known Retry Fair"],
      ["start", "1893456000"],
      ["D", "21915"],
    ],
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "known-retry-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 1"],
    ],
  })
  const template = createMerchantTemplateProductEvent(createdAt)
  relay.seed(
    calendar,
    market,
    signEvent(MERCHANT_SECRET, {
      kind: template.kind,
      created_at: createdAt,
      content: template.content,
      tags: [...template.tags, ["a", eventCoordinate(market)]],
    })
  )
  await gotoAs(page, merchantUrl, "/events?relation=selling", "merchant")
  const my = page.getByRole("region", { name: "My Events timeline" })
  const all = page.getByRole("region", { name: "All Events timeline" })
  await expect(
    my.getByRole("button", { name: /^Open Known Retry Fair/ })
  ).toBeVisible()
  relay.rejectExactMarkets(true)
  const sellingRefresh = page.getByRole("button", {
    name: "Refresh Selling At",
    exact: true,
  })
  const beforeFailedRefresh = relay.requests.length
  await sellingRefresh.click()
  await expect
    .poll(
      () =>
        relay.requests
          .slice(beforeFailedRefresh)
          .filter((request) =>
            request.filters.some(
              (filter) =>
                filter.kinds?.includes(30409) &&
                (filter["#d"] as string[] | undefined)?.includes(
                  "known-retry-fair"
                )
            )
          ).length
    )
    .toBeGreaterThanOrEqual(2)
  await expect(sellingRefresh).toBeEnabled()
  relay.rejectExactMarkets(false)
  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      kind: calendar.kind,
      created_at: createdAt + 1,
      content: calendar.content,
      tags: calendar.tags.map((tag) =>
        tag[0] === "title" ? ["title", "Recovered Known Fair"] : tag
      ),
    })
  )
  const beforeRefresh = relay.requests.length
  await page
    .getByRole("button", { name: "Refresh All Events", exact: true })
    .click()
  // Retry the product-linked query and the separately cached known-roster query.
  await expect
    .poll(
      () =>
        relay.requests
          .slice(beforeRefresh)
          .filter((request) =>
            request.filters.some(
              (filter) =>
                filter.kinds?.includes(30409) &&
                (filter["#d"] as string[] | undefined)?.includes(
                  "known-retry-fair"
                )
            )
          ).length
    )
    .toBeGreaterThanOrEqual(2)
  await expect(
    all.getByRole("button", { name: /^Open Recovered Known Fair/ })
  ).toBeVisible()
  await expect(
    all.getByRole("button", { name: /^Open Known Retry Fair/ })
  ).toHaveCount(0)
})

function createTimelineRefreshFixture(owned = false) {
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const secret = owned ? MERCHANT_SECRET : ORGANIZER_SECRET
  const calendar = signEvent(secret, {
    kind: 31923,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "healthy-refresh-fair"],
      ["title", "Healthy Refresh Fair"],
      ["start", "1893456000"],
      ["D", "21915"],
    ],
  })
  const market = signEvent(secret, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "healthy-refresh-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 1"],
    ],
  })
  const template = createMerchantTemplateProductEvent(createdAt)
  const product = signEvent(MERCHANT_SECRET, {
    kind: template.kind,
    created_at: createdAt,
    content: template.content,
    tags: [...template.tags, ["a", eventCoordinate(market)]],
  })
  return { calendar, market, product, createdAt }
}

test("merchant directory Selling At retains a refreshed membership removal when another coordinate appears @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await page.clock.install()
  const { calendar, market, product, createdAt } =
    createTimelineRefreshFixture()
  relay.seed(
    calendar,
    market,
    createFollowList("merchant", [ORGANIZER_PUBKEY], createdAt)
  )
  await gotoAs(page, merchantUrl, "/events?relation=selling", "merchant")
  const my = page.getByRole("region", { name: "My Events timeline" })
  const all = page.getByRole("region", { name: "All Events timeline" })
  const removedEvent = my.getByRole("button", {
    name: /^Open Healthy Refresh Fair/,
  })
  await expect(removedEvent).toBeVisible()
  let calendarHeld = false
  const held = relay.holdRelayRequests((request) => {
    if (
      calendarHeld ||
      !request.filters.some(
        (filter) =>
          filter.kinds?.includes(31923) &&
          filter.authors?.includes(ORGANIZER_PUBKEY)
      )
    )
      return false
    calendarHeld = true
    return true
  })
  try {
    // Start the regular discovery refresh before the signed removal exists.
    // Its calendar read stays held; the disabled Selling At query does not poll.
    await page.clock.fastForward(60_000)
    await held.captured
    await expect(removedEvent).toBeVisible()
    relay.seed(
      signEvent(ORGANIZER_SECRET, {
        kind: market.kind,
        created_at: createdAt + 1,
        content: market.content,
        tags: market.tags.filter((tag) => tag[0] !== "merchant"),
      })
    )
    await page
      .getByRole("button", { name: "Refresh Selling At", exact: true })
      .click()
    // The exact refresh sees the signed removal while broad discovery stays stale.
    await expect(removedEvent).toHaveCount(0)
    const nextCalendar = signEvent(ORGANIZER_SECRET, {
      kind: calendar.kind,
      created_at: createdAt + 1,
      content: calendar.content,
      tags: calendar.tags.map((tag) =>
        tag[0] === "d"
          ? ["d", "new-coordinate-fair"]
          : tag[0] === "title"
            ? ["title", "New Coordinate Fair"]
            : tag
      ),
    })
    const nextMarket = signEvent(ORGANIZER_SECRET, {
      kind: market.kind,
      created_at: createdAt + 1,
      content: market.content,
      tags: market.tags.map((tag) =>
        tag[0] === "d"
          ? ["d", "new-coordinate-fair"]
          : tag[0] === "a"
            ? ["a", eventCoordinate(nextCalendar)]
            : tag
      ),
    })
    relay.seed(
      nextCalendar,
      nextMarket,
      signEvent(MERCHANT_SECRET, {
        kind: product.kind,
        created_at: createdAt + 1,
        content: product.content,
        tags: product.tags.map((tag) =>
          tag[0] === "a" ? ["a", eventCoordinate(nextMarket)] : tag
        ),
      })
    )
    // Organizing can refresh the settled product source without restarting the held read.
    await my.getByRole("button", { name: "Organizing", exact: true }).click()
    await page
      .getByRole("button", { name: "Refresh Organizing", exact: true })
      .click()
    await expect(
      all.getByRole("button", { name: /^Open New Coordinate Fair/ })
    ).toBeVisible()
    await my.getByRole("button", { name: "Selling At", exact: true }).click()
    await expect(
      my.getByRole("button", { name: /^Open New Coordinate Fair/ })
    ).toBeVisible()
    await expect(removedEvent).toHaveCount(0)
  } finally {
    held.release()
  }
})

for (const newFollow of [false, true])
  test(`merchant directory Selling At refreshes healthy ${newFollow ? "perspective" : "roster discovery"} to find new membership @merchant`, async ({
    page,
  }) => {
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    const { calendar, market, createdAt } = createTimelineRefreshFixture()
    relay.seed(
      createFollowList(
        "merchant",
        newFollow ? [] : [ORGANIZER_PUBKEY],
        createdAt
      )
    )
    await gotoAs(page, merchantUrl, "/events?relation=selling", "merchant")
    const my = page.getByRole("region", { name: "My Events timeline" })
    const all = page.getByRole("region", { name: "All Events timeline" })
    await expect(
      all.getByRole("heading", { name: "No events found on your relays" })
    ).toBeVisible()
    await expect(
      my.getByRole("heading", { name: "You aren’t selling at any events" })
    ).toBeVisible()
    // Empty relationship rows can render before perspective discovery settles.
    // This scenario refreshes healthy sources, so wait for all initial reads.
    await expect(
      page.getByRole("button", { name: "Refresh All Events", exact: true })
    ).toBeEnabled()
    relay.seed(calendar, market)
    if (newFollow)
      relay.seed(
        createFollowList("merchant", [ORGANIZER_PUBKEY], createdAt + 1)
      )
    const before = relay.requests.length
    await page
      .getByRole("button", { name: "Refresh Selling At", exact: true })
      .click()
    await expect
      .poll(() =>
        relay.requests
          .slice(before)
          .some((request) =>
            request.filters.some(
              (filter) =>
                filter.kinds?.includes(newFollow ? 3 : 30409) &&
                filter.authors?.includes(
                  newFollow ? MERCHANT_PUBKEY : ORGANIZER_PUBKEY
                )
            )
          )
      )
      .toBe(true)
    await expect(
      my.getByRole("button", { name: /^Open Healthy Refresh Fair/ })
    ).toBeVisible()
    // Membership discovery does not require a product association.
    expect(relay.events().some((event) => event.kind === 30402)).toBe(false)
  })

test("merchant directory All Events refreshes healthy products to find an event outside the perspective graph @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const { calendar, market, product, createdAt } =
    createTimelineRefreshFixture()
  relay.seed(createFollowList("merchant", [], createdAt))
  await gotoAs(page, merchantUrl, "/events", "merchant")
  const all = page.getByRole("region", { name: "All Events timeline" })
  await expect(
    all.getByRole("heading", { name: "No events found on your relays" })
  ).toBeVisible()
  relay.seed(calendar, market, product)
  const before = relay.requests.length
  await page
    .getByRole("button", { name: "Refresh All Events", exact: true })
    .click()
  await expect
    .poll(() =>
      relay.requests
        .slice(before)
        .some((request) =>
          request.filters.some((filter) => filter.kinds?.includes(30402))
        )
    )
    .toBe(true)
  await expect(
    all.getByRole("button", { name: /^Open Healthy Refresh Fair/ })
  ).toBeVisible()
})

for (const ownerObservation of ["empty", "unavailable"] as const)
  test(`merchant directory Organizing refreshes healthy exact evidence while owner discovery remains ${ownerObservation} @merchant`, async ({
    page,
  }) => {
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    const { calendar, market, product, createdAt } =
      createTimelineRefreshFixture(true)
    relay.seed(
      calendar,
      market,
      product,
      createFollowList("merchant", [], createdAt)
    )
    if (ownerObservation === "unavailable") relay.rejectMarketDiscovery(true)
    else relay.omitMarketDiscovery(true)
    await gotoAs(page, merchantUrl, "/events", "merchant")
    const my = page.getByRole("region", { name: "My Events timeline" })
    await expect(
      my.getByRole("button", { name: /^Open Healthy Refresh Fair/ })
    ).toBeVisible()
    await my.getByRole("button", { name: "Selling At", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Refresh Selling At", exact: true })
    ).toBeEnabled()
    await my.getByRole("button", { name: "Organizing", exact: true }).click()
    relay.seed(
      signEvent(MERCHANT_SECRET, {
        kind: calendar.kind,
        created_at: createdAt + 1,
        content: calendar.content,
        tags: calendar.tags.map((tag) =>
          tag[0] === "title" ? ["title", "Updated Owned Fair"] : tag
        ),
      })
    )
    const before = relay.requests.length
    await page
      .getByRole("button", { name: "Refresh Organizing", exact: true })
      .click()
    await expect
      .poll(() =>
        relay.requests
          .slice(before)
          .some((request) =>
            request.filters.some((filter) => filter.kinds?.includes(30402))
          )
      )
      .toBe(true)
    await expect
      .poll(() =>
        relay.requests
          .slice(before)
          .some((request) =>
            request.filters.some(
              (filter) => filter.kinds?.includes(30409) && filter["#d"]
            )
          )
      )
      .toBe(true)
    await expect(
      my.getByRole("button", { name: /^Open Updated Owned Fair/ })
    ).toBeVisible()
  })

for (const failure of ["products-held", "exact-held", "unavailable"] as const)
  test(`merchant directory Organizing scopes empty owner discovery while an owned relationship is ${failure} @merchant`, async ({
    page,
  }) => {
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    const { calendar, market, product, createdAt } =
      createTimelineRefreshFixture(true)
    // The relay completes owner-wide discovery empty but retains the owned
    // event for exact reads, modeling different observations of the sources.
    relay.seed(
      calendar,
      market,
      product,
      createFollowList("merchant", [], createdAt)
    )
    relay.omitMarketDiscovery(true)
    const isExact = (filter: RelayFilter) =>
      filter.kinds?.includes(30409) && !!filter["#d"]
    const isHeld = (filter: RelayFilter) =>
      failure === "products-held"
        ? filter.kinds?.includes(30402)
        : isExact(filter)
    const held =
      failure !== "unavailable"
        ? relay.holdRelayRequests((request) => request.filters.some(isHeld))
        : null
    if (failure === "unavailable") relay.rejectExactMarkets(true)
    try {
      await gotoAs(page, merchantUrl, "/events", "merchant")
      if (held) await held.captured
      const my = page.getByRole("region", { name: "My Events timeline" })
      if (failure === "unavailable") {
        await my
          .getByRole("button", { name: "Selling At", exact: true })
          .click()
        await expect(
          my.getByRole("heading", { name: "No selling events found yet" })
        ).toBeVisible()
        await my
          .getByRole("button", { name: "Organizing", exact: true })
          .click()
      }
      const refresh = page.getByRole("button", {
        name: "Refresh Organizing",
        exact: true,
      })
      await expect(refresh).toBeEnabled()
      await expect
        .soft(
          my.getByRole("heading", { name: "No organizing events found yet" })
        )
        .toBeVisible()
      await expect
        .soft(
          my.getByRole("heading", { name: "You aren’t organizing any events" })
        )
        .toHaveCount(0)
      await expect(
        my.getByRole("status", { name: "Loading events" })
      ).toHaveCount(0)
      const before = relay.requests.length
      if (held) {
        // Refresh owns only the reads it starts; it must neither restart nor
        // wait for the already-running relationship source.
        await refresh.click()
        await expect(refresh).toBeEnabled()
        expect(
          relay.requests
            .slice(before)
            .some((request) => request.filters.some(isHeld))
        ).toBe(false)
        held.release()
      } else {
        relay.rejectExactMarkets(false)
        await refresh.click()
        await expect
          .poll(() =>
            relay.requests
              .slice(before)
              .some((request) => request.filters.some(isExact))
          )
          .toBe(true)
      }
      await expect(
        my.getByRole("button", { name: /^Open Healthy Refresh Fair/ })
      ).toBeVisible()
      await expect(refresh).toBeEnabled()
    } finally {
      held?.release()
    }
  })

test("merchant directory Organizing retries failed products from its own Refresh @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const { calendar, market, product, createdAt } =
    createTimelineRefreshFixture(true)
  relay.seed(
    calendar,
    market,
    product,
    createFollowList("merchant", [], createdAt)
  )
  relay.omitMarketDiscovery(true)
  relay.rejectReadKind(30402, true)
  await gotoAs(page, merchantUrl, "/events", "merchant")
  const my = page.getByRole("region", { name: "My Events timeline" })
  const refresh = page.getByRole("button", {
    name: "Refresh Organizing",
    exact: true,
  })
  await expect(
    my.getByRole("heading", { name: "No organizing events found yet" })
  ).toBeVisible()
  await expect(refresh).toBeEnabled()
  relay.rejectReadKind(30402, false)
  const before = relay.requests.length
  await refresh.click()
  await expect
    .poll(() =>
      relay.requests
        .slice(before)
        .some((request) =>
          request.filters.some((filter) => filter.kinds?.includes(30402))
        )
    )
    .toBe(true)
  await expect(
    my.getByRole("button", { name: /^Open Healthy Refresh Fair/ })
  ).toBeVisible()
  await expect(refresh).toBeEnabled()
})

test("merchant directory All Events refreshes settled products while an exact relationship read is already running @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const { calendar, market, product, createdAt } =
    createTimelineRefreshFixture()
  const owned = createTimelineRefreshFixture(true)
  relay.seed(
    calendar,
    market,
    product,
    owned.calendar,
    owned.market,
    createFollowList("merchant", [], createdAt)
  )
  // Exact relationships start only after product discovery has settled. The
  // separate owned event lets All Events resolve while this source stays held.
  const isHeldExact = (filter: RelayFilter) =>
    filter.kinds?.includes(30409) &&
    filter.authors?.includes(ORGANIZER_PUBKEY) &&
    !!filter["#d"]
  const held = relay.holdRelayRequests((request) =>
    request.filters.some(isHeldExact)
  )
  try {
    await gotoAs(page, merchantUrl, "/events?relation=selling", "merchant")
    await held.captured
    const all = page.getByRole("region", { name: "All Events timeline" })
    await expect(
      all.getByRole("button", { name: /^Open Healthy Refresh Fair/ })
    ).toBeVisible()
    const selling = page.getByRole("button", {
      name: "Refresh Selling At",
      exact: true,
    })
    const allRefresh = page.getByRole("button", {
      name: "Refresh All Events",
      exact: true,
    })
    await expect(selling).toBeDisabled()
    await expect(allRefresh).toBeEnabled()
    const before = relay.requests.length
    await allRefresh.click()
    await expect
      .poll(() =>
        relay.requests
          .slice(before)
          .some((request) =>
            request.filters.some((filter) => filter.kinds?.includes(30402))
          )
      )
      .toBe(true)
    await expect(allRefresh).toBeEnabled()
    expect(
      relay.requests
        .slice(before)
        .some((request) => request.filters.some(isHeldExact))
    ).toBe(false)
    // All Events finishes its own refresh without waiting for or restarting the exact read.
    await expect(selling).toBeDisabled()
    held.release()
    await expect(selling).toBeEnabled()
  } finally {
    held.release()
  }
})

for (const monthly of [false, true])
  test(`organizer publishes ${monthly ? "monthly" : "one-day"} all-day events with inclusive displayed ends @merchant`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    await gotoAs(page, merchantUrl, "/events/new", "organizer")
    await page
      .getByLabel("Event title")
      .fill(monthly ? "Monthly Makers" : "One Day Makers")
    await page.getByLabel("Description").fill("An all-day community event")
    await page.getByLabel("Location", { exact: true }).fill("Town Hall")
    await page.getByRole("checkbox", { name: "All day", exact: true }).check()
    await page.getByLabel("Start", { exact: true }).fill("2030-01-31")
    await expect(page.getByLabel("End", { exact: true })).toHaveValue(
      "2030-01-31"
    )
    if (monthly) {
      await page.getByRole("combobox", { name: "Repeat", exact: true }).click()
      await page.getByRole("option", { name: "Monthly", exact: true }).click()
      await page.getByLabel("Number of dates").fill("3")
      await expect(
        page
          .getByRole("list", { name: "Repeating dates preview" })
          .getByRole("listitem")
      ).toHaveText([
        "2030-01-31 · All day",
        "2030-03-31 · All day",
        "2030-05-31 · All day",
      ])
    }
    await page
      .getByRole("button", { name: "Publish event", exact: true })
      .click()
    await expect(page).toHaveURL(/\/events\/naddr1/)
    const calendars = uniquePublishedEvents(relay.publications).filter(
      (event) => event.kind === 31922
    )
    expect(
      calendars.map((event) => event.tags.find((tag) => tag[0] === "end")?.[1])
    ).toEqual(
      monthly ? ["2030-02-01", "2030-04-01", "2030-06-01"] : ["2030-02-01"]
    )
    await expect(
      page.locator(monthly ? "#series-edit-end" : "#future-edit-end")
    ).toHaveValue("2030-01-31")
    await page
      .locator(monthly ? "#series-edit-title" : "#future-edit-title")
      .fill(monthly ? "Monthly Makers January" : "One Day Makers updated")
    await page
      .getByRole("button", {
        name: monthly ? "Save selected date" : "Save event details",
        exact: true,
      })
      .click()
    await expect
      .poll(
        () =>
          uniquePublishedEvents(relay.publications).filter(
            (event) => event.kind === 31922
          ).length
      )
      .toBe(monthly ? 4 : 2)
    const updated = uniquePublishedEvents(relay.publications)
      .filter((event) => event.kind === 31922)
      .at(-1)!
    expect(updated.tags.find((tag) => tag[0] === "end")?.[1]).toBe("2030-02-01")
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" })
    ).toContainText(monthly ? "Monthly Makers" : "One Day Makers")
    await page.getByRole("link", { name: "Events", exact: true }).click()
    const my = page.getByRole("region", { name: "My Events timeline" })
    const all = page.getByRole("region", { name: "All Events timeline" })
    await expect(my.getByRole("button", { name: /^Open/ })).toHaveCount(
      monthly ? 3 : 1
    )
    await expect(all.getByRole("button", { name: /^Open/ })).toHaveCount(
      monthly ? 3 : 1
    )
  })

test("organizer creates and closes one future Event Market without legacy event records @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await page.getByLabel("Event title").fill("New Future Fair")
  await page.getByLabel("Description").fill("A future organizer market")
  await page.getByRole("button", { name: "Add by URL", exact: true }).click()
  await page
    .getByLabel("Banner URL")
    .fill("https://cdn.conduit.market/conduit-test/template-product.svg")
  await page.getByLabel("Location", { exact: true }).fill("Town Hall")
  await page.getByLabel("Start", { exact: true }).fill("2030-06-01T10:00")
  await page.getByLabel("End", { exact: true }).fill("2030-06-01T16:00")
  await page.getByRole("button", { name: "Publish event" }).click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  await expect(
    page.getByRole("heading", { name: "New Future Fair" })
  ).toBeVisible()
  const published = uniquePublishedEvents(relay.publications)
  expect(published.map((event) => event.kind)).toContain(31923)
  expect(published.map((event) => event.kind)).toContain(30409)
  expect(
    published.some((event) => event.kind === 30405 || event.kind === 30406)
  ).toBe(false)
  await page.getByRole("button", { name: "Close Event Market" }).click()
  await expect(
    page.getByText("Closed for new sales", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Reopen Event Market" }).click()
  await expect(page.getByText("Open for sales", { exact: true })).toBeVisible()
  relay.rejectKind(31923, true)
  await page.locator("#future-edit-title").fill("New Future Fair updated")
  await page.getByRole("button", { name: "Save event details" }).click()
  const retry = page.getByRole("button", { name: "Retry signed event details" })
  await expect(retry).toBeEnabled()
  const rejectedDate = uniquePublishedEvents(relay.publications)
    .filter((event) => event.kind === 31923)
    .at(-1)!
  await page.reload()
  await expect(retry).toBeEnabled()
  const retryStart = relay.publications.length
  relay.rejectKind(31923, false)
  await retry.click()
  await expect(retry).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Save event details" })
  ).toBeEnabled()
  const retries = relay.publications
    .slice(retryStart)
    .filter(({ event }) => event.kind === 31923)
  expect(retries.length).toBeGreaterThan(0)
  for (const { event } of retries)
    expect(JSON.stringify(event) === JSON.stringify(rejectedDate)).toBe(true)
})

test("organizer generates weekly dates and publishes one signed series @merchant @commerce", async ({
  page,
}) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(25_000)
  await page.clock.setFixedTime(new Date("2029-01-01T12:00:00Z"))
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await page.getByLabel("Event title").fill("Weekly Future Fair")
  await page.getByLabel("Description").fill("A weekly organizer market")
  await page.getByRole("button", { name: "Add by URL", exact: true }).click()
  await page
    .getByLabel("Banner URL")
    .fill("https://cdn.conduit.market/conduit-test/template-product.svg")
  await page.getByLabel("Location", { exact: true }).fill("Town Hall")
  await page.getByLabel("Start", { exact: true }).fill("2030-06-01T10:00")
  await page.getByLabel("End", { exact: true }).fill("2030-06-01T16:00")
  await page.getByRole("combobox", { name: "Time zone" }).click()
  await page.getByRole("option", { name: "UTC", exact: true }).click()
  await page.getByRole("combobox", { name: "Repeat", exact: true }).click()
  await page.getByRole("option", { name: "Weekly", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Saturday" })).toBeChecked()
  await page.getByLabel("Number of dates").fill("2")
  await expect(
    page
      .getByRole("list", { name: "Repeating dates preview" })
      .getByRole("listitem")
  ).toHaveCount(2)
  await page.getByRole("button", { name: "Publish event" }).click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  await expect(
    page.getByRole("heading", { name: "Weekly Future Fair" })
  ).toBeVisible()
  const published = uniquePublishedEvents(relay.publications)
  expect(published.filter((event) => event.kind === 31923)).toHaveLength(2)
  expect(published.filter((event) => event.kind === 31924)).toHaveLength(1)
  expect(published.filter((event) => event.kind === 30409)).toHaveLength(1)
  expect(published.map((event) => event.kind)).toEqual([
    31923, 31923, 31924, 30409,
  ])
  await page.locator("#series-new-start").fill("2030-06-15T10:00")
  await page.locator("#series-new-end").fill("2030-06-15T16:00")
  const heldRefresh = relay.holdRelayRequests(
    (request) =>
      uniquePublishedEvents(relay.publications).filter(
        (event) => event.kind === 31924
      ).length === 2 &&
      request.filters.some((filter) => filter.kinds?.includes(30409))
  )
  relay.rejectKind(31923, true)
  await page.getByRole("button", { name: "Add signed date" }).click()
  await expect(
    page.getByRole("button", { name: "Resume publishing" })
  ).toBeEnabled()
  const rejectedNewDate = uniquePublishedEvents(relay.publications)
    .filter((event) => event.kind === 31923)
    .at(-1)!
  expect(rejectedNewDate.created_at).toBe(
    published.find((event) => event.kind === 31924)!.created_at
  )
  await page.reload()
  const resumeNewDate = page.getByRole("button", { name: "Resume publishing" })
  await expect(resumeNewDate).toBeEnabled()
  await page.evaluate(() => {
    const syntheticWindow = window as typeof window & {
      __conduitNewDateSignAttempts: number
      nostr: { signEvent: (event: UnsignedEvent) => Promise<SignedEvent> }
    }
    const sign = syntheticWindow.nostr.signEvent
    syntheticWindow.__conduitNewDateSignAttempts = 0
    syntheticWindow.nostr.signEvent = async (event) => {
      if (event.kind === 31923) syntheticWindow.__conduitNewDateSignAttempts++
      return await sign(event)
    }
  })
  const newDateRetryStart = relay.publications.length
  relay.rejectKind(31923, false)
  await resumeNewDate.click()
  await expect(resumeNewDate).toHaveCount(0)
  const newDateRetries = relay.publications
    .slice(newDateRetryStart)
    .filter(({ event }) => event.kind === 31923)
  expect(newDateRetries.length).toBeGreaterThan(0)
  for (const { event } of newDateRetries)
    expect(JSON.stringify(event) === JSON.stringify(rejectedNewDate)).toBe(true)
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __conduitNewDateSignAttempts: number })
          .__conduitNewDateSignAttempts
    )
  ).toBe(0)
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications).filter(
          (event) => event.kind === 31924
        ).length
    )
    .toBe(2)
  expect(
    uniquePublishedEvents(relay.publications).filter(
      (event) => event.kind === 31923
    )
  ).toHaveLength(3)
  await heldRefresh.captured
  try {
    // A published schedule is not yet the refreshed editing state.
    await expect(
      page.getByRole("button", { name: "Save selected date" })
    ).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Remove future date" })
    ).toBeDisabled()
  } finally {
    heldRefresh.release()
  }
  await expect(
    page.getByRole("button", { name: "Save selected date" })
  ).toBeEnabled()
  await page.locator("#series-edit-title").fill("Weekly Future Fair updated")
  relay.rejectKind(31923, true)
  await page.getByRole("button", { name: "Save selected date" }).click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications).filter(
          (event) => event.kind === 31923
        ).length
    )
    .toBe(4)
  const rejectedDate = uniquePublishedEvents(relay.publications)
    .filter((event) => event.kind === 31923)
    .at(-1)!
  await expect(
    page.getByRole("button", { name: "Resume publishing" })
  ).toBeEnabled()
  await page.reload()
  const resumeDate = page.getByRole("button", { name: "Resume publishing" })
  await expect(resumeDate).toBeEnabled()
  const dateRetryStart = relay.publications.length
  relay.rejectKind(31923, false)
  await resumeDate.click()
  await expect(resumeDate).toHaveCount(0)
  const dateRetries = relay.publications
    .slice(dateRetryStart)
    .filter(({ event }) => event.kind === 31923)
  expect(dateRetries.length).toBeGreaterThan(0)
  for (const { event } of dateRetries)
    expect(JSON.stringify(event) === JSON.stringify(rejectedDate)).toBe(true)
  await expect(
    page.getByRole("button", { name: "Save selected date" })
  ).toBeEnabled()
  relay.rejectKind(31924, true)
  await page.getByRole("button", { name: "Remove future date" }).click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications).filter(
          (event) => event.kind === 31924
        ).length
    )
    .toBe(3)
  const rejectedSchedule = uniquePublishedEvents(relay.publications)
    .filter((event) => event.kind === 31924)
    .at(-1)!
  await expect(
    page.getByRole("button", { name: "Resume publishing" })
  ).toBeEnabled()
  await page.reload()
  const resumeSchedule = page.getByRole("button", { name: "Resume publishing" })
  await expect(resumeSchedule).toBeEnabled()
  const scheduleRetryStart = relay.publications.length
  relay.rejectKind(31924, false)
  await resumeSchedule.click()
  await expect(resumeSchedule).toHaveCount(0)
  const scheduleRetries = relay.publications
    .slice(scheduleRetryStart)
    .filter(({ event }) => event.kind === 31924)
  expect(scheduleRetries.length).toBeGreaterThan(0)
  for (const { event } of scheduleRetries)
    expect(JSON.stringify(event) === JSON.stringify(rejectedSchedule)).toBe(
      true
    )
  expect(
    uniquePublishedEvents(relay.publications).filter(
      (event) => event.kind === 30409
    )
  ).toHaveLength(1)
})

test("organizer reviews a refreshed date revision before saving local edits @merchant @commerce", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000)
  const calendarDraft = buildEventMarketCalendarDraft({
    kind: 31923,
    dTag: "concurrent-date",
    title: "Original date",
    summary: "Original description",
    locations: ["Original hall"],
    start: createdAt + 86_400,
    end: createdAt + 90_000,
    startTzid: "UTC",
    endTzid: "UTC",
  })
  const original = signEvent(ORGANIZER_SECRET, {
    ...calendarDraft,
    created_at: createdAt,
  })
  const schedule = signEvent(ORGANIZER_SECRET, {
    kind: 31924,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "concurrent-schedule"],
      ["title", "Concurrent fair"],
      ["a", eventCoordinate(original)],
    ],
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "concurrent-market"],
      ["a", eventCoordinate(schedule)],
      ["event_market", "2", "open"],
    ],
  })
  relay.seed(original, schedule, market)
  const marketRef = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "concurrent-market",
  })
  await gotoAs(page, merchantUrl, `/events/${marketRef}`, "organizer")
  const saveDate = page.getByRole("button", { name: "Save selected date" })
  await expect(saveDate).toBeEnabled()
  await page.locator("#series-edit-title").fill("Unsaved local title")
  const remote = signEvent(ORGANIZER_SECRET, {
    ...calendarDraft,
    created_at: createdAt + 1,
    tags: calendarDraft.tags.map((tag) => {
      if (tag[0] === "title") return ["title", "Updated remote date"]
      if (tag[0] === "summary") return ["summary", "Updated description"]
      if (tag[0] === "location") return ["location", "Updated hall"]
      return tag
    }),
  })
  relay.seed(remote)
  await page.getByRole("button", { name: "Refresh event records" }).click()
  const reviewDate = page.getByRole("button", { name: "Review updated date" })
  await expect(reviewDate).toBeVisible()
  await expect(saveDate).toBeDisabled()
  await expect(page.locator("#series-edit-title")).toHaveValue(
    "Unsaved local title"
  )
  expect(
    relay.publications.filter(({ event }) => event.kind === 31923)
  ).toHaveLength(0)

  await reviewDate.click()
  await expect(page.locator("#series-edit-title")).toHaveValue(
    "Updated remote date"
  )
  await expect(page.locator("#series-edit-location")).toHaveValue(
    "Updated hall"
  )
  await expect(page.locator("#series-edit-summary")).toHaveValue(
    "Updated description"
  )
  await expect(saveDate).toBeEnabled()
  await page.locator("#series-edit-title").fill("Reviewed local title")
  await saveDate.click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications).filter(
          (event) => event.kind === 31923
        ).length
    )
    .toBe(1)
  await expect(saveDate).toBeEnabled()
  await expect(reviewDate).toHaveCount(0)
  const saved = uniquePublishedEvents(relay.publications).find(
    (event) => event.kind === 31923
  )!
  expect(saved.created_at > remote.created_at).toBe(true)
  expect(
    saved.tags.some(
      (tag) => tag[0] === "title" && tag[1] === "Reviewed local title"
    )
  ).toBe(true)
  expect(
    saved.tags.some((tag) => tag[0] === "location" && tag[1] === "Updated hall")
  ).toBe(true)
  expect(
    saved.tags.some(
      (tag) => tag[0] === "summary" && tag[1] === "Updated description"
    )
  ).toBe(true)

  // A successful save advances the form's baseline for the next edit.
  await page.locator("#series-edit-title").fill("Second local title")
  await saveDate.click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications).filter(
          (event) => event.kind === 31923
        ).length
    )
    .toBe(2)
  await expect(saveDate).toBeEnabled()
  expect(relay.publications.some(({ event }) => event.kind === 31924)).toBe(
    false
  )
})

for (const fee of [
  {
    name: "active organizer fee",
    tag: [
      "conduit_event_fee",
      "1",
      "active",
      "250",
      "50",
      "organizer@example.test",
    ],
    notice: "Event fee payments are not available here yet.",
  },
  {
    name: "unusable organizer fee",
    tag: [
      "conduit_event_fee",
      "1",
      "active",
      "invalid",
      "50",
      "organizer@example.test",
    ],
    notice:
      "The signed event fee terms are unavailable. Refresh the event before paying.",
  },
  {
    name: "no organizer fee",
    tag: null,
    notice: null,
  },
]) {
  test(`disabled router ${fee.tag ? "blocks" : "preserves"} ${fee.name} before direct event checkout @market @occurrence-orders`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    const createdAt = Math.floor(Date.now() / 1_000) - 10
    const calendar = signEvent(ORGANIZER_SECRET, {
      ...buildEventMarketCalendarDraft({
        kind: 31923,
        dTag: "disabled-fee-fair",
        title: "Fee admission fair",
        start: createdAt + 3_600,
        end: createdAt + 7_200,
      }),
      created_at: createdAt,
    })
    const market = signEvent(ORGANIZER_SECRET, {
      kind: 30409,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", "disabled-fee-fair"],
        ["a", eventCoordinate(calendar)],
        ["event_market", "2", "open"],
        ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 1"],
        ...(fee.tag ? [fee.tag] : []),
      ],
    })
    const grant = signEvent(ORGANIZER_SECRET, {
      kind: 3841,
      created_at: createdAt,
      content: "",
      tags: [
        ["openmarkets", "event-market-auth", "1"],
        ["a", eventCoordinate(market)],
        ["p", MERCHANT_PUBKEY],
        ["state", "active"],
        ["seq", "0"],
        ["alt", "Open Markets event merchant authorization"],
      ],
    })
    const template = createMerchantTemplateProductEvent(createdAt)
    const product = signEvent(MERCHANT_SECRET, {
      ...template,
      tags: template.tags
        .map((tag) => (tag[0] === "stock" ? ["stock", "5"] : tag))
        .concat([["a", eventCoordinate(market)]]),
    })
    relay.seed(
      calendar,
      market,
      grant,
      product,
      signedAssignment(market, calendar, product),
      createInboxDeclaration("merchant", createdAt)
    )
    const marketRef = nip19.naddrEncode({
      kind: 30409,
      pubkey: ORGANIZER_PUBKEY,
      identifier: "disabled-fee-fair",
    })
    await gotoAs(page, marketUrl, `/events/${marketRef}`, "buyer")
    await expect(
      page.getByRole("heading", { name: MERCHANT_TEMPLATE_TITLE })
    ).toBeVisible({ timeout: 25_000 })
    await page.getByRole("button", { name: /^Add .+ to cart$/ }).click()
    await expect(
      page.getByRole("button", { name: "Cart, 1 item" })
    ).toBeVisible()
    await page.goto(`${marketUrl}/checkout`)
    await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible()
    if (!fee.notice) {
      await expect(
        page.getByRole("button", { name: "Send order", exact: true })
      ).toBeEnabled()
      return
    }
    await expect(page.getByText(fee.notice, { exact: true })).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Continue to payment", exact: true })
    ).toBeDisabled()
    const directActions = page.getByRole("button", {
      name: /(?:pay for order|pay now|zap out|send order)/i,
    })
    for (const action of await directActions.all())
      await expect(action).toBeDisabled()
    expect(
      uniquePrivatePublications(
        decryptPrivatePublications(relay.publications, MERCHANT_SECRET)
      ).filter((message) => rumorType(message.rumor) === "order").length
    ).toBe(0)
  })
}

test("event shopping keeps pickup-only choices and merchant profile navigation @market @commerce @occurrence-orders", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000)
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "choice-fair",
      title: "Choice Fair",
      start: createdAt + 3600,
      end: createdAt + 7200,
    }),
    created_at: createdAt,
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "choice-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 1"],
    ],
  })
  const grant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(market)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  const shipping = signEvent(MERCHANT_SECRET, {
    kind: 30406,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "choice-shipping"],
      ["title", "Shop shipping"],
      ["price", "200", "SAT"],
      ["country", "US"],
      ["service", "shipping"],
    ],
  })
  const product = signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: createdAt,
    content: "Choice soap",
    tags: [
      ["d", "choice-soap"],
      ["title", "Choice soap"],
      ["summary", "Handmade soap"],
      ["image", "https://cdn.conduit.market/conduit-test/template-product.svg"],
      ["t", "soap"],
      ["t", "handmade"],
      ["t", "home"],
      ["price", "1000", "SAT"],
      ["type", "simple", "physical"],
      ["stock", "5"],
      ["a", eventCoordinate(market)],
      ["shipping_option", eventCoordinate(shipping)],
    ],
  })
  relay.seed(
    calendar,
    market,
    grant,
    shipping,
    product,
    signedAssignment(market, calendar, product, 5, ["pickup", "shipping"])
  )
  relay.seed(
    signEvent(MERCHANT_SECRET, {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify({ name: "Choice merchant" }),
    })
  )
  const marketRef = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "choice-fair",
  })
  await gotoAs(page, marketUrl, `/events/${marketRef}`, "buyer")
  await expect(page.getByRole("heading", { name: "Choice soap" })).toBeVisible()
  const search = page.getByRole("searchbox", {
    name: "Search products or merchants",
  })
  await search.fill("no-matching-product")
  await expect(page.getByRole("heading", { name: "Choice soap" })).toHaveCount(
    0
  )
  await expect(search).toBeVisible()
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await expect(search).toHaveValue("")
  await expect(page.getByRole("heading", { name: "Choice soap" })).toBeVisible()
  await page
    .getByRole("button", { name: "Choice merchant", exact: true })
    .click()
  await expect
    .poll(
      () =>
        new URL(page.url()).pathname === `/${nip19.npubEncode(MERCHANT_PUBKEY)}`
    )
    .toBe(true)
  await expect(
    page.getByRole("heading", { name: "Choice merchant", exact: true })
  ).toBeVisible()
  await gotoAs(page, marketUrl, `/events/${marketRef}`, "buyer")
  await expect(page.getByRole("heading", { name: "Choice soap" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveCount(0)
  await page.getByRole("heading", { name: "Choice soap" }).click()
  await expect(page).toHaveURL(/\/products\//)
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: /^Add 1 to cart$/ }).click()
  await expect(page.getByRole("button", { name: /Cart, 1 item/ })).toBeVisible()
  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveCount(0)
  await expect(page.getByText(/Event pickup/).first()).toBeVisible()
  await page.goto(`${marketUrl}/checkout`)
  await expect(
    page.getByRole("heading", { name: "Checkout", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Delivery details" })
  ).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Checkout", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Delivery details" })
  ).toHaveCount(0)
  await gotoAs(page, marketUrl, `/events/${marketRef}`, "buyer")
  const closed = signEvent(ORGANIZER_SECRET, {
    ...market,
    created_at: createdAt + 1,
    tags: market.tags
      .map((tag) =>
        tag[0] === "event_market" ? ["event_market", "2", "closed"] : tag
      )
      .concat([["prev", market.id]]),
  })
  relay.seed(closed)
  await page.getByRole("button", { name: "Refresh event records" }).click()
  await expect(
    page.getByText("This Event Market is closed to new purchases.")
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: /^Add .+ to cart$/ })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveCount(0)
})

for (const retention of ["screen", "file"] as const) {
  test(`guest retains a private event receipt by ${retention} and merchant verifies it @market @merchant @commerce @occurrence-orders`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    let receiptStage:
      | "setup"
      | "phone-normalization"
      | "receipt-required"
      | "receipt-display"
      | "receipt-export"
      | "order-submission"
      | "code-verification"
      | "text-verification"
      | "legacy-file-verification"
      | "mismatch-rejection" = "setup"
    try {
      const relay = createRelayHarness()
      await installSyntheticEnvironment(page, relay)
      const createdAt = Math.floor(Date.now() / 1000)
      const calendar = signEvent(ORGANIZER_SECRET, {
        ...buildEventMarketCalendarDraft({
          kind: 31923,
          dTag: "choice-fair",
          title: "Choice Fair",
          start: createdAt - 60,
          end: createdAt + 7200,
        }),
        created_at: createdAt,
      })
      const market = signEvent(ORGANIZER_SECRET, {
        kind: 30409,
        created_at: createdAt,
        content: "",
        tags: [
          ["d", "choice-fair"],
          ["a", eventCoordinate(calendar)],
          ["event_market", "2", "open"],
          ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 1"],
        ],
      })
      const grant = signEvent(ORGANIZER_SECRET, {
        kind: 3841,
        created_at: createdAt,
        content: "",
        tags: [
          ["openmarkets", "event-market-auth", "1"],
          ["a", eventCoordinate(market)],
          ["p", MERCHANT_PUBKEY],
          ["state", "active"],
          ["seq", "0"],
          ["alt", "Open Markets event merchant authorization"],
        ],
      })
      const shipping = signEvent(MERCHANT_SECRET, {
        kind: 30406,
        created_at: createdAt,
        content: "",
        tags: [
          ["d", "choice-shipping"],
          ["title", "Shop shipping"],
          ["price", "200", "SAT"],
          ["country", "US"],
          ["service", "shipping"],
        ],
      })
      const product = signEvent(MERCHANT_SECRET, {
        kind: 30402,
        created_at: createdAt,
        content: "Receipt soap",
        tags: [
          ["d", "choice-soap"],
          ["title", "Receipt soap"],
          ["summary", "Handmade soap"],
          [
            "image",
            "https://cdn.conduit.market/conduit-test/template-product.svg",
          ],
          ["t", "soap"],
          ["t", "handmade"],
          ["t", "home"],
          ["price", "0", "SAT"],
          ["conduit_event_guest", "contact_optional"],
          ["type", "simple", "physical"],
          ["stock", "5"],
          ["a", eventCoordinate(market)],
          ["shipping_option", eventCoordinate(shipping)],
        ],
      })
      relay.seed(
        calendar,
        market,
        grant,
        shipping,
        product,
        signedAssignment(market, calendar, product),
        createInboxDeclaration("merchant", createdAt)
      )
      const marketRef = nip19.naddrEncode({
        kind: 30409,
        pubkey: ORGANIZER_PUBKEY,
        identifier: "choice-fair",
      })
      await page.goto(`${marketUrl}/events/${marketRef}`)
      await expect(
        page.getByRole("heading", { name: "Receipt soap" })
      ).toBeVisible()
      await page.getByRole("button", { name: /^Add .+ to cart$/ }).click()
      await expect(
        page.getByRole("button", { name: /Cart, 1 item/ })
      ).toBeVisible()
      await page.goto(`${marketUrl}/checkout`)
      receiptStage = "phone-normalization"
      await expect(
        page.getByLabel("Phone country", { exact: true })
      ).toBeVisible()
      await page.getByLabel("Phone", { exact: true }).fill("202 555 0123")
      await page.getByLabel("Phone", { exact: true }).blur()
      expect(
        (await page.getByLabel("Phone", { exact: true }).inputValue()) ===
          "+12025550123"
      ).toBe(true)
      await page.getByLabel("Phone country", { exact: true }).click()
      await page.getByRole("option", { name: /United Kingdom/ }).click()
      await page.getByLabel("Phone", { exact: true }).fill("020 7946 0958")
      await page.getByLabel("Phone", { exact: true }).blur()
      expect(
        (await page.getByLabel("Phone", { exact: true }).inputValue()) ===
          "+442079460958"
      ).toBe(true)
      await page.getByLabel("Phone", { exact: true }).fill("+1 202 555 0123")
      await page.getByLabel("Phone", { exact: true }).blur()
      expect(
        (await page.getByLabel("Phone", { exact: true }).inputValue()) ===
          "+12025550123"
      ).toBe(true)
      receiptStage = "receipt-required"
      await page
        .getByRole("checkbox", { name: "Use a name only for handoff" })
        .check()
      await expect(page.getByLabel("Phone", { exact: true })).toHaveCount(0)
      await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0)
      await page.getByLabel("Name or pseudonym for handoff").fill("Soap fan")
      const before = relay.publications.length
      await page
        .getByRole("button", { name: "Send order", exact: true })
        .click()
      await expect(
        page
          .getByText("Save your event receipt and confirm that you kept it.")
          .first()
      ).toBeVisible()
      const prematureOrderCount = decryptPrivatePublications(
        relay.publications,
        MERCHANT_SECRET,
        before
      ).filter((message) => rumorType(message.rumor) === "order").length
      expect(prematureOrderCount).toBe(0)
      // The private receipt is usable on screen; generating it must not force a file.
      let automaticDownloads = 0
      page.on("download", () => {
        automaticDownloads += 1
      })
      receiptStage = "receipt-display"
      await page
        .getByRole("button", { name: "Show private receipt", exact: true })
        .click()
      await expect(
        page.getByRole("region", {
          name: "Private pickup receipt",
          exact: true,
        })
      ).toBeVisible()
      expect(automaticDownloads).toBe(0)
      const receiptCode = await page
        .getByLabel("Private receipt code", { exact: true })
        .inputValue()
      let receiptPath: string | null = null
      if (retention === "file") {
        receiptStage = "receipt-export"
        const downloadPending = page.waitForEvent("download")
        await page
          .getByRole("button", { name: "Save event receipt", exact: true })
          .click()
        const download = await downloadPending
        receiptPath = await download.path()
        if (!receiptPath) throw new Error("Receipt download is missing")
        expect(
          download.suggestedFilename() === "conduit-event-receipt.txt"
        ).toBe(true)
      }
      receiptStage = "order-submission"
      await page
        .getByRole("checkbox", {
          name: "I saved my private receipt",
        })
        .check()
      await page
        .getByRole("button", { name: "Send order", exact: true })
        .click()
      const orders = () =>
        uniquePrivatePublications(
          decryptPrivatePublications(
            relay.publications,
            MERCHANT_SECRET,
            before
          )
        ).filter((message) => rumorType(message.rumor) === "order")
      await expect.poll(() => orders().length).toBe(1)
      expect(automaticDownloads).toBe(retention === "file" ? 1 : 0)
      const order = JSON.parse(orders()[0]!.rumor.content) as {
        id: string
        buyerIdentityKind: string
        guestContact?: unknown
        contactFreePickup: { label: string; receiptCommitment: string }
      }
      expect(order.buyerIdentityKind === "guest_ephemeral").toBe(true)
      expect(order.guestContact === undefined).toBe(true)
      expect(order.contactFreePickup.label === "Soap fan").toBe(true)
      expect(
        /^[0-9a-f]{64}$/.test(order.contactFreePickup.receiptCommitment)
      ).toBe(true)
      expect(orders()[0]!.rumor.content.includes("claimSecret")).toBe(false)
      // The Orders component must commit before starting a new document.
      await expect(page).toHaveURL(/\/orders(?:\?|$)/)
      await expect(
        page.getByRole("heading", { name: "Orders", exact: true })
      ).toBeVisible()
      receiptStage = "code-verification"
      await gotoAs(page, merchantUrl, "/orders", "merchant", {
        order: order.id,
      })
      await expect(page.getByText("Handoff name: Soap fan")).toBeVisible()
      await page
        .getByLabel("Or enter the private receipt code")
        .fill(receiptCode)
      await page
        .getByRole("button", { name: "Verify receipt code", exact: true })
        .click()
      await expect(page.getByText(/Receipt matches this order\./)).toBeVisible()
      const originalReceipt = {
        format: "conduit-event-receipt" as const,
        version: 1 as const,
        orderId: order.id,
        merchantPubkey: MERCHANT_PUBKEY,
        claimSecret: receiptCode,
      }
      receiptStage = "text-verification"
      await page.getByLabel("Verify customer receipt").setInputFiles(
        receiptPath ?? {
          name: "private-receipt.txt",
          mimeType: "text/plain",
          buffer: Buffer.from(formatEventGuestReceipt(originalReceipt)),
        }
      )
      await expect(page.getByText(/Receipt matches this order\./)).toBeVisible()
      receiptStage = "legacy-file-verification"
      await page.getByLabel("Verify customer receipt").setInputFiles({
        name: "original-receipt.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(originalReceipt)),
      })
      await expect(page.getByText(/Receipt matches this order\./)).toBeVisible()
      receiptStage = "mismatch-rejection"
      await page.getByLabel("Verify customer receipt").setInputFiles({
        name: "damaged-receipt.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            format: "conduit-event-receipt",
            version: 1,
            orderId: order.id,
            merchantPubkey: MERCHANT_PUBKEY,
            claimSecret: "0".repeat(64),
          })
        ),
      })
      await expect(
        page.getByText("This receipt does not match this order and merchant.")
      ).toBeVisible()
    } catch {
      throw new Error(`Guest receipt journey failed at ${receiptStage}.`)
    }
  })
}

test("organizer fee edits use saved addresses and collapse only after signed publication @merchant @commerce @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "fee-editor-fair",
      title: "Fee editor fair",
      start: createdAt + 7_200,
      end: createdAt + 10_800,
    }),
    created_at: createdAt,
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "fee-editor-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      [
        "conduit_event_fee",
        "1",
        "active",
        "250",
        "10",
        "old@example.com",
        String(createdAt + 3_600),
      ],
    ],
  })
  const profile = signEvent(ORGANIZER_SECRET, {
    kind: 0,
    created_at: createdAt,
    tags: [],
    content: JSON.stringify({ name: "Organizer", lud16: "saved@example.com" }),
  })
  relay.seed(calendar, market, profile)
  const reference = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "fee-editor-fair",
  })
  await gotoAs(page, merchantUrl, `/events/${reference}`, "organizer")
  await expect(
    page.getByText("2.5%, minimum 10 sats", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Save fee settings", exact: true })
  ).toHaveCount(0)
  const before = relay.publications.length
  await page
    .getByRole("button", { name: "Edit fee settings", exact: true })
    .click()
  await expect(page.getByLabel("Minimum (sats)", { exact: true })).toHaveCount(
    0
  )
  await expect(
    page.getByLabel("Expiry (UTC, optional)", { exact: true })
  ).toHaveCount(0)
  const address = page.getByRole("textbox", {
    name: "Organizer Lightning address",
    exact: true,
  })
  await expect(address).toHaveValue("old@example.com")
  await page
    .getByRole("button", { name: "Use my Lightning address", exact: true })
    .click()
  await expect(address).toHaveValue("saved@example.com")
  await address.fill("custom@example.com")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(
    page.getByText("2.5%, minimum 10 sats", { exact: true })
  ).toBeVisible()
  expect(
    relay.publications
      .slice(before)
      .filter((event) => event.event.kind === 30409)
  ).toHaveLength(0)
  await page
    .getByRole("button", { name: "Edit fee settings", exact: true })
    .click()
  await expect(address).toHaveValue("old@example.com")
  await page
    .getByRole("textbox", { name: "Percentage", exact: true })
    .fill("3.75")
  await page
    .getByRole("button", { name: "Use my Lightning address", exact: true })
    .click()
  relay.rejectKind(30409, true)
  await page
    .getByRole("button", { name: "Save fee settings", exact: true })
    .click()
  await expect(
    page.getByRole("button", {
      name: "Retry current signed settings",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Save fee settings", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByText("Fee settings saved and published.", { exact: true })
  ).toHaveCount(0)
  const signedAttempts = uniquePublishedEvents(
    relay.publications.slice(before)
  ).filter((event) => event.kind === 30409)
  expect(signedAttempts).toHaveLength(1)
  expect(
    signedAttempts[0]!.tags.find((tag) => tag[0] === "conduit_event_fee")
  ).toEqual([
    "conduit_event_fee",
    "1",
    "active",
    "375",
    "0",
    "saved@example.com",
  ])
  relay.rejectKind(30409, false)
  await page
    .getByRole("button", { name: "Retry current signed settings", exact: true })
    .click()
  await expect(page.getByText("3.75%", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Edit fee settings", exact: true })
  ).toBeEnabled()
  await expect(
    page.getByRole("button", { name: "Save fee settings", exact: true })
  ).toHaveCount(0)
  expect(
    uniquePublishedEvents(relay.publications.slice(before)).filter(
      (event) => event.kind === 30409
    )
  ).toHaveLength(1)
  expect(
    uniquePublishedEvents(relay.publications.slice(before)).some(
      (event) => event.kind === 0
    )
  ).toBe(false)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Save fee settings", exact: true })
  ).toHaveCount(0)
  await page
    .getByRole("button", { name: "Edit fee settings", exact: true })
    .click()
  await expect(address).toHaveValue("saved@example.com")
  await address.fill("custom@example.com")
  await page
    .getByRole("button", { name: "Save fee settings", exact: true })
    .click()
  await expect(
    page.getByText("custom@example.com", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Save fee settings", exact: true })
  ).toHaveCount(0)
})

test("reserved organizer stock carries a free purchase through pickup and once-only seller reconciliation @market @merchant @commerce @occurrence-orders", async ({
  page,
}, info) => {
  test.setTimeout(240_000)
  const result = await createAssignedPickupOrder(page, {
    zeroCost: true,
    organizerHandoff: true,
    beforeBuyer: async ({ relay, marketNaddr }) => {
      const eventPath = "/events/" + marketNaddr
      await gotoAs(page, merchantUrl, eventPath, "organizer")
      await page
        .getByRole("combobox", { name: "Fee setting", exact: true })
        .click()
      await page
        .getByRole("option", { name: "Charge an organizer fee", exact: true })
        .click()
      await page
        .getByRole("textbox", { name: "Percentage", exact: true })
        .fill("2.5")
      await page
        .getByRole("textbox", {
          name: "Organizer Lightning address",
          exact: true,
        })
        .fill("organizer@example.com")
      await page
        .getByRole("button", { name: "Save fee settings", exact: true })
        .click()
      await expect(page.getByText("2.5%", { exact: true })).toBeVisible()
      expect(
        uniquePublishedEvents(relay.publications)
          .filter((event) => event.kind === 30409)
          .at(-1)
          ?.tags.find((tag) => tag[0] === "conduit_event_fee")
      ).toEqual([
        "conduit_event_fee",
        "1",
        "active",
        "250",
        "0",
        "organizer@example.com",
      ])
      await page
        .getByRole("button", { name: "Edit fee settings", exact: true })
        .click()
      await page
        .getByRole("combobox", { name: "Fee setting", exact: true })
        .click()
      await page
        .getByRole("option", { name: "Disable organizer fee", exact: true })
        .click()
      await page
        .getByRole("button", { name: "Save fee settings", exact: true })
        .click()
      await expect(
        page.getByText("Organizer fee disabled.", { exact: true })
      ).toBeVisible()
      expect(
        uniquePublishedEvents(relay.publications)
          .filter((event) => event.kind === 30409)
          .at(-1)
          ?.tags.find((tag) => tag[0] === "conduit_event_fee")
      ).toEqual(["conduit_event_fee", "1", "disabled"])
      await expect(
        page.getByRole("button", {
          name: "Prepare replacement device",
          exact: true,
        })
      ).toBeHidden()
      await page
        .getByRole("button", {
          name: "Set up pickup here",
          exact: true,
        })
        .click()
      await expect(
        page.getByText(
          "Pickup is set up here. Copy the setup code and share it with the seller.",
          { exact: true }
        )
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        page.getByRole("button", {
          name: "Copy pickup setup code",
          exact: true,
        })
      ).toBeVisible()
      await expect(
        page.getByRole("textbox", {
          name: "Pickup setup code",
          exact: true,
        })
      ).toBeHidden()
      await page.getByText("Technical pickup details", { exact: true }).click()
      let writerId: string
      try {
        writerId = await page
          .getByRole("textbox", {
            name: "Pickup setup code",
            exact: true,
          })
          .inputValue()
      } catch (error) {
        await recordEventStockControlFailure(page, info, "setup_code_read")
        throw error
      }
      await gotoAs(page, merchantUrl, eventPath, "merchant")
      const stock = page.getByRole("combobox", {
        name: "Stock for organizer pickup",
        exact: true,
      })
      await expect(stock).toBeEnabled()
      // Exercise Radix's focused keyboard path, then confirm the exact selection.
      await stock.press("Enter")
      const product = page.getByRole("option", {
        name: /synthetic-existing-product/,
      })
      await expect(product).toBeVisible()
      await product.press("Enter")
      await expect(stock).toContainText(/synthetic-existing-product/)
      await page
        .getByRole("textbox", { name: "Quantity to reserve", exact: true })
        .fill("2")
      await page
        .getByRole("textbox", {
          name: "Pickup setup code from organizer",
          exact: true,
        })
        .fill(writerId)
      await page
        .getByRole("button", {
          name: "Reserve stock for organizer",
          exact: true,
        })
        .click()
      await expect(
        page.getByText(/exact stock reservation is saved/)
      ).toBeVisible()
      const assignment = uniquePublishedEvents(relay.publications)
        .filter((event) => event.kind === 30410)
        .find(
          (event) =>
            parseEventMarketAssignmentEvent(event)?.stockPool.state === "valid"
        )!
      expect(!!assignment).toBe(true)
      await gotoAs(page, merchantUrl, eventPath, "organizer")
      await page
        .getByRole("button", {
          name: "Check for stock updates",
          exact: true,
        })
        .click()
      const acceptOptions = {
        name: "Accept reserved stock",
        exact: true,
      }
      const accept = page.getByRole("button", acceptOptions)
      recordSmokeDiagnostic(info, "event-stock-acceptance", { phase: "click" })
      try {
        await accept.click()
      } catch (cause) {
        recordSmokeDiagnostic(info, "event-stock-acceptance", {
          phase: "failure",
          ...classifyStockAcceptanceError(cause),
          ...(await observeStockAcceptance(
            page.getByRole("button", { ...acceptOptions, includeHidden: true })
          )),
          pageClosed: page.isClosed(),
        })
        throw cause
      }
      recordSmokeDiagnostic(info, "event-stock-acceptance", {
        phase: "complete",
      })
      await expect(
        page.getByText(/Reserved stock is ready for pickup here/)
      ).toBeVisible()
      return assignment
    },
  })
  const claim = formatPickupClaimCode(
    getFutureMarketClaimRef({
      orderId: result.order.id,
      merchantPubkey: MERCHANT_PUBKEY,
      organizerPubkey: ORGANIZER_PUBKEY,
      marketCoordinate: eventCoordinate(result.market),
    })
  )
  const eventPath = "/events/" + result.marketNaddr
  await gotoAs(page, merchantUrl, eventPath, "organizer")
  await page
    .getByRole("button", { name: "Refresh saved event orders", exact: true })
    .click()
  await page
    .getByRole("button", {
      name: new RegExp(`Open free pickup ${result.order.id.slice(-8)}$`),
    })
    .click()
  const handoutItems = page.getByRole("region", {
    name: "Items to hand out",
    exact: true,
  })
  await expect(
    handoutItems.getByText(
      result.product.tags.find((tag) => tag[0] === "title")![1]!,
      { exact: true }
    )
  ).toBeVisible()
  await expect(handoutItems.getByText("Qty 1", { exact: true })).toBeVisible()
  await page
    .getByRole("button", { name: "Check free pickup", exact: true })
    .click()
  await expect(
    page.getByText("Free pickup verified", { exact: false }).first()
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Buyer's pickup code", exact: true })
    .fill(claim)
  await page
    .getByRole("button", {
      name: "Confirm code and hand out once",
      exact: true,
    })
    .click()
  await expect(
    page.getByText(/Handout recorded/, { exact: false }).first()
  ).toBeVisible()
  await page.reload()
  await page
    .getByRole("button", { name: "Refresh saved event orders", exact: true })
    .click()
  await page
    .getByRole("button", {
      name: new RegExp(`Open free pickup ${result.order.id.slice(-8)}$`),
    })
    .click()
  await expect(
    page.getByRole("button", {
      name: "Confirm code and hand out once",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", {
      name: "Retry saved handout update",
      exact: true,
    })
  ).toBeVisible()
  await page
    .getByRole("button", {
      name: "Stop new sales and close reserved stock",
      exact: true,
    })
    .click()
  await expect(
    page.getByText(/New sales are stopped for this pool/)
  ).toBeVisible()
  await gotoAs(page, merchantUrl, eventPath, "merchant")
  await page
    .getByRole("button", { name: "Check for stock updates", exact: true })
    .click()
  try {
    await page
      .getByRole("button", {
        name: "Reconcile accepted order stock",
        exact: true,
      })
      .click()
  } catch (error) {
    await recordEventStockControlFailure(page, info, "stock_reconcile")
    throw error
  }
  await expect(
    page.getByText(/exact accepted order and handout are reconciled once/)
  ).toBeVisible()
  await page
    .getByRole("button", {
      name: "Reconcile accepted order stock",
      exact: true,
    })
    .click()
  await expect(page.getByText(/already reconciled/)).toBeVisible()
  await page
    .getByRole("button", {
      name: "Review closed stock and release unused quantity",
      exact: true,
    })
    .click()
  await expect(
    page.getByText(/complete closing history is reconciled/)
  ).toBeVisible()
  await gotoAs(page, merchantUrl, "/orders", "merchant", {
    order: result.order.id,
  })
  await expect(
    page.getByTestId("merchant-future-organizer-handoff")
  ).toHaveCount(0)
  const accept = page.getByRole("button", { name: "Accept order", exact: true })
  if (await accept.isVisible()) {
    await accept.click()
    await expect(
      page.getByText(/Accepted and inventory saved on this device/)
    ).toBeVisible()
  }
  const complete = page.getByRole("button", {
    name: "Mark picked up / complete",
    exact: true,
  })
  await expect(complete).toBeEnabled()
  const completionStart = result.relay.publications.length
  // Mobile WebKit can release a scripted pointer outside this button.
  // Focused keyboard activation starts exactly one action without retrying it.
  await complete.press("Enter")
  // Settle the initiated action before checking its exact private receipt.
  await complete.waitFor({ state: "hidden" })
  await page
    .getByRole("button", { name: /^(Sending|Recording)…$/ })
    .waitFor({ state: "hidden" })
  await expect
    .poll(
      () =>
        uniquePrivatePublications(
          decryptPrivatePublications(
            result.relay.publications,
            BUYER_SECRET,
            completionStart
          )
        ).filter(
          (message) =>
            rumorType(message.rumor) === "status_update" &&
            JSON.parse(message.rumor.content).status === "complete"
        ).length
    )
    .toBe(1)
  expect(
    uniquePrivatePublications(
      decryptPrivatePublications(
        result.relay.publications,
        ORGANIZER_SECRET,
        completionStart
      )
    ).some((message) => rumorType(message.rumor) === "future_market_ready")
  ).toBe(false)

  await gotoAs(page, merchantUrl, eventPath, "organizer")
  await page.getByRole("button", { name: "Revoke", exact: true }).click()
  await expect
    .poll(() =>
      uniquePublishedEvents(result.relay.publications)
        .filter((event) => event.kind === 30409)
        .at(-1)
        ?.tags.some(
          (tag) => tag[0] === "merchant" && tag[1] === MERCHANT_PUBKEY
        )
    )
    .toBe(false)
  await waitForSavedMerchantDecision(
    page,
    eventCoordinate(result.market),
    "revoke"
  )
  await gotoAs(page, merchantUrl, eventPath, "merchant")
  const history = page.locator("details").filter({
    has: page.getByText("Recover prior organizer stock history", {
      exact: true,
    }),
  })
  await history
    .getByText("Recover prior organizer stock history", { exact: true })
    .click()
  await history
    .getByRole("button", { name: "Check for stock updates", exact: true })
    .click()
  await history
    .getByRole("button", {
      name: "Reconcile accepted order stock",
      exact: true,
    })
    .click()
  await expect(history.getByText(/already reconciled/)).toBeVisible()
  expect(
    await occurrenceInventory(
      page,
      eventCoordinate(result.product),
      result.order.id
    )
  ).toMatchObject({
    stock: 8,
    allocation: 1,
    acceptedOrders: 1,
    savedOrder: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
})

async function enablePrivateInbox(page: Page): Promise<void> {
  const relays = page.getByRole("region", { name: "Relays", exact: true })
  await expect(relays).toBeVisible()
  const inbox = relays.getByRole("button", {
    name: `Enable Private inbox for ${FIXTURE_RELAY}`,
    exact: true,
  })
  if ((await inbox.count()) === 0) {
    const input = relays.getByLabel("Add relay", { exact: true })
    await input.fill(FIXTURE_RELAY)
    await expect(
      relays.getByRole("button", { name: "Add relay", exact: true })
    ).toBeEnabled()
    // Mobile WebKit can lose a pointer click while the relay list settles.
    // Submit from the focused field and confirm the form handled the action.
    await input.press("Enter")
    await expect(input).toHaveValue("")
  }
  await expect(
    relays.getByRole("button", {
      name: `Enable Private inbox for ${FIXTURE_RELAY}`,
      exact: true,
    })
  ).toBeVisible({ timeout: 20_000 })
  for (const role of ["Read", "Publish", "Private inbox"]) {
    const enable = relays.getByRole("button", {
      name: `Enable ${role} for ${FIXTURE_RELAY}`,
      exact: true,
    })
    if (await enable.count()) {
      await expect(enable).toBeEnabled({ timeout: 20_000 })
      await enable.click()
    }
  }
  await expect(
    relays.getByRole("button", {
      name: `Disable Private inbox for ${FIXTURE_RELAY}`,
      exact: true,
    })
  ).toBeVisible()
  const review = relays.getByRole("button", {
    name: "Review and publish",
    exact: true,
  })
  await expect(review).toBeEnabled({ timeout: 20_000 })
  await review.click()
  const confirmation = page.getByRole("alertdialog", {
    name: "Publish these Network changes?",
  })
  await confirmation
    .getByRole("button", { name: "Sign and publish", exact: true })
    .click()
  await expect(
    page.getByText(
      "The exact signed preferences were confirmed on the planned relays.",
      { exact: true }
    )
  ).toBeVisible({ timeout: 20_000 })
}

test("a host and merchant create, request, approve and offer through the screens @market @merchant @commerce @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  relay.seed(
    createMerchantTemplateProductEvent(Math.floor(Date.now() / 1000) - 10)
  )
  await gotoAs(page, merchantUrl, "/network", "organizer")
  await enablePrivateInbox(page)
  await page.goto(`${merchantUrl}/events/new`)
  await page.getByLabel("Event title").fill("Community Makers Fair")
  await page
    .getByLabel("Description")
    .fill("Local makers and neighbors at the community hall")
  await page.getByRole("button", { name: "Add by URL", exact: true }).click()
  await page
    .getByLabel("Banner URL")
    .fill("https://cdn.conduit.market/conduit-test/template-product.svg")
  await page.getByLabel("Location", { exact: true }).fill("Community Hall")
  await page.getByLabel("Start", { exact: true }).fill("2030-06-01T10:00")
  await page.getByLabel("End", { exact: true }).fill("2030-06-01T16:00")
  await page.getByRole("button", { name: "Publish event" }).click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  const eventPath = new URL(page.url()).pathname
  const market = uniquePublishedEvents(relay.publications).find(
    (event) => event.kind === 30409
  )!
  expect(market).toBeDefined()
  expect(market.tags.some((tag) => tag[0] === "merchant")).toBe(false)
  const stockControls = page.getByText(
    "Move pickup to another device (advanced)",
    { exact: true }
  )
  await expect(stockControls).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Organizer-held stock", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: "Prepare replacement device",
      exact: true,
    })
  ).toBeHidden()
  await stockControls.click()
  await expect(
    page.getByRole("button", {
      name: "Prepare replacement device",
      exact: true,
    })
  ).toBeVisible()
  await stockControls.click()
  await expect(
    page.getByRole("button", {
      name: "Set up pickup here",
      exact: true,
    })
  ).toBeVisible()
  const initialCalendar = uniquePublishedEvents(relay.publications).find(
    (event) => event.kind === 31923
  )!
  await page.getByRole("button", { name: "Add by URL", exact: true }).click()
  const updatedBanner =
    "https://cdn.conduit.market/conduit-test/updated-event.svg"
  await page.getByLabel("Banner URL").fill(updatedBanner)
  await page.getByLabel(/^Start \(/).fill("2030-06-01T11:00")
  await page
    .getByRole("button", { name: "Save event details", exact: true })
    .click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications).filter(
          (event) => event.kind === 31923
        ).length
    )
    .toBe(2)
  const updatedCalendar = uniquePublishedEvents(relay.publications)
    .filter((event) => event.kind === 31923)
    .at(-1)!
  expect(eventCoordinate(updatedCalendar)).toBe(
    eventCoordinate(initialCalendar)
  )
  expect(updatedCalendar.tags.find((tag) => tag[0] === "image")?.[1]).toBe(
    updatedBanner
  )
  expect(
    Number(updatedCalendar.tags.find((tag) => tag[0] === "start")?.[1])
  ).toBe(
    Number(initialCalendar.tags.find((tag) => tag[0] === "start")?.[1]) + 3_600
  )
  await expect(page.getByLabel(/^Start \(/)).toHaveValue("2030-06-01T11:00")

  const selling = page.getByRole("button", {
    name: "I'm also selling",
    exact: true,
  })
  await expect(selling).toBeEnabled()
  await selling.press("Enter")
  const stockMode = page.getByRole("combobox", {
    name: "Who holds the stock?",
    exact: true,
  })
  await expect(stockMode).toBeVisible()
  await stockMode.press("Enter")
  await expect(
    page.getByRole("option", { name: "Organizer-held pickup", exact: true })
  ).toBeDisabled()
  await page
    .getByRole("option", { name: "Merchant-managed pickup", exact: true })
    .press("Enter")
  await expect(stockMode).toHaveText("Merchant-managed pickup")
  await page.getByLabel("Public assignment").fill("Host booth")
  await page
    .getByRole("button", { name: "Approve merchant", exact: true })
    .click()
  await expect(page.getByText("Approved", { exact: true })).toBeVisible()
  expect(
    uniquePublishedEvents(relay.publications).some(
      (event) =>
        event.kind === 30409 &&
        event.tags.some(
          (tag) =>
            tag[0] === "merchant" &&
            tag[1] === ORGANIZER_PUBKEY &&
            tag[2] === "merchant_present"
        )
    )
  ).toBe(true)

  await gotoAs(page, merchantUrl, "/network", "merchant")
  await enablePrivateInbox(page)
  await page.goto(`${merchantUrl}${eventPath}`)
  relay.rejectKind(1059, true)
  await page
    .getByRole("button", { name: "Request to join", exact: true })
    .click()
  const participation = page.getByRole("region", {
    name: "Your participation",
    exact: true,
  })
  await expect(participation.getByRole("alert")).toBeVisible()
  await expect(
    participation.getByText("Participation saved; delivery needs retry.", {
      exact: true,
    })
  ).toBeVisible()
  await expect(
    participation.getByText("Approved to sell", { exact: true })
  ).toHaveCount(0)
  relay.rejectKind(1059, false)
  const pendingAck = relay.holdNextPublicationAck(
    (event) => event.kind === 1059
  )
  await page
    .getByRole("button", { name: "Retry saved participation", exact: true })
    .click()
  await pendingAck.captured
  await expect(
    participation.getByText("Sending participation…", { exact: true })
  ).toBeVisible()
  pendingAck.release()
  await expect(page.getByText("Request pending", { exact: true })).toBeVisible()
  await expect(participation.getByRole("alert")).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Request pending", { exact: true })).toBeVisible()
  expect(
    uniquePublishedEvents(relay.publications).some(
      (event) =>
        event.kind === 3841 &&
        event.tags.some((tag) => tag[0] === "p" && tag[1] === MERCHANT_PUBKEY)
    )
  ).toBe(false)
  const requests = uniquePrivatePublications(
    decryptPrivatePublications(relay.publications, ORGANIZER_SECRET)
  ).filter(
    (message) =>
      message.rumor.kind === 14 &&
      message.rumor.content.startsWith("Event Market participation v1\n")
  )
  expect(requests).toHaveLength(1)

  await gotoAs(page, merchantUrl, eventPath, "organizer")
  const pendingRequests = page.getByRole("region", {
    name: "Pending merchant requests",
    exact: true,
  })
  await expect(pendingRequests).toBeVisible()
  const requestsBox = await pendingRequests.boundingBox()
  const eventControlsBox = await page
    .getByRole("heading", { name: "Event controls", exact: true })
    .boundingBox()
  expect(requestsBox!.y).toBeLessThan(eventControlsBox!.y)
  await expect(
    page.getByRole("button", { name: "Decline request" })
  ).toBeVisible()
  const merchantRow = page.getByRole("group").filter({
    has: page.locator(`[id="assignment-${MERCHANT_PUBKEY}"]`),
  })
  await expect(merchantRow).toBeVisible()
  await merchantRow.getByLabel("Public assignment").fill("Booth 4")
  // The host's own seller row refreshes independently; target only the requester.
  const approveMerchant = merchantRow.getByRole("button", {
    name: "Approve merchant",
    exact: true,
  })
  await expect(approveMerchant).toBeEnabled()
  await approveMerchant.click()
  await expect(page.getByText("Approved", { exact: true })).toHaveCount(2)
  expect(
    uniquePublishedEvents(relay.publications).some(
      (event) => event.kind === 3841
    )
  ).toBe(true)

  await gotoAs(page, merchantUrl, eventPath, "merchant")
  await expect(
    page.getByText("Approved to sell", { exact: true })
  ).toBeVisible()
  await page
    .getByRole("link", { name: "Choose products for this event" })
    .click()
  await expect(page).toHaveURL(/\/products\?eventMarket=/)
  const assignmentPanel = page.getByRole("region", {
    name: "Occurrence assignments",
  })
  await assignmentPanel.getByRole("combobox", { name: "Event date" }).click()
  await page.getByRole("option", { name: /Community Makers Fair/ }).click()
  await assignmentPanel
    .getByRole("combobox", { name: "Product or variation" })
    .click()
  await page.getByRole("option", { name: MERCHANT_TEMPLATE_TITLE }).click()
  await assignmentPanel
    .getByRole("textbox", { name: "Pickup allocation" })
    .fill("2")
  await assignmentPanel.getByRole("button", { name: "Add to event" }).click()
  await expect
    .poll(() =>
      uniquePublishedEvents(relay.publications).some(
        (event) =>
          event.kind === 30410 &&
          event.pubkey === MERCHANT_PUBKEY &&
          event.tags.some(
            (tag) =>
              tag[0] === "a" &&
              tag[1] === `30402:${MERCHANT_PUBKEY}:${MERCHANT_TEMPLATE_D_TAG}`
          )
      )
    )
    .toBe(true)
  expect(
    uniquePublishedEvents(relay.publications).some(
      (event) =>
        event.kind === 30402 || event.kind === 30405 || event.kind === 30406
    )
  ).toBe(false)

  await gotoAs(page, marketUrl, eventPath, "buyer")
  const card = page
    .getByRole("listitem")
    .filter({ hasText: MERCHANT_TEMPLATE_TITLE })
  await expect(
    card.getByRole("heading", { name: MERCHANT_TEMPLATE_TITLE })
  ).toBeVisible()
  await card.getByRole("button", { name: /^Add .+ to cart$/ }).click()
  await expect(
    page.getByRole("button", { name: "Cart, 1 item", exact: true })
  ).toBeVisible()
  await gotoAs(page, marketUrl, "/cart", "buyer")
  await page.getByRole("button", { name: "Order", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible()
  await expect(page.getByText(/Booth 4/).first()).toBeVisible()
  await expect(page.getByLabel(/Street address/i)).toHaveCount(0)
})

for (const change of [
  "revoked",
  "closed",
  "untagged",
  "deleted",
  "price",
  "assignment",
  "roster",
] as const) {
  test(`direct event pickup verifies ${change} authority before adding and incrementing @market`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    const createdAt = Math.floor(Date.now() / 1_000) - 10

    const calendar = signEvent(ORGANIZER_SECRET, {
      ...buildEventMarketCalendarDraft({
        kind: 31923,
        dTag: `detail-${change}`,
        title: "Detail pickup",
        start: createdAt + 7_200,
        end: createdAt + 10_800,
      }),
      created_at: createdAt,
    })
    const market = signEvent(ORGANIZER_SECRET, {
      kind: 30409,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", `detail-${change}`],
        ["a", eventCoordinate(calendar)],
        ["event_market", "2", "open"],
        ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 12"],
      ],
    })
    const grant = signEvent(ORGANIZER_SECRET, {
      kind: 3841,
      created_at: createdAt,
      content: "",
      tags: [
        ["openmarkets", "event-market-auth", "1"],
        ["a", eventCoordinate(market)],
        ["p", MERCHANT_PUBKEY],
        ["state", "active"],
        ["seq", "0"],
        ["alt", "Open Markets event merchant authorization"],
      ],
    })
    const product = signEvent(MERCHANT_SECRET, {
      kind: 30402,
      created_at: createdAt,
      content: "Pickup soap",
      tags: [
        ["d", `detail-${change}`],
        ["title", "Pickup soap"],
        [
          "image",
          "https://cdn.conduit.market/conduit-test/template-product.svg",
        ],
        ["price", "0", "SAT"],
        ["type", "simple", "physical"],
        ["stock", "5"],
        ["a", eventCoordinate(market)],
      ],
    })
    relay.seed(
      calendar,
      market,
      grant,
      product,
      signedAssignment(market, calendar, product)
    )
    await gotoAs(
      page,
      marketUrl,
      `/products/${encodeURIComponent(eventCoordinate(product))}`,
      "buyer",
      { event: eventCoordinate(market) }
    )
    await expect(
      page.getByRole("button", { name: "Open account menu", exact: true })
    ).toBeVisible()
    const add = page.getByRole("button", { name: /^Add (1 to cart|more)/ })
    await expect(add).toBeEnabled()
    // Seed new signed evidence after render. No subscription or manual refresh
    // gives the page advance notice; the click must verify the current terms.
    if (change === "revoked") {
      relay.seed(
        signEvent(ORGANIZER_SECRET, {
          ...grant,
          created_at: createdAt + 1,
          tags: grant.tags
            .map((tag) =>
              tag[0] === "state"
                ? ["state", "revoked"]
                : tag[0] === "seq"
                  ? ["seq", "1"]
                  : tag
            )
            .concat([["auth_parent", grant.id]]),
        })
      )
    } else if (
      change === "closed" ||
      change === "assignment" ||
      change === "roster"
    ) {
      relay.seed(
        signEvent(ORGANIZER_SECRET, {
          ...market,
          created_at: createdAt + 1,
          tags: market.tags
            .map((tag) =>
              change === "closed" && tag[0] === "event_market"
                ? ["event_market", "2", "closed"]
                : change === "assignment" && tag[0] === "merchant"
                  ? [
                      "merchant",
                      MERCHANT_PUBKEY,
                      "merchant_present",
                      "Booth 14",
                    ]
                  : tag
            )
            .concat(
              [["prev", market.id]],
              change === "roster"
                ? [["merchant", BUYER_PUBKEY, "merchant_present", "Booth 15"]]
                : []
            ),
        })
      )
    } else if (change === "deleted") {
      relay.seed(
        signEvent(MERCHANT_SECRET, {
          kind: 5,
          created_at: createdAt + 1,
          content: "",
          tags: [
            ["a", eventCoordinate(product)],
            ["k", "30402"],
          ],
        })
      )
    } else {
      relay.seed(
        signEvent(MERCHANT_SECRET, {
          ...product,
          created_at: createdAt + 1,
          tags:
            change === "untagged"
              ? product.tags.filter((tag) => tag[0] !== "a")
              : product.tags.map((tag) =>
                  tag[0] === "price" ? ["price", "1", "SAT"] : tag
                ),
        })
      )
    }
    await add.click()
    if (change === "roster") {
      await expect(
        page.getByRole("button", { name: "Cart, 1 item", exact: true })
      ).toBeVisible()
      await add.click()
      await expect(
        page.getByRole("button", { name: "Cart, 2 items", exact: true })
      ).toBeVisible()
      relay.seed(
        signEvent(ORGANIZER_SECRET, {
          ...grant,
          created_at: createdAt + 2,
          tags: grant.tags
            .map((tag) =>
              tag[0] === "state"
                ? ["state", "revoked"]
                : tag[0] === "seq"
                  ? ["seq", "1"]
                  : tag
            )
            .concat([["auth_parent", grant.id]]),
        })
      )
      await add.click()
      await expect(
        page.getByRole("alert").filter({
          hasText: "This product is not currently available for event pickup.",
        })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Cart, 2 items", exact: true })
      ).toBeVisible()
    } else {
      await expect(
        page.getByRole("alert").filter({
          hasText:
            /currently available for event pickup|details changed|Pickup terms changed/,
        })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: /^Cart, [1-9]\d* items?/ })
      ).toHaveCount(0)
      if (change === "revoked" || change === "closed") {
        await expect(
          page.getByRole("heading", {
            name: "Pickup soap",
            exact: true,
          })
        ).toBeVisible()
        await expect(
          page.getByRole("alert").filter({
            hasText:
              "This product is not currently available for event pickup.",
          })
        ).toBeVisible()
      }
    }
  })
}

test("event variation pickup rejects changed and deleted listings before adding or incrementing @market", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "future-handoff-fair",
      title: "Future Handoff Fair",
      start: createdAt + 7_200,
      end: createdAt + 10_800,
      locations: ["Town Hall"],
    }),
    created_at: createdAt,
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "future-handoff-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT_PUBKEY, "merchant_present", "Pickup Desk"],
    ],
  })
  const grant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(market)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  const shipping = signEvent(MERCHANT_SECRET, {
    kind: 30406,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "detail-shipping"],
      ["title", "Shop shipping"],
      ["price", "200", "SAT"],
      ["country", "US"],
      ["service", "shipping"],
    ],
  })
  const product = (name: string, dTag: string) =>
    signEvent(MERCHANT_SECRET, {
      kind: 30402,
      created_at: createdAt,
      content: name,
      tags: [
        ["d", dTag],
        ["title", name],
        ["price", "0", "SAT"],
        [
          "type",
          dTag === "future-handoff-soap" ? "variable" : "variation",
          "physical",
        ],
        ...(dTag === "future-handoff-candle"
          ? [
              ["a", `30402:${MERCHANT_PUBKEY}:future-handoff-soap`],
              ["spec", "Size", "Large"],
            ]
          : []),
        ["stock", "5"],
        ["shipping_option", eventCoordinate(shipping)],
        [
          "image",
          "https://cdn.conduit.market/conduit-test/template-product.svg",
        ],
        ["t", "market"],
        ["t", "merchant"],
        ["t", "handmade"],
        ["a", eventCoordinate(market)],
      ],
    })
  const soap = product("Future handoff soap", "future-handoff-soap")
  const candle = product("Future handoff candle", "future-handoff-candle")
  relay.seed(
    calendar,
    market,
    grant,
    soap,
    candle,
    shipping,
    signedAssignment(market, calendar, soap, 5, ["pickup", "shipping"]),
    signedAssignment(market, calendar, candle, 5, ["pickup", "shipping"]),
    createInboxDeclaration("organizer", createdAt),
    createInboxDeclaration("merchant", createdAt),
    createInboxDeclaration("buyer", createdAt)
  )

  await gotoAs(
    page,
    marketUrl,
    `/products/${encodeURIComponent(eventCoordinate(soap))}`,
    "buyer",
    { event: eventCoordinate(market) }
  )
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveCount(0)
  const add = page.getByRole("button", { name: /^Add (1 to cart|more)/ })
  await expect(add).toBeEnabled()
  const revise = (offset: number) =>
    signEvent(MERCHANT_SECRET, {
      ...candle,
      created_at: createdAt + offset,
      tags: candle.tags.map((tag) =>
        tag[0] === "price" ? ["price", String(offset), "SAT"] : tag
      ),
    })
  relay.seed(revise(1))
  await add.click()
  await expect(
    page.getByRole("alert").filter({ hasText: "Product details changed" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Cart, 1 item", exact: true })
  ).toHaveCount(0)
  await expect(add).toBeEnabled()
  await add.click()
  await expect(
    page.getByRole("button", { name: "Cart, 1 item", exact: true })
  ).toBeVisible()

  relay.seed(revise(2))
  await add.click()
  await expect(
    page.getByRole("alert").filter({ hasText: "Product details changed" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Cart, 1 item", exact: true })
  ).toBeVisible()
  await expect(add).toBeEnabled()
  await add.click()
  await expect(
    page.getByRole("button", { name: "Cart, 2 items", exact: true })
  ).toBeVisible()

  const deletion = signEvent(MERCHANT_SECRET, {
    kind: 5,
    created_at: createdAt + 3,
    content: "",
    tags: [
      ["a", eventCoordinate(candle)],
      ["k", "30402"],
    ],
  })
  relay.seed(deletion)
  const beforeDeletionRead = relay.requests.length
  await add.click()
  await expect(
    page.getByRole("alert").filter({
      hasText: "This product is not currently available for event pickup",
    })
  ).toBeVisible()
  await gotoAs(page, marketUrl, "/cart", "buyer")
  await expect(
    page.getByRole("button", { name: "Cart, 2 items", exact: true })
  ).toBeVisible()
  expect(
    relay.requests
      .slice(beforeDeletionRead)
      .some((request) => request.matchedEventIds.includes(deletion.id))
  ).toBe(true)
})

test("saved unsigned creation restores editable details and publishes the same Event Market @merchant", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  const creation = savedCreationFixture()
  await storeSavedCreation(page, creation)
  await expect(page.getByLabel("Event title")).toBeEnabled()
  await expect(page.getByLabel("Description")).toBeEnabled()
  await expect(
    page.getByText("Description must be 1,000 characters or fewer.", {
      exact: true,
    })
  ).toBeVisible()
  await expect(page.getByLabel("Description")).toHaveAttribute(
    "aria-invalid",
    "true"
  )
  await page.getByLabel("Event title").fill("Recovered fair")
  await page
    .getByLabel("Description")
    .fill("Meet local merchants.\nBring your friends.")
  await page.getByLabel("Location", { exact: true }).fill("Town square")
  await page.getByRole("button", { name: "Add by URL", exact: true }).click()
  await page
    .getByLabel("Banner URL")
    .fill("https://cdn.conduit.market/conduit-test/template-product.svg")
  await page.getByRole("combobox", { name: "Time zone", exact: true }).click()
  await page
    .getByRole("option", { name: "America/New York", exact: true })
    .click()
  await page.getByRole("button", { name: "Publish event", exact: true }).click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  const published = uniquePublishedEvents(relay.publications).filter((event) =>
    [31923, 30409].includes(event.kind)
  )
  expect(published.length).toBe(2)
  expect(
    published.some(
      (event) => eventCoordinate(event) === creation.marketCoordinate
    )
  ).toBe(true)
  expect(published.find((event) => event.kind === 31923)?.tags).toContainEqual([
    "start_tzid",
    "America/New_York",
  ])
  expect(
    await page.evaluate(
      (owner) =>
        localStorage.getItem(
          `conduit:future-event-market-creation:v1:${owner}`
        ) === null,
      ORGANIZER_PUBKEY
    )
  ).toBe(true)
})

test("invalid new description never freezes a draft and can be corrected before publication @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await page.getByLabel("Event title").fill("New corrected fair")
  await page.getByLabel("Description").fill("x".repeat(1_001))
  await page.getByLabel("Location", { exact: true }).fill("Town hall")
  await page.getByLabel("Start", { exact: true }).fill("2030-06-01T10:00")
  await page.getByLabel("End", { exact: true }).fill("2030-06-01T16:00")
  await page.getByRole("button", { name: "Publish event", exact: true }).click()
  await expect(page.getByLabel("Description")).toBeEnabled()
  expect(
    await page.evaluate(
      (owner) =>
        localStorage.getItem(
          `conduit:future-event-market-creation:v1:${owner}`
        ) === null,
      ORGANIZER_PUBKEY
    )
  ).toBe(true)
  expect(
    uniquePublishedEvents(relay.publications).some((event) =>
      [31923, 30409].includes(event.kind)
    )
  ).toBe(false)
  await page.getByLabel("Description").fill("Line one\nLine two")
  await page.getByRole("button", { name: "Publish event", exact: true }).click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
})

test("unsigned creation can be discarded after reload before starting a new event @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await storeSavedCreation(page, savedCreationFixture())
  await page
    .getByRole("button", {
      name: "Discard draft and start new event",
      exact: true,
    })
    .click()
  await page.getByRole("button", { name: "Keep draft", exact: true }).click()
  await expect(
    page.getByRole("button", {
      name: "Discard draft and start new event",
      exact: true,
    })
  ).toBeFocused()
  await expect(page.getByLabel("Event title")).toHaveValue(
    "Saved community fair"
  )
  await page
    .getByRole("button", {
      name: "Discard draft and start new event",
      exact: true,
    })
    .click()
  await page.getByRole("button", { name: "Discard draft", exact: true }).click()
  await expect(page.getByLabel("Event title")).toHaveValue("")
  await page.reload()
  await expect(page.getByLabel("Event title")).toHaveValue("")
  expect(
    await page.evaluate(
      (owner) =>
        localStorage.getItem(
          `conduit:future-event-market-creation:v1:${owner}`
        ) === null,
      ORGANIZER_PUBKEY
    )
  ).toBe(true)
  expect(
    uniquePublishedEvents(relay.publications).some((event) =>
      [31923, 30409].includes(event.kind)
    )
  ).toBe(false)
})

test("signed creation retries retained bytes with invalid saved text then permits ordinary editing @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  const creation = savedCreationFixture()
  const signed = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: `${creation.dTag}-calendar`,
      title: creation.form.title,
      summary: "Already signed description",
      start: 1_906_538_400,
      end: 1_906_560_000,
      startTzid: "UTC",
      locations: [creation.form.eventLocation],
    }),
    created_at: Math.floor(Date.now() / 1_000) - 10,
  })
  relay.seed(signed)
  // Model retention-before-pointer-save interruption. The missing ID is not permission to discard.
  await page.evaluate(
    async ({ saved, event }) => {
      localStorage.setItem(
        `conduit:future-event-market-creation:v1:${saved.organizerPubkey}`,
        JSON.stringify(saved)
      )
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () =>
          reject(new Error("Fixture database could not be opened"))
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "eventMarketRosterEvidence",
            "readwrite"
          )
          transaction.objectStore("eventMarketRosterEvidence").put({
            id: `${saved.marketCoordinate}:${event.id}`,
            marketCoordinate: saved.marketCoordinate,
            signedEvent: event,
            cachedAt: Date.now(),
          })
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => {
            database.close()
            reject(new Error("Fixture evidence could not be saved"))
          }
        }
      })
    },
    { saved: creation, event: signed }
  )
  await page.reload()
  await expect(page.getByLabel("Description")).toBeDisabled()
  await expect(
    page.getByRole("button", {
      name: "Discard draft and start new event",
      exact: true,
    })
  ).toHaveCount(0)
  await page
    .getByRole("button", { name: "Retry saved event", exact: true })
    .click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  const initial = uniquePublishedEvents(relay.publications).filter((event) =>
    [31923, 30409].includes(event.kind)
  )
  expect(initial.length).toBe(2)
  expect(initial.find((event) => event.kind === 31923)?.id === signed.id).toBe(
    true
  )
  await page
    .locator("#future-edit-summary")
    .fill("Corrected description\nAnother paragraph")
  await page
    .getByRole("button", { name: "Save event details", exact: true })
    .click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications).filter(
          (event) => event.kind === 31923
        ).length
    )
    .toBe(2)
  expect(
    uniquePublishedEvents(relay.publications)
      .filter((event) => event.kind === 31923)
      .every((event) => eventCoordinate(event) === creation.calendarCoordinate)
  ).toBe(true)
})

test("unsigned saved series can return to editing and publish corrected details @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  const saved = savedCreationFixture()
  await page.evaluate((creation) => {
    localStorage.setItem(
      `conduit:future-event-market-series-draft:1:${creation.organizerPubkey}`,
      JSON.stringify({
        version: 1,
        organizerPubkey: creation.organizerPubkey,
        marketDTag: creation.dTag,
        scheduleDTag: `${creation.dTag}-schedule`,
        occurrenceDTags: [`${creation.dTag}-date-1`],
        form: creation.form,
        dateRows: [
          { id: "first", start: creation.form.start, end: creation.form.end },
        ],
      })
    )
  }, saved)
  await page.reload()
  await page
    .getByRole("button", { name: "Edit saved draft", exact: true })
    .click()
  await expect(page.getByLabel("Description")).toBeEnabled()
  await page.getByLabel("Description").fill("A corrected series\nAll welcome")
  await page.getByRole("button", { name: "Publish event", exact: true }).click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  expect(
    uniquePublishedEvents(relay.publications).filter((event) =>
      [31923, 31924, 30409].includes(event.kind)
    ).length
  ).toBe(3)
})

test("draft discard refuses a competing browser creation lock and can retry after release @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await storeSavedCreation(page, savedCreationFixture())
  await expect(page.getByLabel("Event title")).toBeEnabled()
  await page.evaluate(
    (owner) =>
      new Promise<void>((resolve) => {
        void navigator.locks.request(
          `conduit:event-market-creation:${owner}`,
          async () => {
            const released = new Promise<void>((done) =>
              window.addEventListener(
                "conduit-test-release-creation",
                () => done(),
                { once: true }
              )
            )
            resolve()
            await released
          }
        )
      }),
    ORGANIZER_PUBKEY
  )
  try {
    await page
      .getByRole("button", {
        name: "Discard draft and start new event",
        exact: true,
      })
      .click()
    await page
      .getByRole("button", { name: "Discard draft", exact: true })
      .click()
    await expect(
      page.getByText(
        "Another tab is finishing this Event Market. Wait for it before continuing.",
        { exact: true }
      )
    ).toBeVisible()
    expect(
      await page.evaluate(
        (owner) =>
          localStorage.getItem(
            `conduit:future-event-market-creation:v1:${owner}`
          ) !== null,
        ORGANIZER_PUBKEY
      )
    ).toBe(true)
  } finally {
    await page.evaluate(() =>
      window.dispatchEvent(new Event("conduit-test-release-creation"))
    )
  }
  await page
    .getByRole("button", {
      name: "Discard draft and start new event",
      exact: true,
    })
    .click()
  await page.getByRole("button", { name: "Discard draft", exact: true }).click()
  await expect(page.getByLabel("Event title")).toHaveValue("")
})

test("new creation does not stage a plan while another tab owns the creation lock @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await page.getByLabel("Event title").fill("Coordinated fair")
  await page.getByLabel("Description").fill("A public community fair")
  await page.getByLabel("Location", { exact: true }).fill("Town hall")
  await page.getByLabel("Start", { exact: true }).fill("2030-06-01T10:00")
  await page.getByLabel("End", { exact: true }).fill("2030-06-01T16:00")
  await page.evaluate(
    (owner) =>
      new Promise<void>((resolve) => {
        void navigator.locks.request(
          `conduit:event-market-creation:${owner}`,
          async () => {
            const released = new Promise<void>((done) =>
              window.addEventListener(
                "conduit-test-release-creation",
                () => done(),
                { once: true }
              )
            )
            resolve()
            await released
          }
        )
      }),
    ORGANIZER_PUBKEY
  )
  try {
    await page
      .getByRole("button", { name: "Publish event", exact: true })
      .click()
    await expect(
      page.getByText(
        "Another tab is finishing this Event Market. Wait for it before continuing.",
        { exact: true }
      )
    ).toBeVisible()
    expect(
      await page.evaluate(
        (owner) =>
          localStorage.getItem(
            `conduit:future-event-market-creation:v1:${owner}`
          ) === null,
        ORGANIZER_PUBKEY
      )
    ).toBe(true)
    expect(
      uniquePublishedEvents(relay.publications).some((event) =>
        [31923, 31924, 30409].includes(event.kind)
      )
    ).toBe(false)
  } finally {
    await page.evaluate(() =>
      window.dispatchEvent(new Event("conduit-test-release-creation"))
    )
  }
  await page.getByRole("button", { name: "Publish event", exact: true }).click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
})

for (const series of [false, true])
  test(`stale ${series ? "series" : "single-event"} form cannot recreate a plan completed by another tab @merchant`, async ({
    page,
  }) => {
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    await gotoAs(page, merchantUrl, "/events/new", "organizer")
    const saved = savedCreationFixture("A valid public description")
    await page.evaluate(
      ({ creation, series }) => {
        const key = series
          ? `conduit:future-event-market-series-draft:1:${creation.organizerPubkey}`
          : `conduit:future-event-market-creation:v1:${creation.organizerPubkey}`
        const value = series
          ? {
              version: 1,
              organizerPubkey: creation.organizerPubkey,
              marketDTag: creation.dTag,
              scheduleDTag: `${creation.dTag}-schedule`,
              occurrenceDTags: [`${creation.dTag}-date-1`],
              form: creation.form,
              dateRows: [
                {
                  id: "first",
                  start: creation.form.start,
                  end: creation.form.end,
                },
              ],
              signedEventIds: ["a".repeat(64)],
            }
          : { ...creation, calendarEventId: "a".repeat(64) }
        localStorage.setItem(key, JSON.stringify(value))
      },
      { creation: saved, series }
    )
    await page.reload()
    const retry = page.getByRole("button", {
      name: series ? "Resume publishing" : "Retry saved event",
      exact: true,
    })
    await expect(retry).toBeEnabled()
    await page.evaluate(
      ({ owner, series }) =>
        localStorage.removeItem(
          series
            ? `conduit:future-event-market-series-draft:1:${owner}`
            : `conduit:future-event-market-creation:v1:${owner}`
        ),
      { owner: ORGANIZER_PUBKEY, series }
    )
    await retry.click()
    await expect(
      page.getByText(
        series
          ? "The saved series changed in another tab. Reload before continuing."
          : "The saved creation changed in another tab. Reload before continuing.",
        { exact: true }
      )
    ).toBeVisible()
    expect(
      uniquePublishedEvents(relay.publications).some((event) =>
        [31923, 31924, 30409].includes(event.kind)
      )
    ).toBe(false)
  })

for (const legacyHistory of [false, true])
  test(`series with ${legacyHistory ? "unknown legacy history" : "pinned missing signatures"} cannot discard or sign replacements @merchant`, async ({
    page,
  }) => {
    const relay = createRelayHarness()
    await installSyntheticEnvironment(page, relay)
    await gotoAs(page, merchantUrl, "/events/new", "organizer")
    const saved = savedCreationFixture("A valid series description")
    await page.evaluate(
      ({ creation, legacyHistory }) => {
        localStorage.setItem(
          `conduit:future-event-market-series-draft:1:${creation.organizerPubkey}`,
          JSON.stringify({
            version: 1,
            organizerPubkey: creation.organizerPubkey,
            marketDTag: creation.dTag,
            scheduleDTag: `${creation.dTag}-schedule`,
            occurrenceDTags: [`${creation.dTag}-date-1`],
            form: creation.form,
            dateRows: [
              {
                id: "first",
                start: creation.form.start,
                end: creation.form.end,
              },
            ],
            ...(legacyHistory ? {} : { signedEventIds: ["a".repeat(64)] }),
          })
        )
      },
      { creation: saved, legacyHistory }
    )
    await page.reload()
    await expect(
      page.getByRole("button", {
        name: "Discard draft and start new event",
        exact: true,
      })
    ).toHaveCount(0)
    await page
      .getByRole("button", { name: "Resume publishing", exact: true })
      .click()
    await expect(
      page.getByText(
        legacyHistory
          ? "The saved series has no retained signature history. Keep its plan and restore the original browser storage before retrying."
          : "An exact saved series signature is missing. Keep the saved plan for recovery.",
        { exact: true }
      )
    ).toBeVisible()
    expect(
      uniquePublishedEvents(relay.publications).some((event) =>
        [31923, 31924, 30409].includes(event.kind)
      )
    ).toBe(false)
  })

test("legacy signed series retries repeated delivery failures in the same page @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  const saved = savedCreationFixture("Retained series description")
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: `${saved.dTag}-date-1`,
      title: saved.form.title,
      summary: saved.form.summary,
      start: 1_906_538_400,
      end: 1_906_560_000,
      startTzid: "UTC",
      endTzid: "UTC",
      locations: [saved.form.eventLocation],
    }),
    created_at: Math.floor(Date.now() / 1000) - 10,
  })
  relay.seed(calendar)
  await page.evaluate(
    async ({ saved, calendar }) => {
      localStorage.setItem(
        `conduit:future-event-market-series-draft:1:${saved.organizerPubkey}`,
        JSON.stringify({
          version: 1,
          organizerPubkey: saved.organizerPubkey,
          marketDTag: saved.dTag,
          scheduleDTag: `${saved.dTag}-schedule`,
          occurrenceDTags: [`${saved.dTag}-date-1`],
          form: saved.form,
          dateRows: [
            { id: "first", start: saved.form.start, end: saved.form.end },
          ],
        })
      )
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () =>
          reject(new Error("Fixture database unavailable"))
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "eventMarketRosterEvidence",
            "readwrite"
          )
          transaction.objectStore("eventMarketRosterEvidence").put({
            id: `${saved.marketCoordinate}:${calendar.id}`,
            marketCoordinate: saved.marketCoordinate,
            signedEvent: calendar,
            cachedAt: Date.now(),
          })
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => {
            database.close()
            reject(new Error("Fixture persistence failed"))
          }
        }
      })
    },
    { saved, calendar }
  )
  await page.reload()
  const resume = page.getByRole("button", {
    name: "Resume publishing",
    exact: true,
  })
  relay.rejectKind(31923, true)
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = relay.publications.filter(
      ({ event }) => event.kind === 31923
    ).length
    await expect(resume).toBeEnabled()
    await resume.click()
    await expect
      .poll(
        () =>
          relay.publications.filter(({ event }) => event.kind === 31923).length
      )
      .toBeGreaterThan(before)
    await expect(resume).toBeEnabled()
  }
  relay.rejectKind(31923, false)
  await resume.click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  const dates = relay.publications.filter(({ event }) => event.kind === 31923)
  expect(dates.length).toBeGreaterThanOrEqual(3)
  expect(
    dates.every(({ event }) => sameSignedPublicEvent(event, calendar))
  ).toBe(true)
  expect(
    uniquePublishedEvents(relay.publications).filter(
      (event) => event.kind === 31924
    )
  ).toHaveLength(1)
  expect(
    uniquePublishedEvents(relay.publications).filter(
      (event) => event.kind === 30409
    )
  ).toHaveLength(1)
})

test("retention before a failed creation pointer save exposes exact retry without reload @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  const saved = savedCreationFixture("Signed recovery description")
  await storeSavedCreation(page, saved)
  await expect(page.getByLabel("Description")).toBeEnabled()
  await page.evaluate((owner) => {
    const original = Storage.prototype.setItem
    let fail = true
    Storage.prototype.setItem = function (key, value) {
      if (
        fail &&
        key === `conduit:future-event-market-creation:v1:${owner}` &&
        JSON.parse(value).calendarEventId
      ) {
        fail = false
        throw new DOMException(
          "Synthetic pointer save failure",
          "QuotaExceededError"
        )
      }
      return original.call(this, key, value)
    }
  }, ORGANIZER_PUBKEY)
  await page.getByRole("button", { name: "Publish event", exact: true }).click()
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Synthetic pointer save failure" })
  ).toBeVisible()
  expect(
    relay.publications.filter(({ event }) => event.kind === 31923)
  ).toHaveLength(0)
  const retained = await page.evaluate(
    async (coordinate) =>
      new Promise<SignedEvent>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () =>
          reject(new Error("Fixture database unavailable"))
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "eventMarketRosterEvidence",
            "readonly"
          )
          const rows = transaction
            .objectStore("eventMarketRosterEvidence")
            .getAll()
          rows.onsuccess = () => {
            const event = rows.result.find(
              (row) =>
                row.marketCoordinate === coordinate &&
                row.signedEvent.kind === 31923
            )?.signedEvent
            if (!event) reject(new Error("Retained calendar unavailable"))
            else resolve(event)
          }
          transaction.oncomplete = () => database.close()
          transaction.onerror = () => {
            database.close()
            reject(new Error("Fixture read failed"))
          }
        }
      }),
    saved.marketCoordinate
  )
  await expect(page.getByLabel("Description")).toBeDisabled()
  await expect(
    page.getByRole("button", {
      name: "Discard draft and start new event",
      exact: true,
    })
  ).toHaveCount(0)
  const retry = page.getByRole("button", {
    name: "Retry saved event",
    exact: true,
  })
  await expect(retry).toBeEnabled()
  await retry.click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  const dates = relay.publications.filter(({ event }) => event.kind === 31923)
  expect(dates.length).toBeGreaterThan(0)
  expect(
    dates.every(({ event }) => sameSignedPublicEvent(event, retained))
  ).toBe(true)
  expect(
    uniquePublishedEvents(relay.publications).filter(
      (event) => event.kind === 30409
    )
  ).toHaveLength(1)
})

function signedBuyerOrder(
  order: Record<string, unknown> & { id: string },
  createdAt: number,
  extraTags: readonly string[][] = []
): SignedEvent[] {
  const draft = {
    kind: 16,
    pubkey: BUYER_PUBKEY,
    created_at: createdAt,
    tags: [
      ["p", MERCHANT_PUBKEY],
      ["type", "order"],
      ["order", order.id],
      ...extraTags,
    ],
    content: JSON.stringify(order),
  }
  const rumor = { ...draft, id: getEventHash(draft) }
  return [MERCHANT_PUBKEY, BUYER_PUBKEY].map(
    (recipient) =>
      createWrap(
        signEvent(BUYER_SECRET, {
          kind: 13,
          created_at: createdAt,
          tags: [],
          content: nip44.v2.encrypt(
            JSON.stringify(rumor),
            nip44.v2.utils.getConversationKey(BUYER_SECRET, recipient)
          ),
        }),
        recipient
      ) as SignedEvent
  )
}
function signedBuyerPaymentReport(orderId: string): SignedEvent[] {
  const at = Math.floor(Date.now() / 1000)
  const draft = {
    kind: 16,
    pubkey: BUYER_PUBKEY,
    created_at: at,
    tags: [
      ["p", MERCHANT_PUBKEY],
      ["type", "payment_proof"],
      ["order", orderId],
    ],
    content: JSON.stringify({
      orderId,
      rail: "lightning",
      amount: 2500,
      currency: "SATS",
      zapRequestId: "1".repeat(64),
      zapReceiptId: "2".repeat(64),
    }),
  }
  const rumor = { ...draft, id: getEventHash(draft) }
  return [MERCHANT_PUBKEY, BUYER_PUBKEY].map(
    (recipient) =>
      createWrap(
        signEvent(BUYER_SECRET, {
          kind: 13,
          created_at: at,
          tags: [],
          content: nip44.v2.encrypt(
            JSON.stringify(rumor),
            nip44.v2.utils.getConversationKey(BUYER_SECRET, recipient)
          ),
        }),
        recipient
      ) as SignedEvent
  )
}

async function occurrenceInventory(
  page: Page,
  productCoordinate: string,
  orderId: string,
  nowMs?: number
) {
  return page.evaluate(
    async ({ root, productCoordinate, orderId, nowMs }) => {
      const { db } = await import(`${root}/db/index.ts`)
      const { readMerchantInventoryAvailability } = await import(
        `${root}/protocol/merchant-inventory.ts`
      )
      const { readMerchantOccurrenceInventory } = await import(
        `${root}/protocol/merchant-occurrence-workflow.ts`
      )
      await readMerchantOccurrenceInventory(productCoordinate.split(":")[1])
      const state = await readMerchantInventoryAvailability(
        db,
        productCoordinate,
        nowMs
      )
      const saved = await db.merchantInventoryAcceptedOrders.get(orderId)
      return {
        stock: state.product.stock,
        allocation: state.assignments[0]?.inventory.quantity,
        ordinaryAvailable: state.ordinaryAvailable,
        storedEnd: state.assignments[0]?.occurrenceEndMs,
        acceptedOrders: await db.merchantInventoryAcceptedOrders.count(),
        savedOrder: !!saved,
      }
    },
    {
      root: browserSourceRoot("packages/core/src"),
      productCoordinate,
      orderId,
      nowMs,
    }
  )
}

async function rescheduleSameEvent(
  page: Page,
  relay: RelayHarness,
  marketNaddr: string,
  start: number,
  end: number
) {
  await gotoAs(page, merchantUrl, "/events/" + marketNaddr, "organizer")
  await page.locator("#future-edit-summary").fill("Updated market schedule")
  await page
    .locator("#future-edit-start")
    .fill(new Date(start * 1000).toISOString().slice(0, 16))
  await page
    .locator("#future-edit-end")
    .fill(new Date(end * 1000).toISOString().slice(0, 16))
  const from = relay.publications.length
  await page
    .getByRole("button", { name: "Save event details", exact: true })
    .click()
  const updates = () =>
    uniquePublishedEvents(relay.publications.slice(from)).filter(
      (event) => event.kind === 31923
    )
  await expect.poll(() => updates().length).toBe(1)
  return Number(updates()[0]!.tags.find((tag) => tag[0] === "end")![1]) * 1000
}

async function acceptPickupOrder(
  page: Page,
  orderId: string,
  interruptSigning = false
) {
  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: orderId })
  if (interruptSigning)
    await page.evaluate(
      (key) => localStorage.setItem(key, "1"),
      SYNTHETIC_SIGNER_UNAVAILABLE_KEY
    )
  const pending = page.getByRole("button", { name: /^(Sending|Recording)…$/ })
  const saved = page.getByRole("button", {
    name: "Retry acceptance publication",
    exact: true,
  })
  await page.getByRole("button", { name: "Accept order", exact: true }).click()
  // A click starts the async action; settle it before checking durable readback.
  // Accept the saved control as the start signal when the action finishes quickly.
  await pending.or(saved).first().waitFor({ state: "visible" })
  await pending.waitFor({ state: "hidden" })
  if (interruptSigning)
    await expect(
      page.getByText(
        "Accepted locally. The buyer notification and inventory publication can be retried.",
        { exact: true }
      )
    ).toBeVisible()
  // This control exists only after the exact acceptance is read from storage.
  // Publication can replace the transient notice before the next render.
  await expect(saved).toBeVisible()
  if (interruptSigning)
    await page.evaluate(
      (key) => localStorage.removeItem(key),
      SYNTHETIC_SIGNER_UNAVAILABLE_KEY
    )
  await page.reload()
  await expect(
    page.getByText(/Accepted inventory is saved on this device/)
  ).toBeVisible()
}

test("paid pickup keeps its original receipt and stock after same-event rescheduling @market @merchant @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const { relay, createdAt, calendar, product, order, marketNaddr } =
    await createAssignedPickupOrder(page)
  await acceptPickupOrder(page, order.id)
  relay.seed(
    ...signedHistoricalAcceptedStatus(
      order.id,
      "paid",
      Math.floor(Date.now() / 1000) + 2
    )
  )
  await page.reload()
  const complete = page.getByRole("button", {
    name: "Mark picked up / complete",
    exact: true,
  })
  await complete.waitFor({ state: "visible" })
  await expect(complete).toBeEnabled()
  const before = await occurrenceInventory(
    page,
    eventCoordinate(product),
    order.id
  )
  expect(before).toMatchObject({
    stock: 8,
    allocation: 1,
    acceptedOrders: 1,
    savedOrder: true,
  })
  const newStart = createdAt + 93_600
  await rescheduleSameEvent(
    page,
    relay,
    marketNaddr,
    newStart,
    createdAt + 97_200
  )
  await page.clock.setFixedTime(new Date((newStart + 600) * 1000))
  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  const from = relay.publications.length
  await expect(complete).toBeEnabled()
  // Use the same focused activation as the free-pickup reconciliation case.
  await complete.press("Enter")
  await complete.waitFor({ state: "hidden" })
  await page
    .getByRole("button", { name: /^(Sending|Recording)…$/ })
    .waitFor({ state: "hidden" })
  await expect
    .poll(
      () =>
        uniquePrivatePublications(
          decryptPrivatePublications(relay.publications, BUYER_SECRET, from)
        ).filter(
          (message) =>
            rumorType(message.rumor) === "status_update" &&
            JSON.parse(message.rumor.content).status === "complete"
        ).length
    )
    .toBe(1)
  expect(
    await occurrenceInventory(page, eventCoordinate(product), order.id)
  ).toMatchObject({ stock: 8, allocation: 1, acceptedOrders: 1 })
  const historical = await page.evaluate(
    async ({ root, orderId, calendarId }) => {
      const { db } = await import(`${root}/db/index.ts`)
      const saved = await db.merchantInventoryAcceptedOrders.get(orderId)
      const { openMerchantAcceptanceEvidence } = await import(
        `${root}/protocol/merchant-acceptance-privacy.ts`
      )
      return (
        JSON.parse(await openMerchantAcceptanceEvidence(saved)).items[0]
          .fulfillment.calendar.eventId === calendarId
      )
    },
    {
      root: browserSourceRoot("packages/core/src"),
      orderId: order.id,
      calendarId: calendar.id,
    }
  )
  expect(historical).toBe(true)
  await gotoAs(page, marketUrl, "/orders", "buyer", { order: order.id })
  await expect(page.getByTestId("future-market-order-pickup")).toBeVisible()
})

test("saved prepaid acceptance publication resumes after reload @merchant @occurrence-orders", async ({
  page,
}, info) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000) - 10
  const start = createdAt + 7_200
  const end = createdAt + 10_800
  const calendar = signEvent(ORGANIZER_SECRET, {
    ...buildEventMarketCalendarDraft({
      kind: 31923,
      dTag: "prepaid-restore-fair",
      title: "Prepaid restore fair",
      start,
      end,
      locations: ["100 Public Square"],
    }),
    created_at: createdAt,
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "prepaid-restore-fair"],
      ["a", eventCoordinate(calendar)],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT_PUBKEY, "merchant_present", "Booth 7"],
    ],
  })
  const grant = signEvent(ORGANIZER_SECRET, {
    kind: 3841,
    created_at: createdAt,
    content: "",
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", eventCoordinate(market)],
      ["p", MERCHANT_PUBKEY],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
  })
  const product = createMerchantTemplateProductEvent(createdAt)
  const assignment = signedAssignment(market, calendar, product, 2)
  const snapshot = (event: SignedEvent) => ({
    coordinate: eventCoordinate(event),
    eventId: event.id,
    createdAt: event.created_at * 1_000,
    signedEvent: event,
  })
  const order = orderSchema.parse({
    id: crypto.randomUUID(),
    buyerPubkey: BUYER_PUBKEY,
    merchantPubkey: MERCHANT_PUBKEY,
    items: [
      {
        productId: eventCoordinate(product),
        title: MERCHANT_TEMPLATE_TITLE,
        format: "physical",
        quantity: 1,
        priceAtPurchase: 2_500,
        currency: "SATS",
        sourcePrice: {
          amount: 2_500,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
        shippingCostSats: 0,
        fulfillment: {
          type: "event_market_pickup",
          organizerPubkey: ORGANIZER_PUBKEY,
          merchantPubkey: MERCHANT_PUBKEY,
          payeePubkey: MERCHANT_PUBKEY,
          market: snapshot(market),
          calendar: {
            ...snapshot(calendar),
            start: start * 1_000,
            end: end * 1_000,
          },
          grant: {
            kind: 3841,
            pubkey: ORGANIZER_PUBKEY,
            eventId: grant.id,
            createdAt: grant.created_at * 1_000,
            ancestryEventIds: [grant.id],
            observedDeletionEventIds: [],
            signedEvidence: { tip: grant, ancestry: [grant], deletions: [] },
          },
          product: snapshot(product),
          occurrenceAssignment: snapshot(assignment),
          mode: "merchant_present",
          assignment: "Booth 7",
        },
      },
    ],
    subtotal: 2_500,
    currency: "SATS",
    shippingCostSats: 0,
    createdAt: (createdAt + 1) * 1_000,
  })
  // A genuine inbound Buyer order isolates Merchant acceptance from catalog UI.
  // Neither inventory acceptance nor Merchant payment confirmation is seeded.
  relay.seed(
    calendar,
    market,
    grant,
    product,
    assignment,
    createInboxDeclaration("merchant", createdAt),
    createInboxDeclaration("buyer", createdAt),
    ...signedBuyerOrder(
      order,
      createdAt + 1,
      buildEventMarketOrderRumorTags(order)
    ),
    ...signedBuyerPaymentReport(order.id)
  )
  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  await page
    .getByRole("button", { name: "Confirm payment", exact: true })
    .click()
  const dialog = page.getByRole("alertdialog", {
    name: "Confirm payment received?",
  })
  await expect(dialog).toBeVisible()
  const from = relay.publications.length
  const confirmationAck = relay.holdNextPublicationAck(
    (event) =>
      event.kind === 1059 &&
      event.tags.some((tag) => tag[0] === "p" && tag[1] === BUYER_PUBKEY)
  )
  try {
    await dialog
      .getByRole("button", { name: "Confirm payment", exact: true })
      .click()
    await confirmationAck.captured
    await expect
      .poll(
        () =>
          uniquePrivatePublications(
            decryptPrivatePublications(relay.publications, BUYER_SECRET, from)
          ).filter(
            (message) =>
              rumorType(message.rumor) === "status_update" &&
              JSON.parse(message.rumor.content).status === "paid"
          ).length
      )
      .toBe(1)
    await expect(
      page.getByText("Payment confirmed.", { exact: true })
    ).toHaveCount(0)
  } finally {
    confirmationAck.release()
  }
  await expect(
    page.getByText("Payment confirmed.", { exact: true })
  ).toBeVisible()
  expect(
    await occurrenceInventory(page, eventCoordinate(product), order.id)
  ).toMatchObject({
    stock: 8,
    allocation: 1,
    acceptedOrders: 1,
    savedOrder: true,
  })
  const retryPublication = page.getByRole("button", {
    name: "Retry acceptance publication",
    exact: true,
  })
  await page.reload()
  await retryPublication.evaluate((element) =>
    element.scrollIntoView({ behavior: "instant", block: "center" })
  )
  if (info.project.use.hasTouch) await retryPublication.tap()
  else await retryPublication.click()
  await expect(
    page.getByText("Accepted inventory updates published.", { exact: true })
  ).toBeVisible()
  expect(
    await occurrenceInventory(page, eventCoordinate(product), order.id)
  ).toMatchObject({ stock: 8, allocation: 1, acceptedOrders: 1 })
})

for (const scenario of [
  { rescheduled: false, repriced: false, label: "without a date change" },
  {
    rescheduled: true,
    repriced: false,
    label: "after same-event rescheduling",
  },
  { rescheduled: false, repriced: true, label: "after a listing price edit" },
  {
    rescheduled: false,
    repriced: false,
    expired: true,
    label: "after the original occurrence end",
  },
  {
    rescheduled: true,
    repriced: false,
    expired: true,
    label: "after the rescheduled occurrence end",
  },
])
  test(`prepaid first confirmation ${scenario.label} @market @merchant @occurrence-orders`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000)
    const { relay, createdAt, product, order, marketNaddr } =
      await createAssignedPickupOrder(page)
    relay.seed(...signedBuyerPaymentReport(order.id))
    if (scenario.rescheduled)
      await rescheduleSameEvent(
        page,
        relay,
        marketNaddr,
        createdAt + 93_600,
        createdAt + 97_200
      )
    await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
    if (scenario.repriced) {
      const edited = signEvent(MERCHANT_SECRET, {
        ...product,
        created_at: Math.floor(Date.now() / 1000) + 1,
        tags: product.tags.map((tag) =>
          tag[0] === "price" ? ["price", "2600", "SATS"] : tag
        ),
      })
      const published = await page.evaluate(
        async ({ root, appRoot, event, coordinate, relayUrl }) => {
          const { db } = await import(`${root}/db/index.ts`)
          const { commitLocalProductWrite, readCurrentProductWriteRevision } =
            await import(`${root}/protocol/local-product-write.ts`)
          const {
            prepareProductListingDeliveryJob,
            hasCommonAcknowledgedRelay,
          } = await import(`${root}/protocol/product-listing-delivery.ts`)
          const { deliverQueuedProductListings } = await import(
            `${appRoot}/lib/product-listing-delivery.ts`
          )
          const current = await readCurrentProductWriteRevision(coordinate)
          const job = prepareProductListingDeliveryJob({
            merchantPubkey: event.pubkey,
            signedEvents: [event],
            relayTargets: [
              { relayUrl, ownerSelected: false, personalRelay: true },
            ],
            readyForDelivery: false,
          })
          await commitLocalProductWrite({
            intentId: "reprice-after-buyer-order",
            merchantPubkey: event.pubkey,
            expectedRevisions: [
              { addressId: coordinate, eventId: current.eventId },
            ],
            listingJob: job,
          })
          await deliverQueuedProductListings(job.id, {
            authenticatedPubkey: event.pubkey,
            shouldContinue: () => true,
            expectedSignedEvents: [event],
          })
          return hasCommonAcknowledgedRelay(
            await db.productListingOutbox.get(job.id)
          )
        },
        {
          root: browserSourceRoot("packages/core/src"),
          appRoot: browserSourceRoot("apps/merchant/src"),
          event: edited,
          coordinate: eventCoordinate(product),
          relayUrl: FIXTURE_RELAY,
        }
      )
      expect(published).toBe(true)
    }
    if (scenario.expired) {
      // Change only wall time; timers and relay ACK handling keep running normally.
      const expiry = scenario.rescheduled
        ? (createdAt + 100_000) * 1000
        : order.items[0]!.fulfillment!.calendar.end
      await page.clock.setFixedTime(expiry + 1)
    }
    const dialog = page.getByRole("alertdialog", {
      name: "Confirm payment received?",
    })
    const confirmationObservation =
      await observePrepaidConfirmationTrigger(page)
    try {
      await page
        .getByRole("button", { name: "Confirm payment", exact: true })
        .click()
      await expect(dialog).toBeVisible()
    } catch (error) {
      await confirmationObservation.recordFailure(info)
      throw error
    } finally {
      await confirmationObservation.dispose()
    }
    const from = relay.publications.length
    const confirmationAck = relay.holdNextPublicationAck(
      (event) =>
        event.kind === 1059 &&
        event.tags.some((tag) => tag[0] === "p" && tag[1] === BUYER_PUBKEY)
    )
    await dialog
      .getByRole("button", { name: "Confirm payment", exact: true })
      .click()
    await confirmationAck.captured
    await expect
      .poll(
        () =>
          uniquePrivatePublications(
            decryptPrivatePublications(relay.publications, BUYER_SECRET, from)
          ).filter(
            (message) =>
              rumorType(message.rumor) === "status_update" &&
              JSON.parse(message.rumor.content).status === "paid"
          ).length
      )
      .toBe(1)
    await expect(
      page.getByText("Payment confirmed.", { exact: true })
    ).toHaveCount(0)
    confirmationAck.release()
    await expect(
      page.getByText("Payment confirmed.", { exact: true })
    ).toBeVisible()
    expect(
      await occurrenceInventory(page, eventCoordinate(product), order.id)
    ).toMatchObject({
      stock: 8,
      allocation: 1,
      acceptedOrders: 1,
      savedOrder: true,
    })
    expect(
      await page.evaluate(
        async ({ root, original }) => {
          const { db } = await import(`${root}/db/index.ts`)
          const { orderSchema } = await import(`${root}/schemas/index.ts`)
          const { openMerchantAcceptanceEvidence } = await import(
            `${root}/protocol/merchant-acceptance-privacy.ts`
          )
          const saved = await db.merchantInventoryAcceptedOrders.get(
            original.id
          )
          return (
            (await openMerchantAcceptanceEvidence(saved)) ===
            JSON.stringify(orderSchema.parse(original))
          )
        },
        { root: browserSourceRoot("packages/core/src"), original: order }
      )
    ).toBe(true)
    await page.reload()
    const retryPublication = page.getByRole("button", {
      name: "Retry acceptance publication",
      exact: true,
    })
    // Use a stationary control and the device's real input after restoration.
    await retryPublication.evaluate((element) =>
      element.scrollIntoView({ behavior: "instant", block: "center" })
    )
    if (info.project.use.hasTouch) await retryPublication.tap()
    else await retryPublication.click()
    await expect(
      page.getByText("Accepted inventory updates published.", { exact: true })
    ).toBeVisible()
    expect(
      await occurrenceInventory(page, eventCoordinate(product), order.id)
    ).toMatchObject({ stock: 8, allocation: 1, acceptedOrders: 1 })
  })

for (const postponed of [true, false])
  test(`same-event ${postponed ? "postponement keeps" : "earlier end releases"} unused allocations @market @merchant @occurrence-orders`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const { relay, createdAt, product, order, marketNaddr } =
      await createAssignedPickupOrder(page)
    await acceptPickupOrder(page, order.id)
    const start = createdAt + (postponed ? 93_600 : 600)
    const end = createdAt + (postponed ? 97_200 : 1_200)
    const newEnd = await rescheduleSameEvent(
      page,
      relay,
      marketNaddr,
      start,
      end
    )
    await page.reload()
    const now = postponed ? (createdAt + 10_860) * 1000 : newEnd + 60_000
    expect(
      await occurrenceInventory(page, eventCoordinate(product), order.id, now)
    ).toMatchObject({
      stock: 8,
      allocation: 1,
      acceptedOrders: 1,
      storedEnd: newEnd,
      ordinaryAvailable: postponed ? 7 : 8,
    })
  })

test("acceptance publication retry preserves a later paid milestone @market @merchant @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const { relay, product, order } = await createAssignedPickupOrder(page)
  await acceptPickupOrder(page, order.id)
  relay.seed(
    ...signedHistoricalAcceptedStatus(
      order.id,
      "paid",
      Math.floor(Date.now() / 1000) + 2
    )
  )
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Mark picked up / complete", exact: true })
  ).toBeEnabled()
  await page.clock.setFixedTime(new Date(Date.now() + 5_000))
  const from = relay.publications.length
  await page
    .getByRole("button", { name: "Retry acceptance publication", exact: true })
    .click()
  await expect(
    page.getByText("Accepted inventory updates published.", { exact: true })
  ).toBeVisible()
  expect(
    uniquePrivatePublications(
      decryptPrivatePublications(relay.publications, BUYER_SECRET, from)
    ).filter((message) => rumorType(message.rumor) === "status_update")
  ).toHaveLength(0)
  const rumors = uniquePrivatePublications(
    decryptPrivatePublications(
      relay.events().map((event) => ({ event, relayUrl: FIXTURE_RELAY })),
      BUYER_SECRET
    )
  ).map((message) => message.rumor)
  const status = await page.evaluate(
    async ({ root, rumors, merchant, buyer }) => {
      const { parseOrderMessageRumorEvent } = await import(
        `${root}/protocol/orders.ts`
      )
      const { getEffectiveMerchantOrderStatus } = await import(
        `${root}/protocol/order-status.ts`
      )
      return getEffectiveMerchantOrderStatus(
        rumors.map(parseOrderMessageRumorEvent),
        { merchantPubkey: merchant, buyerPubkey: buyer }
      ).status
    },
    {
      root: browserSourceRoot("packages/core/src"),
      rumors,
      merchant: MERCHANT_PUBKEY,
      buyer: BUYER_PUBKEY,
    }
  )
  expect(status).toBe("paid")
  expect(
    await occurrenceInventory(page, eventCoordinate(product), order.id)
  ).toMatchObject({ stock: 8, allocation: 1, acceptedOrders: 1 })
})

test("selected order resolves its own products beyond the search cap @merchant @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const at = Math.floor(Date.now() / 1000) - 10
  const products = Array.from({ length: 101 }, (_, i) =>
    signEvent(MERCHANT_SECRET, {
      kind: 30402,
      created_at: at,
      content: "",
      tags: [
        ["d", `cap-${String(i).padStart(3, "0")}`],
        ["title", `Product ${i}`],
        ["type", "simple", "digital"],
        ["price", "1", "SATS"],
        ["stock", "10"],
      ],
    })
  )
  const item = (i: number) => ({
    productId: eventCoordinate(products[i]!),
    title: `Product ${i}`,
    format: "digital",
    fulfillment: { type: "digital" },
    quantity: 1,
    priceAtPurchase: 1,
    currency: "SATS",
    sourcePrice: { amount: 1, currency: "SATS", normalizedCurrency: "SATS" },
  })
  const makeOrder = (id: string, indices: number[], time: number) => ({
    id,
    buyerPubkey: BUYER_PUBKEY,
    merchantPubkey: MERCHANT_PUBKEY,
    items: indices.map(item),
    subtotal: indices.length,
    currency: "SATS",
    createdAt: time * 1000,
  })
  const many = makeOrder(
    "search-many-products",
    Array.from({ length: 100 }, (_, i) => i),
    at + 2
  )
  const selected = makeOrder("search-cap-selected", [100], at)
  const selectedWraps = signedBuyerOrder(selected, at)
  const selectedWrapIds = new Set(selectedWraps.map((event) => event.id))
  relay.seed(
    ...products,
    createInboxDeclaration("merchant", at),
    createInboxDeclaration("buyer", at),
    ...signedBuyerOrder(many, at + 2)
  )
  await gotoAs(page, merchantUrl, "/orders", "merchant")
  await expect(
    page.getByRole("button", { name: "Accept order", exact: true })
  ).toBeVisible()
  relay.seed(...selectedWraps)
  const held = relay.holdRelayEventResponses((_, event) =>
    selectedWrapIds.has(event.id)
  )
  try {
    await gotoAs(page, merchantUrl, "/orders", "merchant", {
      order: selected.id,
    })
    await held.captured
    // Another conversation has hydrated, but the requested order is still held.
    await expect(
      page
        .getByRole("button", { name: "Filter & sort", exact: true })
        .or(page.getByRole("textbox", { name: "Search orders", exact: true }))
        .filter({ visible: true })
        .first()
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Accept order", exact: true })
    ).toHaveCount(0)
    held.release()
    await page
      .getByRole("button", { name: "Accept order", exact: true })
      .click()
    await expect(
      page.getByText(/Accepted and inventory saved on this device/)
    ).toBeVisible()
    expect(
      relay.requests.some((request) =>
        request.filters.some(
          (filter) =>
            filter.kinds?.includes(30402) && filter["#d"]?.includes("cap-100")
        )
      )
    ).toBe(true)
    const state = await page.evaluate(
      async ({ root, productId, orderId }) => {
        const { db } = await import(`${root}/db/index.ts`)
        return {
          stock: (await db.merchantInventoryProducts.get(productId)).stock,
          saved: !!(await db.merchantInventoryAcceptedOrders.get(orderId)),
          acceptedCount: await db.merchantInventoryAcceptedOrders.count(),
          otherAccepted: !!(await db.merchantInventoryAcceptedOrders.get(
            "search-many-products"
          )),
        }
      },
      {
        root: browserSourceRoot("packages/core/src"),
        productId: eventCoordinate(products[100]!),
        orderId: selected.id,
      }
    )
    expect(state).toEqual({
      stock: 9,
      saved: true,
      acceptedCount: 1,
      otherAccepted: false,
    })
  } finally {
    held.release()
  }
})

test("legacy stock decision survives acceptance and publication retry @merchant @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const at = Math.floor(Date.now() / 1000) - 10
  const original = signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: at - 1,
    content: "",
    tags: [
      ["d", "legacy-last-unit"],
      ["title", "Last unit"],
      ["type", "simple", "digital"],
      ["price", "1", "SATS"],
      ["stock", "1"],
    ],
  })
  const current = signEvent(MERCHANT_SECRET, {
    ...original,
    created_at: at,
    tags: original.tags.map((tag) =>
      tag[0] === "stock" ? ["stock", "0"] : tag
    ),
  })
  const coordinate = eventCoordinate(current)
  const order = {
    id: "legacy-stock-last-unit",
    buyerPubkey: BUYER_PUBKEY,
    merchantPubkey: MERCHANT_PUBKEY,
    items: [
      {
        productId: coordinate,
        title: "Last unit",
        format: "digital",
        fulfillment: { type: "digital" },
        quantity: 1,
        priceAtPurchase: 1,
        currency: "SATS",
        sourcePrice: {
          amount: 1,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
      },
    ],
    subtotal: 1,
    currency: "SATS",
    createdAt: (at - 2) * 1000,
  }
  relay.seed(
    current,
    createInboxDeclaration("merchant", at),
    createInboxDeclaration("buyer", at),
    ...signedBuyerOrder(order, at - 2)
  )
  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  await page.evaluate(
    async ({ root, merchant, orderId, coordinate, sourceId }) => {
      const { ProductStockDecisionStore } = await import(
        `${root}/lib/productStock.ts`
      )
      const saved = new ProductStockDecisionStore().set(
        merchant,
        orderId,
        coordinate,
        "applied",
        {
          key: `${encodeURIComponent(orderId)}:${encodeURIComponent(coordinate)}`,
          addressId: coordinate,
          sourceEventId: sourceId,
          title: "Last unit",
          quantity: 1,
          currentStock: 1,
          nextStock: 0,
          shortfall: 0,
        }
      )
      if (!saved) throw new Error("Fixture stock decision was not saved")
    },
    {
      root: browserSourceRoot("apps/merchant/src"),
      merchant: MERCHANT_PUBKEY,
      orderId: order.id,
      coordinate,
      sourceId: original.id,
    }
  )
  // Interrupt before transport staging; reloading an in-flight send retains
  // its live delivery lease and does not permit immediate recovery.
  await page.evaluate(
    (key) => localStorage.setItem(key, "1"),
    SYNTHETIC_SIGNER_UNAVAILABLE_KEY
  )
  const acceptedNotice = page.getByText(
    "Accepted locally. The buyer notification and inventory publication can be retried.",
    { exact: true }
  )
  const pendingAcceptance = page.getByRole("button", {
    name: /^(Sending|Recording)…$/,
  })
  await page.getByRole("button", { name: "Accept order", exact: true }).click()
  await pendingAcceptance
    .or(acceptedNotice)
    .first()
    .waitFor({ state: "visible" })
  await pendingAcceptance.waitFor({ state: "hidden" })
  await expect(acceptedNotice).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __conduitSyntheticSignAttempts?: number
            }
          ).__conduitSyntheticSignAttempts ?? 0
      )
    )
    .toBeGreaterThan(0)
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    SYNTHETIC_SIGNER_UNAVAILABLE_KEY
  )
  await page.reload()
  const retry = page.getByRole("button", {
    name: "Retry acceptance publication",
    exact: true,
  })
  const publishedNotice = page.getByText(
    "Accepted inventory updates published.",
    {
      exact: true,
    }
  )
  const pendingRetry = retry.and(page.locator(":disabled"))
  const retryObservation = await page.evaluateHandle((unavailableKey) => {
    const seen = {
      pointerDownOnTrigger: false,
      pointerUpOnTrigger: false,
      clickOnTrigger: false,
      pendingObserved: false,
      publishedObserved: false,
      publicationErrorObserved: false,
    }
    const trigger = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.textContent?.trim() === "Retry acceptance publication"
      )
    const observe = () => {
      seen.pendingObserved ||= trigger()?.disabled === true
      seen.publishedObserved ||= [
        ...document.querySelectorAll('[role="status"]'),
      ].some(
        (status) =>
          status.textContent?.trim() === "Accepted inventory updates published."
      )
      seen.publicationErrorObserved ||= [
        ...document.querySelectorAll('[role="alert"]'),
      ].some((alert) =>
        alert.textContent?.includes(
          "Acceptance remains saved. Publication could not finish;"
        )
      )
    }
    const isTrigger = (event: Event) =>
      event.target instanceof Node && trigger()?.contains(event.target) === true
    const down = (event: Event) => {
      if (isTrigger(event)) seen.pointerDownOnTrigger = true
    }
    const up = (event: Event) => {
      if (isTrigger(event)) seen.pointerUpOnTrigger = true
    }
    const click = (event: Event) => {
      if (isTrigger(event)) seen.clickOnTrigger = true
    }
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("pointerup", up, true)
    document.addEventListener("click", click, true)
    const observer = new MutationObserver(observe)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
    })
    observe()
    return {
      read() {
        observe()
        return {
          observationAvailable: true,
          ...seen,
          signerDenied: localStorage.getItem(unavailableKey) === "1",
          signerAttempts:
            (
              window as typeof window & {
                __conduitSyntheticSignAttempts?: number
              }
            ).__conduitSyntheticSignAttempts ?? 0,
          retryPresent: !!trigger(),
          retryEnabled: !!trigger() && !trigger()!.disabled,
        }
      },
      dispose() {
        observer.disconnect()
        document.removeEventListener("pointerdown", down, true)
        document.removeEventListener("pointerup", up, true)
        document.removeEventListener("click", click, true)
      },
    }
  }, SYNTHETIC_SIGNER_UNAVAILABLE_KEY)
  try {
    await expect(retry).toBeVisible()
    await expect(retry).toBeEnabled()
    // Exercise the native button without the pointer-delivery gap seen in WebKit.
    await retry.press("Enter")
    await pendingRetry.or(publishedNotice).first().waitFor({ state: "visible" })
    await pendingRetry.waitFor({ state: "hidden" })
    await expect(publishedNotice).toBeVisible()
  } catch (error) {
    let safe: Record<string, unknown> = { observationAvailable: false }
    try {
      safe = await retryObservation.evaluate((observation) =>
        observation.read()
      )
    } catch {
      /* Retain the original failure if the page is unavailable. */
    }
    recordSmokeDiagnostic(test.info(), "inventory-publication-retry", safe)
    throw error
  } finally {
    await retryObservation
      .evaluate((observation) => observation.dispose())
      .catch(() => {})
    await retryObservation.dispose()
  }
  const state = await page.evaluate(
    async ({ root, coordinate, orderId }) => {
      const { db } = await import(`${root}/db/index.ts`)
      return {
        stock: (await db.merchantInventoryProducts.get(coordinate)).stock,
        orders: await db.merchantInventoryAcceptedOrders.count(),
        saved: !!(await db.merchantInventoryAcceptedOrders.get(orderId)),
      }
    },
    {
      root: browserSourceRoot("packages/core/src"),
      coordinate,
      orderId: order.id,
    }
  )
  expect(state).toEqual({ stock: 0, orders: 1, saved: true })
})

test("saved assignments remain in Selling At outside both follow perspectives after reload @merchant @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const { relay, createdAt, product } = await createAssignedPickupOrder(page)
  expect(
    product.tags.some((tag) => tag[0] === "a" || tag[0] === "event_market")
  ).toBe(false)
  relay.seed(createFollowList("merchant", [], createdAt + 30))
  relay.omitMarketDiscovery(true)
  await gotoAs(page, merchantUrl, "/events", "merchant")
  await page.reload()
  const my = page.getByRole("region", { name: "My Events timeline" })
  await my.getByRole("button", { name: "Selling At", exact: true }).click()
  await expect(
    my.getByRole("button", { name: /^Open Merchant Fair/ })
  ).toBeVisible()
})

test("conflicting same-ID zero-cost order cannot inherit saved acceptance @merchant @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const { relay, createdAt, product, order } = await createAssignedPickupOrder(
    page,
    { zeroCost: true }
  )
  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  await page.evaluate(
    (key) => localStorage.setItem(key, "1"),
    SYNTHETIC_SIGNER_UNAVAILABLE_KEY
  )
  await page.getByRole("button", { name: "Accept order", exact: true }).click()
  await expect(
    page.getByRole("button", {
      name: "Retry acceptance publication",
      exact: true,
    })
  ).toBeVisible()
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    SYNTHETIC_SIGNER_UNAVAILABLE_KEY
  )
  relay.seed(
    ...signedBuyerOrder(
      {
        ...order,
        items: order.items.map((item) => ({ ...item, quantity: 2 })),
        subtotal: 0,
      },
      createdAt - 60
    )
  )
  await page.reload()
  await expect(
    page
      .getByText(/each × 2/)
      .filter({ visible: true })
      .first()
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Mark picked up / complete", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("alert").filter({
      hasText: "Saved inventory could not be verified for this order",
    })
  ).toBeVisible()
  expect(
    await occurrenceInventory(page, eventCoordinate(product), order.id)
  ).toMatchObject({
    stock: 8,
    allocation: 1,
    acceptedOrders: 1,
    savedOrder: true,
  })
})

test("local acceptance survives a replaced notice after interrupted signing @market @merchant @occurrence-orders", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const { product, order } = await createAssignedPickupOrder(page)
  await acceptPickupOrder(page, order.id, true)
  expect(
    await occurrenceInventory(page, eventCoordinate(product), order.id)
  ).toMatchObject({
    stock: 8,
    allocation: 1,
    acceptedOrders: 1,
    savedOrder: true,
  })
})
