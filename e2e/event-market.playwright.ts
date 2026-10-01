import { expect, test, type Page } from "@playwright/test"
import { nip19, nip44 } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"

import { buildEventMarketCalendarDraft } from "@conduit/core/protocol/event-market"

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

function eventCoordinate(event: SignedEvent): string {
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1]
  if (!dTag) throw new Error(`Signed kind-${event.kind} fixture has no d tag.`)
  return `${event.kind}:${event.pubkey}:${dTag}`
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
  let rejectReads = false

  return {
    publications,
    requests,
    incompleteRequests,
    incompleteReadsForKind(kind: number) {
      incompleteReadKinds.add(kind)
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
              if (rejectReads) {
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
    kind: 31923,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "future-fair"],
      ["title", "Future Fair"],
      ["start", "1790000000"],
      ["D", "20717"],
    ],
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
    ["price", "12", "USD"],
    ["type", "simple", "physical"],
    ...(tagged ? [["a", eventCoordinate(approval)]] : []),
  ]
  const product = signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: createdAt,
    content: "Handmade soap",
    tags: productTags(true),
  })
  relay.seed(
    calendar,
    approval,
    grant,
    product,
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
          filter.kinds?.includes(30402) &&
          filter["#a"]?.includes(eventCoordinate(approval)) &&
          !filter.authors
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
    page.getByRole("button", { name: "Add", exact: true })
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
    page.getByRole("heading", { name: "Listing not available" })
  ).toBeVisible()
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
  // A discovery hint may retain the old tagged revision. The selected action
  // must check the current signed revision before it can mutate the cart.
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toHaveCount(0)
  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByText("Your cart is empty", { exact: true })
  ).toBeVisible()
  await page.goto(directProductUrl)
  await expect(
    page.getByRole("heading", { name: "Listing not available" })
  ).toBeVisible()
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
      page.getByRole("button", { name: "Add", exact: true })
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

test("Merchant links an approved shop product and Market discovers it without pickup records @market @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    kind: 31923,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "merchant-fair"],
      ["title", "Merchant Fair"],
      ["start", "1790000000"],
      ["D", "20717"],
    ],
  })
  const market = signEvent(ORGANIZER_SECRET, {
    kind: 30409,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "merchant-fair"],
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
  relay.seed(
    calendar,
    market,
    grant,
    createMerchantTemplateProductEvent(createdAt)
  )
  const marketNaddr = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "merchant-fair",
  })
  const productPath = `/products?eventMarket=${marketNaddr}`
  await gotoAs(page, merchantUrl, productPath, "merchant")
  await page.getByRole("button", { name: "Add to event", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Edit listing" })
  await expect(
    editor.getByRole("checkbox", { name: "Offer this product at this event" })
  ).toBeChecked()
  const publicationStart = relay.publications.length
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(
          relay.publications.slice(publicationStart)
        ).filter((event) => event.kind === 30402).length
    )
    .toBe(1)
  const published = uniquePublishedEvents(
    relay.publications.slice(publicationStart)
  )
  const updated = published.find((event) => event.kind === 30402)!
  expect(updated.tags).toContainEqual(["a", eventCoordinate(market)])
  expect(
    published.some((event) => event.kind === 30406 || event.kind === 30405)
  ).toBe(false)

  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: MERCHANT_TEMPLATE_TITLE })
  ).toBeVisible()
  await expect(page.getByText(/Merchant booth: Booth 7/)).toBeVisible()

  await gotoAs(page, merchantUrl, productPath, "merchant")
  await page
    .getByRole("button", { name: "Remove from event", exact: true })
    .click()
  const untagEditor = page.getByRole("dialog", { name: "Edit listing" })
  await expect(
    untagEditor.getByRole("checkbox", {
      name: "Offer this product at this event",
    })
  ).not.toBeChecked()
  const untagStart = relay.publications.length
  await untagEditor
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect
    .poll(
      () =>
        uniquePublishedEvents(relay.publications.slice(untagStart)).filter(
          (event) => event.kind === 30402
        ).length
    )
    .toBe(1)
  const untagged = uniquePublishedEvents(
    relay.publications.slice(untagStart)
  ).find((event) => event.kind === 30402)!
  expect(untagged.tags).not.toContainEqual(["a", eventCoordinate(market)])
  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: MERCHANT_TEMPLATE_TITLE })
  ).toHaveCount(0)
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
    kind: 31923,
    created_at: createdAt,
    content: "",
    tags: [
      ["d", "organizer-grants-fair"],
      ["title", "Organizer Grants Fair"],
      ["start", "1790000000"],
      ["D", "20717"],
    ],
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
  relay.seed(calendar, market, product)
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
  // A published authorization is only the first half of the saved decision.
  // Stay on the organizer screen until the roster and journal also settle.
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Approve merchant" })
  ).toBeEnabled()
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

