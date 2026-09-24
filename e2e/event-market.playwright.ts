import { expect, test, type Page } from "@playwright/test"
import { nip19, nip44 } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"

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
  const rejectedKinds = new Set<number>()
  let rejectReads = false

  return {
    publications,
    requests,
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
    ({ identities, relayUrl, searchKey, storageKey }) => {
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
            return await signer.__conduitSignSyntheticEvent(
              currentIdentity(),
              event
            )
          },
          nip44: {
            async encrypt(peerPubkey: string, plaintext: string) {
              return await signer.__conduitEncryptSyntheticNip44(
                currentIdentity(),
                peerPubkey,
                plaintext
              )
            },
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
    rumor.kind !== 16 ||
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

test("historical collection links remain readable without active writer controls @market @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const title = "Historical Fair"
  const { reference } = seedHistoricalEvent(relay, title)
  const publicationCount = relay.publications.length

  await gotoAs(page, marketUrl, `/events/${reference}`, "buyer")
  await expect(page.getByRole("heading", { name: title }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: /Add to cart/i })).toHaveCount(
    0
  )
  await expect(page.getByRole("link", { name: "Sell here" })).toHaveCount(0)

  await gotoAs(page, merchantUrl, `/events/${reference}`, "organizer")
  await expect(page.getByRole("heading", { name: title })).toBeVisible()
  await expect(
    page.getByText(/older Event Market remains available/)
  ).toBeVisible()
  await expect(
    page.getByRole("button", {
      name: /Approve merchant|Publish product|Update event/i,
    })
  ).toHaveCount(0)
  expect(relay.publications).toHaveLength(publicationCount)
})