test("Event Market variable products select a purchasable variation before checkout @market", async ({
  page,
}) => {
  test.setTimeout(300_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    kind: 31923,
    created_at: createdAt,
    content: "Two product future pickup",
    tags: [
      ["d", "future-handoff-fair"],
      ["title", "Future Handoff Fair"],
      ["start", "1790000000"],
      ["D", "20717"],
      ["location", "Town Hall"],
    ],
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
  relay.seed(
    calendar,
    market,
    grant,
    soap,
    candle,
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
    card.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()
  await card.getByRole("button", { name: "Add", exact: true }).click()
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

test("two future market products form one order and one private organizer release @market @merchant", async ({
  page,
}) => {
  test.setTimeout(300_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const createdAt = Math.floor(Date.now() / 1_000) - 10
  const calendar = signEvent(ORGANIZER_SECRET, {
    kind: 31923,
    created_at: createdAt,
    content: "Two product future pickup",
    tags: [
      ["d", "future-handoff-fair"],
      ["title", "Future Handoff Fair"],
      ["start", "1790000000"],
      ["D", "20717"],
      ["location", "Town Hall"],
    ],
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
  relay.seed(
    calendar,
    market,
    grant,
    soap,
    candle,
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
  for (const [index, name] of [
    "Future handoff soap",
    "Future handoff candle",
  ].entries()) {
    if (index === 1) {
      relay.seed(
        signEvent(ORGANIZER_SECRET, {
          ...market,
          created_at: createdAt + 1,
          tags: [
            ...market.tags,
            ["prev", market.id],
            ["merchant", BUYER_PUBKEY, "merchant_present", "Other booth"],
          ],
        })
      )
      await page.reload()
    }
    const card = page.getByRole("listitem").filter({ hasText: name })
    await expect(
      card.getByRole("button", { name: "Add", exact: true })
    ).toBeEnabled()
    await card.getByRole("button", { name: "Add", exact: true }).click()
    await expect(
      page.getByRole("button", {
        name: `Cart, ${index + 1} item${index === 0 ? "" : "s"}`,
      })
    ).toBeVisible()
  }
  await gotoAs(page, marketUrl, "/cart", "buyer")
  await page
    .getByRole("button", { name: "Increase quantity for Future handoff soap" })
    .click()
  await expect(page.getByText("1 purchase/1 merchant/3 items")).toBeVisible()
  await expect(
    page.getByRole("button", { name: /^Clear Event pickup/ })
  ).toHaveCount(1)
  await page.getByRole("button", { name: "Order", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible()
  await expect(
    page.getByText(/Pickup from event organizer/).first()
  ).toBeVisible()
  await expect(page.getByText(/Pickup Desk/).first()).toBeVisible()
  await expect(page.getByLabel(/Street address/i)).toHaveCount(0)
  const orderStart = relay.publications.length
  await page.getByRole("button", { name: /^Send order$/i }).click()
  await expect(page).toHaveURL(/\/orders(?:\?|$)/)
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
      fulfillment?: { type?: string; market?: { coordinate: string } }
    }>
  }
  expect(order.items).toHaveLength(2)
  expect(
    order.items.every(
      (item) => item.fulfillment?.type === "event_market_pickup"
    )
  ).toBe(true)
  expect(
    order.items[0]?.fulfillment?.market?.coordinate === eventCoordinate(market)
  ).toBe(true)
  const buyerPickup = page.getByTestId("future-market-order-pickup")
  await expect(buyerPickup).toBeVisible()
  await expect(buyerPickup.getByText("Pickup Desk")).toBeVisible()

  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  await page.getByRole("button", { name: "Accept order", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Accept order", exact: true })
  ).toHaveCount(0)
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
  const readyPayload = JSON.parse(readyMessages()[0]!.rumor.content) as {
    claimRef: string
    items: Array<{
      product: { coordinate: string; signedEvent?: SignedEvent }
      quantity: number
    }>
  }
  expect(readyPayload.items).toHaveLength(2)
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
  await page.reload()
  await expect(
    page
      .getByRole("list", { name: "Order progress" })
      .getByText("Picked up", { exact: true })
  ).toBeVisible()
  await expect(complete).toHaveCount(0)
  expect(completionMessages()).toHaveLength(1)
})

test("organizer creates and closes one future Event Market without legacy event records @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await page.getByLabel("Event title").fill("New Future Fair")
  await page.getByLabel("Description").fill("A future organizer market")
  await page
    .getByLabel(/^Event banner/)
    .fill("https://cdn.conduit.market/conduit-test/template-product.svg")
  await page.getByLabel("Location", { exact: true }).fill("Town Hall")
  await page.getByLabel("Start", { exact: true }).fill("2030-06-01T10:00")
  await page.getByLabel("End", { exact: true }).fill("2030-06-01T16:00")
  await page.getByRole("button", { name: "Publish Event Market" }).click()
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
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await page.getByLabel("Event title").fill("Weekly Future Fair")
  await page.getByLabel("Description").fill("A weekly organizer market")
  await page
    .getByLabel(/^Event banner/)
    .fill("https://cdn.conduit.market/conduit-test/template-product.svg")
  await page.getByLabel("Location", { exact: true }).fill("Town Hall")
  await page.getByRole("combobox", { name: "Dates" }).click()
  await page.getByRole("option", { name: "Multiple dates" }).click()
  await page.getByRole("combobox", { name: "Time zone" }).click()
  await page.getByRole("option", { name: "UTC", exact: true }).click()
  await page.getByRole("button", { name: "Generate weekly dates" }).click()
  await page.getByRole("checkbox", { name: "Saturday" }).check()
  await page.getByLabel("First date").fill("2030-06-01")
  await page.getByLabel("Through date").fill("2030-06-08")
  await page.getByLabel("Start hour").fill("10:00")
  await page.getByLabel("End hour").fill("16:00")
  await page
    .getByRole("button", { name: "Generate dates", exact: true })
    .click()
  await expect(page.getByText(/2 of 32 dates/)).toBeVisible()
  await page.getByRole("button", { name: "Publish Event Market" }).click()
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
  await page.getByRole("button", { name: "Add signed date" }).click()
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

test("event product chooses ordinary shipping and changes fulfillment in checkout @market @commerce", async ({
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
  relay.seed(calendar, market, grant, shipping, product)
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
    page.getByRole("button", { name: "Add", exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Ship it", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await expect(page.getByRole("button", { name: /Cart, 1 item/ })).toBeVisible()
  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      ...market,
      created_at: createdAt + 2,
      tags: market.tags.concat([["prev", closed.id]]),
    })
  )
  await page.goto(`${marketUrl}/checkout`)
  const take = page.getByRole("button", {
    name: "Take it at the event",
    exact: true,
  })
  await expect(take).toBeVisible()
  await take.click()
  await expect(take).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Take it at the event", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: "Ship it", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Ship it", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("heading", { name: "Delivery details" })
  ).toBeVisible()
})

test("guest retains a private event receipt and merchant verifies it @market @merchant @commerce", async ({
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
      ["image", "https://cdn.conduit.market/conduit-test/template-product.svg"],
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
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await expect(page.getByRole("button", { name: /Cart, 1 item/ })).toBeVisible()
  await page.goto(`${marketUrl}/checkout`)
  await page
    .getByRole("checkbox", { name: "Use a name only for handoff" })
    .check()
  await expect(page.getByLabel("Phone", { exact: true })).toHaveCount(0)
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0)
  await page.getByLabel("Name or pseudonym for handoff").fill("Soap fan")
  const before = relay.publications.length
  await page.getByRole("button", { name: "Send order", exact: true }).click()
  await expect(
    page
      .getByText("Save your event receipt and confirm that you kept it.")
      .first()
  ).toBeVisible()
  expect(
    decryptPrivatePublications(
      relay.publications,
      MERCHANT_SECRET,
      before
    ).filter((message) => rumorType(message.rumor) === "order")
  ).toHaveLength(0)
  const downloadPending = page.waitForEvent("download")
  await page
    .getByRole("button", { name: "Save event receipt", exact: true })
    .click()
  const download = await downloadPending
  const receiptPath = await download.path()
  if (!receiptPath) throw new Error("Receipt download is missing")
  await page
    .getByRole("checkbox", {
      name: "I saved my receipt and understand the trade-off",
    })
    .check()
  await page.getByRole("button", { name: "Send order", exact: true }).click()
  const orders = () =>
    uniquePrivatePublications(
      decryptPrivatePublications(relay.publications, MERCHANT_SECRET, before)
    ).filter((message) => rumorType(message.rumor) === "order")
  await expect.poll(() => orders().length).toBe(1)
  const order = JSON.parse(orders()[0]!.rumor.content) as {
    id: string
    buyerIdentityKind: string
    guestContact?: unknown
    contactFreePickup: { label: string; receiptCommitment: string }
  }
  expect(order.buyerIdentityKind).toBe("guest_ephemeral")
  expect(order.guestContact).toBeUndefined()
  expect(order.contactFreePickup.label).toBe("Soap fan")
  expect(order.contactFreePickup.receiptCommitment).toMatch(/^[0-9a-f]{64}$/)
  expect(orders()[0]!.rumor.content).not.toContain("claimSecret")
  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
  await expect(page.getByText("Handoff name: Soap fan")).toBeVisible()
  await page.getByLabel("Verify customer receipt").setInputFiles(receiptPath)
  await expect(page.getByText(/Receipt matches this order\./)).toBeVisible()
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
})

async function enableEventMessages(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Set up event messages", exact: true })
    .click()
  const dialog = page.getByRole("dialog", {
    name: "Set up event messages",
    exact: true,
  })
  const relays = dialog.getByRole("region", { name: "Relays", exact: true })
  await expect(relays).toBeVisible()
  const inbox = relays.getByRole("button", {
    name: `Enable Private inbox for ${FIXTURE_RELAY}`,
    exact: true,
  })
  if ((await inbox.count()) === 0) {
    await relays.getByLabel("Add relay", { exact: true }).fill(FIXTURE_RELAY)
    await relays.getByRole("button", { name: "Add relay", exact: true }).click()
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
    dialog.getByText(
      "The exact signed preferences were confirmed on the planned relays.",
      { exact: true }
    )
  ).toBeVisible({ timeout: 20_000 })
  await dialog
    .getByRole("button", { name: "Return to event", exact: true })
    .click()
  await expect(
    page.getByText("Event messages ready", { exact: true })
  ).toBeVisible()
}

test("a host and merchant create, request, approve and offer through the screens @market @merchant @commerce", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  relay.seed(
    createMerchantTemplateProductEvent(Math.floor(Date.now() / 1000) - 10)
  )
  await gotoAs(page, merchantUrl, "/events/new", "organizer")
  await page.getByLabel("Event title").fill("Community Makers Fair")
  await page
    .getByLabel("Description")
    .fill("Local makers and neighbors at the community hall")
  await page
    .getByLabel(/^Event banner/)
    .fill("https://cdn.conduit.market/conduit-test/template-product.svg")
  await page.getByLabel("Location", { exact: true }).fill("Community Hall")
  await page.getByLabel("Start", { exact: true }).fill("2030-06-01T10:00")
  await page.getByLabel("End", { exact: true }).fill("2030-06-01T16:00")
  await enableEventMessages(page)
  await expect(page.getByLabel("Event title")).toHaveValue(
    "Community Makers Fair"
  )
  await page.getByRole("button", { name: "Publish Event Market" }).click()
  await expect(page).toHaveURL(/\/events\/naddr1/)
  const eventPath = new URL(page.url()).pathname
  const market = uniquePublishedEvents(relay.publications).find(
    (event) => event.kind === 30409
  )!
  expect(market).toBeDefined()
  expect(market.tags.some((tag) => tag[0] === "merchant")).toBe(false)

  await gotoAs(page, merchantUrl, eventPath, "merchant")
  await enableEventMessages(page)
  await page
    .getByRole("button", { name: "Request to join", exact: true })
    .click()
  await expect(page.getByText("Request pending", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText("Request pending", { exact: true })).toBeVisible()
  expect(
    uniquePublishedEvents(relay.publications).some(
      (event) => event.kind === 3841
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
  await expect(
    page.getByRole("button", { name: "Decline request" })
  ).toBeVisible()
  await page.getByLabel("Public assignment").fill("Booth 4")
  await page
    .getByRole("button", { name: "Approve merchant", exact: true })
    .click()
  await expect(page.getByText("Approved", { exact: true })).toBeVisible()
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
  await page.getByRole("button", { name: "Add to event", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Edit listing" })
  await expect(
    editor.getByRole("checkbox", { name: "Offer this product at this event" })
  ).toBeChecked()
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(editor).not.toBeVisible()
  await expect(
    page.getByText("Offered at this event", { exact: true })
  ).toBeVisible()
  await expect
    .poll(() =>
      uniquePublishedEvents(relay.publications).some(
        (event) =>
          event.kind === 30402 &&
          event.pubkey === MERCHANT_PUBKEY &&
          event.tags.some(
            (tag) => tag[0] === "d" && tag[1] === MERCHANT_TEMPLATE_D_TAG
          ) &&
          event.tags.some(
            (tag) => tag[0] === "a" && tag[1] === eventCoordinate(market)
          )
      )
    )
    .toBe(true)
  const listing = uniquePublishedEvents(relay.publications)
    .filter(
      (event) =>
        event.kind === 30402 &&
        event.pubkey === MERCHANT_PUBKEY &&
        event.tags.some(
          (tag) => tag[0] === "d" && tag[1] === MERCHANT_TEMPLATE_D_TAG
        )
    )
    .at(-1)!
  expect(listing.tags).toContainEqual(["a", eventCoordinate(market)])
  expect(
    uniquePublishedEvents(relay.publications).some(
      (event) => event.kind === 30405 || event.kind === 30406
    )
  ).toBe(false)

  await gotoAs(page, marketUrl, eventPath, "buyer")
  const card = page
    .getByRole("listitem")
    .filter({ hasText: MERCHANT_TEMPLATE_TITLE })
  await expect(
    card.getByRole("heading", { name: MERCHANT_TEMPLATE_TITLE })
  ).toBeVisible()
  await card.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Cart, 1 item", exact: true })
  ).toBeVisible()
  await gotoAs(page, marketUrl, "/cart", "buyer")
  await page.getByRole("button", { name: "Order", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible()
  await expect(page.getByText(/Booth 4/).first()).toBeVisible()
  await expect(page.getByLabel(/Street address/i)).toHaveCount(0)
})