test("historical order keeps its original paid pickup terms after event revision @market", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const { calendar, collection } = seedHistoricalEvent(
    relay,
    "Historical Order Fair"
  )
  const pickup = signEvent(ORGANIZER_SECRET, {
    kind: 30406,
    created_at: collection.created_at - 1,
    content: "",
    tags: [
      ["d", "historical-pickup"],
      ["title", "Original pickup desk"],
      ["price", "0", "SAT"],
      ["country", "US"],
      ["service", "pickup"],
      ["location", "Original hall entrance"],
    ],
  })
  const productTemplate = createMerchantTemplateProductEvent(
    collection.created_at + 1
  )
  const product = signEvent(MERCHANT_SECRET, {
    kind: productTemplate.kind,
    created_at: productTemplate.created_at,
    content: productTemplate.content,
    tags: productTemplate.tags.map((tag) =>
      tag[0] === "title" ? ["title", "Original merchant mug"] : tag
    ),
  })
  relay.seed(pickup, product)
  const orderId = "historical-paid-order"
  const originalFulfillment = {
    type: "pickup",
    organizerPubkey: ORGANIZER_PUBKEY,
    product: {
      coordinate: eventCoordinate(product),
      eventId: product.id,
      createdAt: product.created_at * 1_000,
      merchantPubkey: MERCHANT_PUBKEY,
    },
    calendar: {
      coordinate: eventCoordinate(calendar),
      eventId: calendar.id,
      createdAt: calendar.created_at * 1_000,
    },
    collection: {
      coordinate: eventCoordinate(collection),
      eventId: collection.id,
      createdAt: collection.created_at * 1_000,
    },
    option: {
      coordinate: eventCoordinate(pickup),
      eventId: pickup.id,
      createdAt: pickup.created_at * 1_000,
      title: "Original pickup desk",
      location: "Original hall entrance",
    },
    costSats: 0,
    sourceCost: { amount: 0, currency: "SAT", normalizedCurrency: "SATS" },
  }

  await gotoAs(page, marketUrl, "/orders", "buyer")
  await page.evaluate(
    async ({ id, fulfillment }) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("conduit")
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const database = open.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readwrite"
          )
          transaction.objectStore("orderLifecycles").put({
            orderId: id,
            buyerPubkey: fulfillment.buyerPubkey,
            merchantPubkey: fulfillment.merchantPubkey,
            checkoutMode: "private_checkout",
            items: [
              {
                productId: fulfillment.productId,
                title: "Original merchant mug",
                format: "physical",
                quantity: 2,
                priceAtPurchase: 2500,
                currency: "SATS",
                fulfillment: fulfillment.snapshot,
              },
            ],
            itemSubtotalSats: 5000,
            shippingCostSats: 0,
            totalSats: 5000,
            totalMsats: 5_000_000,
            currency: "SATS",
            addressValidity: "not_required",
            shippingZoneEligibility: "not_required",
            orderDeliveryStatus: "sent",
            invoiceStatus: "received",
            paymentStatus: "paid",
            proofDeliveryStatus: "sent",
            zapReceiptStatus: "not_applicable",
            phase: "in_progress",
            createdAt: Date.now() - 10_000,
            updatedAt: Date.now() - 10_000,
          })
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
    },
    {
      id: orderId,
      fulfillment: {
        buyerPubkey: BUYER_PUBKEY,
        merchantPubkey: MERCHANT_PUBKEY,
        productId: eventCoordinate(product),
        snapshot: originalFulfillment,
      },
    }
  )

  const changedCollection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: collection.created_at + 5,
    content: "Updated historical catalog",
    tags: [
      ["d", "historical-fair"],
      ["title", "Renamed historical fair"],
      ["a", eventCoordinate(calendar)],
      ["conduit_event_market", "1", "closed"],
    ],
  })
  relay.seed(changedCollection)
  await page.reload()
  const order = page.locator(`[data-order-id="${orderId}"]`)
  await expect(order).toBeVisible()
  await expect(page.getByText("Original merchant mug").first()).toBeVisible()
  await expect(page.getByText("Original pickup desk")).toBeVisible()
  await expect(page.getByText("Original hall entrance")).toBeVisible()
  const eventLink = page.getByRole("link", { name: "View event catalog" })
  const eventHref = await eventLink.getAttribute("href")
  expect(eventHref).toMatch(/^\/events\/naddr1/)
  const linkedReference = eventHref!.split("/").at(-1)!
  const linkedAddress = nip19.decode(linkedReference)
  expect(linkedAddress.type).toBe("naddr")
  if (linkedAddress.type === "naddr") {
    expect(linkedAddress.data.kind).toBe(30405)
    expect(linkedAddress.data.pubkey).toBe(ORGANIZER_PUBKEY)
    expect(linkedAddress.data.identifier).toBe("historical-fair")
  }
  const stored = await page.evaluate(async (id) => {
    return new Promise<{
      fulfillment?: { collection?: { eventId?: string } }
      totalSats?: number
    }>((resolve, reject) => {
      const open = indexedDB.open("conduit")
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const database = open.result
        const transaction = database.transaction("orderLifecycles", "readonly")
        const get = transaction.objectStore("orderLifecycles").get(id)
        transaction.oncomplete = () => {
          const record = get.result
          database.close()
          resolve({
            fulfillment: record?.items?.[0]?.fulfillment,
            totalSats: record?.totalSats,
          })
        }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  }, orderId)
  expect(stored.fulfillment?.collection?.eventId).toBe(collection.id)
  expect(stored.totalSats).toBe(5000)
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
  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Future Fair", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toBeVisible()
  await expect(page.getByText(/Merchant booth: Booth 12/)).toBeVisible()
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
  await expect(
    page.getByRole("heading", { name: "Future Fair soap" })
  ).toHaveCount(0)
  await page.goto(directProductUrl)
  await expect(
    page.getByRole("heading", { name: "Listing not available" })
  ).toBeVisible()
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
  await gotoAs(page, merchantUrl, "/products", "merchant")
  const editListing = page.getByRole("button", { name: /^(Edit|Fix listing)$/ })
  await expect(editListing).toBeVisible({ timeout: 30_000 })
  await editListing.click()
  const editor = page.getByRole("dialog", { name: "Edit listing" })
  await editor.getByLabel("Event Market").fill(eventCoordinate(market))
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

  const marketNaddr = nip19.naddrEncode({
    kind: 30409,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "merchant-fair",
  })
  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: MERCHANT_TEMPLATE_TITLE })
  ).toBeVisible()
  await expect(page.getByText(/Merchant booth: Booth 7/)).toBeVisible()

  await gotoAs(page, merchantUrl, "/products", "merchant")
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("button", { name: "Updated" })).toBeVisible()
  await expect(editListing).toBeVisible({ timeout: 30_000 })
  await editListing.click()
  const untagEditor = page.getByRole("dialog", { name: "Edit listing" })
  await expect(untagEditor.getByLabel("Event Market")).toHaveValue(
    eventCoordinate(market)
  )
  await untagEditor.getByLabel("Event Market").fill("")
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
  await page.getByRole("button", { name: "Prepare merchant" }).click()
  await page
    .getByRole("textbox", { name: "Public assignment" })
    .fill("Booth 12")
  await page.getByRole("button", { name: "Approve merchant" }).click()
  await expect(page.getByText("Approved", { exact: true })).toBeVisible()
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
  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Organizer Grants soap" })
  ).toHaveCount(0)

  await gotoAs(page, merchantUrl, `/events/${marketNaddr}`, "organizer")
  await page
    .getByRole("textbox", { name: "Merchant pubkey" })
    .fill(MERCHANT_PUBKEY)
  await page.getByRole("button", { name: "Prepare merchant" }).click()
  await page
    .getByRole("textbox", { name: "Public assignment" })
    .fill("Booth 14")
  await page.getByRole("button", { name: "Approve merchant" }).click()
  await expect(
    page.getByText(/all still-tagged products reappear/)
  ).toBeVisible()
  await page.getByRole("button", { name: "Confirm reapproval" }).click()
  await expect(page.getByText("Approved", { exact: true })).toBeVisible()

  await gotoAs(page, marketUrl, `/events/${marketNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Organizer Grants soap" })
  ).toBeVisible()
  await expect(page.getByText(/Merchant booth: Booth 14/)).toBeVisible()
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
  relay.seed(
    calendar,
    market,
    grant,
    product("Future handoff soap", "future-handoff-soap"),
    product("Future handoff candle", "future-handoff-candle"),
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
  await expect(page.getByText("1 purchase/1 merchant/2 items")).toBeVisible()
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
  expect(order.items[0]?.fulfillment?.market?.coordinate).toBe(
    eventCoordinate(market)
  )
  const buyerPickup = page.getByTestId("future-market-order-pickup")
  await expect(buyerPickup).toBeVisible()
  await expect(buyerPickup.getByText("Pickup Desk")).toBeVisible()

  await gotoAs(page, merchantUrl, "/orders", "merchant", { order: order.id })
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
    items: Array<{ product: { coordinate: string }; quantity: number }>
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
  const ackStart = relay.publications.length
  await page.getByRole("button", { name: "Mark handed out" }).click()
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
})
