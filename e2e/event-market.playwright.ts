import { expect, test, type Page } from "@playwright/test"
import { nip19, nip44 } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"

import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "../tests/support/bolt11-fixture"

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
const INBOX_NOISE_SECRET = generateSecretKey()
const ORGANIZER_PRODUCT_D_TAG = "synthetic-organizer-handoff-product"
const ORGANIZER_PRODUCT_COORDINATE = `30402:${MERCHANT_PUBKEY}:${ORGANIZER_PRODUCT_D_TAG}`
const ORGANIZER_PRODUCT_TITLE = "Synthetic organizer handoff mug"
const MERCHANT_TEMPLATE_D_TAG = "synthetic-existing-product"
const MERCHANT_TEMPLATE_COORDINATE = `30402:${MERCHANT_PUBKEY}:${MERCHANT_TEMPLATE_D_TAG}`
const MERCHANT_TEMPLATE_TITLE = "Existing merchant mug"
const MERCHANT_PRODUCT_TITLE = "Synthetic merchant booth mug"
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

function eventCollectionReferenceCoordinate(reference: string): string | null {
  if (reference.startsWith("30405:")) return reference
  try {
    const decoded = nip19.decode(reference)
    if (decoded.type !== "naddr" || decoded.data.kind !== 30405) return null
    return `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`
  } catch {
    return null
  }
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
      if (heldRelayRequest) {
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
              request.matchedEventIds = limitedMatches.map((event) => event.id)
              for (const event of limitedMatches) {
                socket.send(JSON.stringify(["EVENT", subscriptionId, event]))
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

function createCappedInboxNoise(
  recipientPubkey: string,
  count: number
): SignedEvent[] {
  return Array.from({ length: count }, (_, index) =>
    signEvent(INBOX_NOISE_SECRET, {
      kind: 1059,
      created_at: 1_600_000_000 + index,
      tags: [["p", recipientPubkey]],
      content: `synthetic-nondecryptable-wrap-${index}`,
    })
  )
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

function captureBrowserErrors(page: Page): {
  consoleErrors: string[]
  pageErrors: string[]
} {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  return { consoleErrors, pageErrors }
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

type PublishedOrganizerMarket = {
  calendarEvent: SignedEvent
  pickupEvent?: SignedEvent
  initialCollection: SignedEvent
  calendarCoordinate: string
  pickupCoordinate?: string
  collectionCoordinate: string
  canonicalNaddr: string
  merchantParticipationPath: string
}

async function publishOrganizerMarket(
  page: Page,
  relay: RelayHarness,
  options: {
    title: string
    organizerHandoffEnabled: boolean
    beforePublish?: (start: number) => void
    afterEditorClosed?: () => Promise<void>
  }
): Promise<PublishedOrganizerMarket> {
  await gotoAs(page, merchantUrl, "/events", "organizer")
  await expect(
    page.getByRole("heading", { name: "Events", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Event timeline", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Create event" }).first().click()
  const editor = page.getByRole("dialog", { name: "Create event market" })
  await expect(editor).toBeVisible()

  const titleInput = editor.getByRole("textbox", {
    name: "Title Required",
    exact: true,
  })
  await expect(titleInput).toHaveAttribute("required", "")
  await titleInput.fill(options.title)
  await editor
    .getByRole("textbox", { name: "Public summary Required", exact: true })
    .fill("Synthetic browser-only organizer catalog.")
  await editor
    .getByRole("textbox", { name: "Event photo URL Required", exact: true })
    .fill("https://cdn.conduit.market/conduit-test/synthetic-event-market.svg")
  await editor
    .getByRole("textbox", { name: "Public location Required", exact: true })
    .fill("Synthetic Fixture Hall")
  await editor.locator("#event-market-calendar-type").click()
  await page.getByRole("option", { name: "All day" }).click()
  await editor
    .getByRole("textbox", { name: "Start Required", exact: true })
    .fill("2099-08-10")
  await editor.getByLabel("End (optional)").fill("2099-08-11")

  const organizerOffer = editor.getByRole("checkbox", {
    name: "Organizer can hand out products",
  })
  await expect(organizerOffer).not.toBeChecked()
  if (options.organizerHandoffEnabled) {
    await organizerOffer.check()
    await editor
      .getByLabel("Pickup point or area (optional)")
      .fill("Synthetic main entrance")
    await editor
      .getByRole("textbox", { name: "Event country Required", exact: true })
      .fill("US")
  } else {
    await expect(
      editor.getByLabel("Pickup point or area (optional)")
    ).toHaveCount(0)
  }

  const publishStart = relay.publications.length
  options.beforePublish?.(publishStart)
  await editor.getByRole("button", { name: "Publish event" }).click()
  await expect(editor).toBeHidden({ timeout: 30_000 })
  if (options.afterEditorClosed) await options.afterEditorClosed()
  await expect(page.getByText("Event loaded", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Share this event" })
  ).toBeVisible()
  await expect(
    page.getByText(
      options.organizerHandoffEnabled
        ? "Event pickup"
        : "Organizer handoff not offered",
      { exact: true }
    )
  ).toBeVisible()
  await expect(page.getByText(/acknowledged$/)).toHaveCount(
    options.organizerHandoffEnabled ? 3 : 2
  )

  const published = uniquePublishedEvents(
    relay.publications.slice(publishStart)
  ).filter((event) => [31922, 31923, 30406, 30405].includes(event.kind))
  expect(published.map((event) => event.kind)).toEqual(
    options.organizerHandoffEnabled ? [31922, 30406, 30405] : [31922, 30405]
  )
  const calendarEvent = published.find((event) => event.kind === 31922)!
  const pickupEvent = published.find((event) => event.kind === 30406)
  const initialCollection = published.find((event) => event.kind === 30405)!
  expect(calendarEvent).toBeTruthy()
  expect(initialCollection).toBeTruthy()
  expect(
    initialCollection.tags.filter(
      (tag) => tag[0] === "a" && tag[1]?.startsWith("30402:")
    )
  ).toEqual([])
  expect(initialCollection.tags).toContainEqual([
    "a",
    eventCoordinate(calendarEvent),
  ])
  if (options.organizerHandoffEnabled) {
    expect(pickupEvent).toBeTruthy()
    expect(pickupEvent!.tags).toContainEqual(["price", "0", "SAT"])
    expect(pickupEvent!.tags).toContainEqual([
      "location",
      "Synthetic main entrance",
    ])
    expect(initialCollection.tags).toContainEqual([
      "shipping_option",
      eventCoordinate(pickupEvent!),
    ])
  } else {
    expect(pickupEvent).toBeUndefined()
    expect(
      initialCollection.tags.filter((tag) => tag[0] === "shipping_option")
    ).toEqual([])
  }

  const catalogUrl = await page
    .getByRole("link", { name: "Open shopper catalog" })
    .getAttribute("href")
  const canonicalCatalogUrl = new URL(catalogUrl!)
  expect(canonicalCatalogUrl.origin).toBe(marketUrl)
  expect(canonicalCatalogUrl.pathname).toMatch(/^\/events\/naddr1/)
  const canonicalNaddr = canonicalCatalogUrl.pathname.split("/").at(-1)!
  const participationUrl = new URL(
    (await page
      .getByRole("link", { name: "Open merchant participation" })
      .getAttribute("href"))!
  )
  expect(participationUrl.origin).toBe(merchantUrl)
  expect(participationUrl.pathname).toBe("/events")
  expect(participationUrl.searchParams.get("event")).toBe(canonicalNaddr)

  return {
    calendarEvent,
    pickupEvent,
    initialCollection,
    calendarCoordinate: eventCoordinate(calendarEvent),
    pickupCoordinate: pickupEvent ? eventCoordinate(pickupEvent) : undefined,
    collectionCoordinate: eventCoordinate(initialCollection),
    canonicalNaddr,
    merchantParticipationPath: `${participationUrl.pathname}${participationUrl.search}`,
  }
}

test("signed-out merchant participation preserves the exact event through auth @merchant", async ({
  page,
}) => {
  page.setDefaultTimeout(20_000)
  page.setDefaultNavigationTimeout(30_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const eventNaddr = nip19.naddrEncode({
    kind: 30405,
    pubkey: ORGANIZER_PUBKEY,
    identifier: "signed-out-participation",
  })

  await page.goto(
    `${merchantUrl}/events?event=${encodeURIComponent(eventNaddr)}`
  )
  await expect
    .poll(() => {
      const url = new URL(page.url())
      return {
        pathname: url.pathname,
        authRequired: url.searchParams.get("authRequired"),
        event: url.searchParams.get("event"),
      }
    })
    .toEqual({ pathname: "/", authRequired: "true", event: eventNaddr })

  const connectUrl = new URL(page.url())
  connectUrl.searchParams.set(SYNTHETIC_IDENTITY_SEARCH_KEY, "merchant")
  await page.goto(connectUrl.toString())
  await expect
    .poll(() => {
      const url = new URL(page.url())
      return { pathname: url.pathname, event: url.searchParams.get("event") }
    })
    .toEqual({ pathname: "/events", event: eventNaddr })
  await expect(
    page.getByRole("heading", { name: "Events", exact: true })
  ).toBeVisible()
})

test("Merchant event timeline supports perspective, relationship, mobile, and keyboard flows @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const eventTitle = "Synthetic Merchant Timeline Event"
  const market = await publishOrganizerMarket(page, relay, {
    title: eventTitle,
    organizerHandoffEnabled: false,
  })
  relay.seed(
    createFollowList(
      "merchant",
      [ORGANIZER_PUBKEY],
      market.initialCollection.created_at + 1
    )
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await gotoAs(page, merchantUrl, "/events", "merchant")

  const timeline = page.getByRole("region", { name: "Event timeline" })
  await expect(timeline).toBeVisible()
  await expect(
    timeline.getByRole("group", { name: "Event network perspective" })
  ).toBeVisible()
  await expect(
    timeline.getByRole("button", { name: "Combined", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  const relationshipFilter = timeline.getByRole("combobox", {
    name: "Relationship",
    exact: true,
  })
  await expect(relationshipFilter).toBeVisible()
  await expect(
    timeline.getByRole("combobox", { name: "Date", exact: true })
  ).toBeVisible()

  const sellHere = timeline.getByRole("button", {
    name: `Sell here ${eventTitle}`,
    exact: true,
  })
  await expect(sellHere).toBeVisible({ timeout: 30_000 })
  await sellHere.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("button", { name: "Publish product", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  await relationshipFilter.click()
  await page.getByRole("option", { name: "Saved", exact: true }).click()
  await expect(
    timeline
      .getByLabel(`Your relationship to ${eventTitle}`)
      .getByText("Saved", { exact: true })
  ).toBeVisible()
  const following = timeline.getByRole("button", {
    name: "Following",
    exact: true,
  })
  await following.focus()
  await page.keyboard.press("Enter")
  await expect(following).toHaveAttribute("aria-pressed", "true")
  await expect
    .poll(() => new URL(page.url()).searchParams.get("source"))
    .toBe("following")
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true)
})

test("organizer discovery retries an unavailable refresh without losing saved events or claiming absence @merchant", async ({
  page,
}) => {
  test.setTimeout(150_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  await gotoAs(page, merchantUrl, "/events", "organizer")
  const emptyHeading = page.getByRole("heading", {
    name: "No matching verified events in this relay view",
  })
  await expect(emptyHeading).toBeVisible()
  relay.rejectReads(true)
  await page.reload()
  const retry = page.getByRole("button", {
    name: "Retry event discovery",
    exact: true,
  })
  await expect(retry).toBeEnabled({ timeout: 60_000 })
  await expect(
    page.getByTestId("merchant-event-timeline-discovery-status")
  ).toContainText(/unavailable/i)
  relay.rejectReads(false)
  await retry.click()
  await expect(
    page.getByTestId("merchant-event-timeline-discovery-status")
  ).not.toContainText(/unavailable/i)
  const title = "Synthetic retained discovery title"
  await publishOrganizerMarket(page, relay, {
    title,
    organizerHandoffEnabled: false,
  })
  relay.rejectReads(true)
  await page.reload()
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible()
  await expect(
    page.getByTestId("merchant-event-timeline-discovery-status")
  ).toContainText(/unavailable/i, { timeout: 60_000 })
  relay.rejectReads(false)
  await expect(retry).toBeEnabled()
  await retry.click()
  await expect(
    page.getByTestId("merchant-event-timeline-discovery-status")
  ).not.toContainText(/unavailable/i)
  await expect(
    page.getByRole("button", { name: `Manage ${title}`, exact: true })
  ).toBeVisible()
})

test("direct and pasted event imports hydrate one saved selector title outside the selected perspective @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const eventTitle = "Synthetic imported title hydration"
  const market = await publishOrganizerMarket(page, relay, {
    title: `  ${eventTitle}  `,
    organizerHandoffEnabled: false,
  })
  const unrelatedFollowedPubkeys = Array.from({ length: 17 }, (_, index) =>
    (index + 1).toString(16).padStart(64, "0")
  )
  relay.seed(
    createFollowList(
      "merchant",
      unrelatedFollowedPubkeys,
      market.initialCollection.created_at + 1
    )
  )

  await gotoAs(page, merchantUrl, market.merchantParticipationPath, "merchant")
  await expect(
    page.getByText(/No events were found.*perspective\./)
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(eventTitle, { exact: true }).first()).toBeVisible(
    {
      timeout: 30_000,
    }
  )
  const savedStorageKey = `conduit:merchant:discovered-event-markets:v1:${MERCHANT_PUBKEY}`
  const expectedTitleEvidence = {
    titleCollectionCoordinate: market.collectionCoordinate,
    titleCollectionCreatedAt: market.initialCollection.created_at * 1_000,
    titleCollectionEventId: market.initialCollection.id,
    titleCalendarCoordinate: market.calendarCoordinate,
    titleCalendarCreatedAt: market.calendarEvent.created_at * 1_000,
    titleCalendarEventId: market.calendarEvent.id,
  }
  const readSavedTitleEvidence = () =>
    page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
        reference?: string
        title?: string
        titleCollectionCoordinate?: string
        titleCollectionCreatedAt?: number
        titleCollectionEventId?: string
        titleCalendarCoordinate?: string
        titleCalendarCreatedAt?: number
        titleCalendarEventId?: string
      }>
      return {
        count: saved.length,
        reference: saved[0]?.reference,
        title: saved[0]?.title,
        titleCollectionCoordinate: saved[0]?.titleCollectionCoordinate,
        titleCollectionCreatedAt: saved[0]?.titleCollectionCreatedAt,
        titleCollectionEventId: saved[0]?.titleCollectionEventId,
        titleCalendarCoordinate: saved[0]?.titleCalendarCoordinate,
        titleCalendarCreatedAt: saved[0]?.titleCalendarCreatedAt,
        titleCalendarEventId: saved[0]?.titleCalendarEventId,
      }
    }, savedStorageKey)
  await expect.poll(readSavedTitleEvidence).toEqual({
    count: 1,
    reference: market.canonicalNaddr,
    title: eventTitle,
    ...expectedTitleEvidence,
  })

  await gotoAs(page, merchantUrl, "/events", "merchant")
  const shopperLink = `${marketUrl}/events/${market.canonicalNaddr}`
  await page.getByLabel("Open a known event").fill(shopperLink)
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(page.getByText(eventTitle, { exact: true }).first()).toBeVisible(
    {
      timeout: 30_000,
    }
  )
  await page.getByLabel("Open a known event").fill(market.canonicalNaddr)
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect.poll(readSavedTitleEvidence).toEqual({
    count: 1,
    reference: market.canonicalNaddr,
    title: eventTitle,
    ...expectedTitleEvidence,
  })
})

test("commerce discovery finds an organizer beyond the former author cap @merchant", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const title = "Synthetic discovered commerce event"
  const market = await publishOrganizerMarket(page, relay, {
    title,
    organizerHandoffEnabled: false,
  })
  const unrelated = Array.from({ length: 17 }, (_, index) =>
    (index + 1).toString(16).padStart(64, "0")
  )
  relay.seed(
    createFollowList(
      "merchant",
      [...unrelated, ORGANIZER_PUBKEY],
      market.initialCollection.created_at + 1
    )
  )
  await gotoAs(page, merchantUrl, "/events", "merchant")
  await expect(
    page.getByRole("button", { name: `Sell here ${title}`, exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await page
    .getByRole("button", { name: `Sell here ${title}`, exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: title, exact: true }).first()
  ).toBeVisible()
})

test("direct event import refreshes an anchored signed title despite missing pickup and retains its pickup frontier @merchant", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const eventTitle = "Synthetic title with unresolved pickup"
  const market = await publishOrganizerMarket(page, relay, {
    title: eventTitle,
    organizerHandoffEnabled: true,
  })
  const pickup = market.pickupEvent!
  relay.remove(pickup)
  const publicationCount = relay.publications.length
  // A fresh context prevents the organizer's previous Dexie readback from
  // supplying the deliberately missing pickup record to the merchant.
  const merchantContext = await browser.newContext()
  const merchantPage = await merchantContext.newPage()
  merchantPage.setDefaultTimeout(25_000)
  try {
    await installSyntheticEnvironment(
      merchantPage,
      relay,
      "missing-pickup-title"
    )
    await gotoAs(
      merchantPage,
      merchantUrl,
      market.merchantParticipationPath,
      "merchant"
    )
    const savedStorageKey = `conduit:merchant:discovered-event-markets:v1:${MERCHANT_PUBKEY}`
    const readSaved = () =>
      merchantPage.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<
          Record<string, unknown>
        >
        return { count: saved.length, ...saved[0] }
      }, savedStorageKey)
    const titleEvidence = {
      count: 1,
      reference: market.canonicalNaddr,
      title: eventTitle,
      titleCollectionCoordinate: market.collectionCoordinate,
      titleCollectionCreatedAt: market.initialCollection.created_at * 1_000,
      titleCollectionEventId: market.initialCollection.id,
      titleCalendarCoordinate: market.calendarCoordinate,
      titleCalendarCreatedAt: market.calendarEvent.created_at * 1_000,
      titleCalendarEventId: market.calendarEvent.id,
    }
    await expect
      .poll(readSaved, { timeout: 30_000 })
      .toMatchObject(titleEvidence)
    await expect(
      merchantPage.getByText(eventTitle, { exact: true }).first()
    ).toBeVisible()
    await expect(
      merchantPage.getByRole("button", { name: "Update event", exact: true })
    ).toHaveCount(0)

    // Retain an exact newer pickup frontier, while the relay can supply only
    // the older signed pickup. This must not downgrade the saved action evidence.
    const expectedPickup = signEvent(ORGANIZER_SECRET, {
      kind: pickup.kind,
      created_at: pickup.created_at + 10,
      tags: pickup.tags,
      content: pickup.content,
    })
    const pickupFrontier = {
      expectedPickupCoordinate: market.pickupCoordinate,
      expectedPickupCreatedAt: expectedPickup.created_at * 1_000,
      expectedPickupEventId: expectedPickup.id,
    }
    await merchantPage.evaluate(
      ({ key, frontier }) => {
        const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<
          Record<string, unknown>
        >
        saved[0] = {
          ...saved[0],
          ...frontier,
        }
        localStorage.setItem(key, JSON.stringify(saved))
      },
      { key: savedStorageKey, frontier: pickupFrontier }
    )
    // An existing signed title anchor must advance with newer coherent
    // collection/calendar evidence even while pickup is genuinely absent.
    const renamedTitle = "Synthetic newer title with unresolved pickup"
    const renamedCalendar = signEvent(ORGANIZER_SECRET, {
      kind: market.calendarEvent.kind,
      created_at: market.calendarEvent.created_at + 1,
      tags: market.calendarEvent.tags.map((tag) =>
        tag[0] === "title" ? ["title", renamedTitle] : tag
      ),
      content: market.calendarEvent.content,
    })
    const renamedCollection = signEvent(ORGANIZER_SECRET, {
      kind: market.initialCollection.kind,
      created_at: market.initialCollection.created_at + 1,
      tags: market.initialCollection.tags.map((tag) =>
        tag[0] === "title" ? ["title", renamedTitle] : tag
      ),
      content: market.initialCollection.content,
    })
    const renamedTitleEvidence = {
      ...titleEvidence,
      title: renamedTitle,
      titleCollectionCreatedAt: renamedCollection.created_at * 1_000,
      titleCollectionEventId: renamedCollection.id,
      titleCalendarCreatedAt: renamedCalendar.created_at * 1_000,
      titleCalendarEventId: renamedCalendar.id,
    }
    relay.seed(renamedCalendar, renamedCollection)
    await merchantPage.reload()
    await expect
      .poll(readSaved, { timeout: 30_000 })
      .toMatchObject({ ...renamedTitleEvidence, ...pickupFrontier })
    await expect(
      merchantPage.getByText(renamedTitle, { exact: true }).first()
    ).toBeVisible()
    await expect(
      merchantPage.getByRole("button", { name: "Update event", exact: true })
    ).toHaveCount(0)
    expect(relay.publications).toHaveLength(publicationCount)

    // Older pickup readback must not lower the retained action frontier either.
    relay.seed(pickup)
    await merchantPage.reload()
    await expect
      .poll(readSaved, { timeout: 30_000 })
      .toMatchObject({ ...renamedTitleEvidence, ...pickupFrontier })
    await expect(
      merchantPage.getByText(renamedTitle, { exact: true }).first()
    ).toBeVisible()
    await expect(
      merchantPage.getByRole("button", { name: "Update event", exact: true })
    ).toHaveCount(0)
    expect(relay.publications).toHaveLength(publicationCount)
  } finally {
    await merchantContext.close()
  }
})

test("current exact resolution refreshes a saved title without replacing its evidence @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const eventTitle = "Synthetic current resolved title"
  const market = await publishOrganizerMarket(page, relay, {
    title: eventTitle,
    organizerHandoffEnabled: false,
  })
  const [, collectionPubkey, collectionIdentifier] =
    market.collectionCoordinate.split(":")
  const hintedReference = nip19.naddrEncode({
    kind: 30405,
    pubkey: collectionPubkey!,
    identifier: collectionIdentifier!,
    // Mock mode retains only its isolated relay; multi-relay hint preservation
    // is covered by the saved-reference workflow tests.
    relays: [FIXTURE_RELAY],
  })
  const savedStorageKey = `conduit:merchant:discovered-event-markets:v1:${MERCHANT_PUBKEY}`
  const savedAt = 1_725_000_000_000
  const expectedSaved = {
    reference: hintedReference,
    title: "Cached title before current resolution",
    savedAt,
    titleCollectionCoordinate: market.collectionCoordinate,
    titleCollectionCreatedAt: market.initialCollection.created_at * 1_000,
    titleCollectionEventId: market.initialCollection.id,
    titleCalendarCoordinate: market.calendarCoordinate,
    titleCalendarCreatedAt: market.calendarEvent.created_at * 1_000,
    titleCalendarEventId: market.calendarEvent.id,
  }
  await page.evaluate(
    ({ key, saved }) => localStorage.setItem(key, JSON.stringify([saved])),
    { key: savedStorageKey, saved: expectedSaved }
  )

  await gotoAs(page, merchantUrl, "/events", "merchant")
  await expect(page.getByText(eventTitle, { exact: true }).first()).toBeVisible(
    {
      timeout: 30_000,
    }
  )
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<
          Record<string, unknown>
        >
        return saved[0]
      }, savedStorageKey)
    )
    .toEqual({ ...expectedSaved, title: eventTitle })
})

test("successful event rename keeps the new title cached @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const initialTitle = "Synthetic event before rename"
  const renamedTitle = "Synthetic event after rename"
  const market = await publishOrganizerMarket(page, relay, {
    title: initialTitle,
    organizerHandoffEnabled: false,
  })

  const updateStart = relay.publications.length
  await page.getByRole("button", { name: "Update event", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Update event market" })
  await editor
    .getByRole("textbox", { name: "Title Required", exact: true })
    .fill(renamedTitle)
  await editor.getByRole("button", { name: "Publish update" }).click()
  await expect(editor).toBeHidden({ timeout: 30_000 })

  const updatedCalendar = uniquePublishedEvents(
    relay.publications.slice(updateStart)
  ).find((event) => event.kind === market.calendarEvent.kind)
  expect(updatedCalendar).toBeTruthy()
  expect(eventCoordinate(updatedCalendar!)).toBe(market.calendarCoordinate)
  await expect(
    page.getByRole("button", { name: `Manage ${renamedTitle}`, exact: true })
  ).toBeVisible({ timeout: 30_000 })

  const savedStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
          title?: string
        }>
        return { count: saved.length, title: saved[0]?.title }
      }, savedStorageKey)
    )
    .toEqual({ count: 1, title: renamedTitle })

  await page.reload()
  await expect(
    page.getByRole("button", { name: `Manage ${renamedTitle}`, exact: true })
  ).toBeVisible({ timeout: 30_000 })
})

async function publishMerchantProductFromEvent(
  page: Page,
  relay: RelayHarness,
  market: PublishedOrganizerMarket,
  options: {
    eventTitle: string
    productTitle: string
    handoffMode: "merchant" | "organizer"
    templateTitle?: string
    discoveryMode?: "direct" | "followed"
    identity?: "merchant" | "organizer"
    rejectAcceptanceOnce?: boolean
  }
): Promise<SignedEvent> {
  await gotoAs(
    page,
    merchantUrl,
    options.discoveryMode ? "/events" : market.merchantParticipationPath,
    options.identity ?? "merchant"
  )
  await expect(
    page.getByRole("heading", { name: "Events", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Event timeline", exact: true })
  ).toBeVisible()

  if (options.discoveryMode === "followed") {
    const openEvent = page.getByRole("button", {
      name: new RegExp(`^(Sell here|Open|Manage) ${options.eventTitle}$`),
    })
    await expect(openEvent).toBeVisible({ timeout: 30_000 })
    await openEvent.click()
  } else if (options.discoveryMode === "direct") {
    await page.getByLabel("Open a known event").fill(market.canonicalNaddr)
    await page.getByRole("button", { name: "Open", exact: true }).click()
  }
  const publishProductButton = page.getByRole("button", {
    name: "Publish product",
    exact: true,
  })
  await expect(publishProductButton).toBeVisible({ timeout: 30_000 })
  await expect(publishProductButton).toBeEnabled({ timeout: 30_000 })

  await publishProductButton.click()
  const editor = page.getByRole("dialog", {
    name: `Publish a product to ${options.eventTitle}`,
  })
  await expect(editor).toBeVisible()
  await expect(
    editor.getByText("Lightning payments are not set up", { exact: true })
  ).toBeVisible({ timeout: 15_000 })
  const templateSelector = editor.getByLabel("Start from")
  if (options.templateTitle) {
    await templateSelector.click()
    await page
      .getByRole("option", { name: options.templateTitle, exact: true })
      .click()
    await expect(editor.getByLabel("Product title")).toHaveValue(
      options.templateTitle
    )
  } else {
    await expect(templateSelector).toContainText("Blank product")
  }
  await editor.getByLabel("Product title").fill(options.productTitle)
  await editor
    .getByLabel("Summary")
    .fill("Synthetic accepted zero-cost product fixture.")
  await editor.getByLabel("Price").fill("0")
  await editor.getByLabel("Stock (optional)").fill("3")
  await editor
    .getByLabel("Image URL")
    .fill(
      "https://cdn.conduit.market/conduit-test/synthetic-pickup-product.svg"
    )
  await editor.getByLabel("Tags").fill("synthetic, event, pickup")

  if (options.handoffMode === "organizer") {
    await editor.getByRole("button", { name: /Organizer hands it out/ }).click()
  } else {
    await editor
      .getByLabel("Pickup point or booth")
      .fill("Synthetic Fixture Hall, Booth 12")
    await editor.getByLabel("Country").fill("US")
  }

  const publishStart = relay.publications.length
  if (options.rejectAcceptanceOnce) relay.rejectKind(30405, true)
  await editor
    .getByRole("button", {
      name:
        options.identity === "organizer"
          ? "Publish and accept product"
          : "Publish product",
      exact: true,
    })
    .click()
  if (options.rejectAcceptanceOnce) {
    await expect(
      editor.getByRole("button", { name: "Retry acceptance", exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      editor.getByRole("button", {
        name: "Publish and accept product",
        exact: true,
      })
    ).toHaveCount(0)
    expect(
      uniquePublishedEvents(relay.publications.slice(publishStart)).filter(
        (event) => event.kind === 30402
      )
    ).toHaveLength(1)
    relay.rejectKind(30405, false)
    await editor
      .getByRole("button", { name: "Retry acceptance", exact: true })
      .click()
  }
  await expect(editor).toBeHidden({ timeout: 30_000 })
  await expect(
    page.getByText(
      options.identity === "organizer"
        ? "Product published and accepted into your event."
        : "Product published. Organizer acceptance is pending.",
      {
        exact: true,
      }
    )
  ).toBeVisible({ timeout: 30_000 })

  const published = uniquePublishedEvents(
    relay.publications.slice(publishStart)
  )
  const productEvent = published.find((event) => event.kind === 30402)
  expect(productEvent).toBeTruthy()
  expect(productEvent!.pubkey).toBe(
    options.identity === "organizer" ? ORGANIZER_PUBKEY : MERCHANT_PUBKEY
  )
  expect(productEvent!.tags).toContainEqual(["a", market.collectionCoordinate])
  expect(productEvent!.tags).toContainEqual(["price", "0", "SATS"])
  const pickupCoordinate = productEvent!.tags.find(
    (tag) => tag[0] === "shipping_option"
  )?.[1]
  expect(pickupCoordinate).toBe(
    options.handoffMode === "organizer"
      ? market.pickupCoordinate
      : published.find((event) => event.kind === 30406)
        ? eventCoordinate(published.find((event) => event.kind === 30406)!)
        : undefined
  )

  return productEvent!
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

function createMerchantProductEvent(input: {
  dTag: string
  title: string
  collectionCoordinate: string
  pickupCoordinate: string
  createdAt: number
  priceSats?: number
}): SignedEvent {
  return signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: input.createdAt,
    content: `${input.title} synthetic browser-only fixture.`,
    tags: [
      ["d", input.dTag],
      ["title", input.title],
      ["summary", "Synthetic accepted product fixture."],
      ["price", String(input.priceSats ?? 0), "SAT"],
      ["type", "simple", "physical"],
      ["stock", "3"],
      [
        "image",
        "https://cdn.conduit.market/conduit-test/synthetic-pickup-product.svg",
      ],
      ["a", input.collectionCoordinate],
      ["shipping_option", input.pickupCoordinate, "0"],
    ],
  })
}

async function acceptMerchantProduct(
  page: Page,
  relay: RelayHarness,
  productEvent: SignedEvent,
  expectedCollectionCoordinate: string
): Promise<SignedEvent> {
  relay.seed(productEvent)
  await page.getByRole("button", { name: "Refresh evidence" }).click()
  await expect(page.getByText("Pending request", { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  const productTitle = productEvent.tags.find((tag) => tag[0] === "title")?.[1]
  const productSummary = productEvent.tags.find(
    (tag) => tag[0] === "summary"
  )?.[1]
  expect(productTitle).toBeTruthy()
  expect(productSummary).toBeTruthy()
  const productPreview = page.getByTestId("organizer-product-preview")
  await expect(productPreview).toHaveAttribute("data-preview-state", "verified")
  await expect(
    productPreview.getByText(productTitle!, { exact: true })
  ).toBeVisible()
  await expect(
    productPreview.getByText(productSummary!, {
      exact: true,
    })
  ).toBeVisible()
  const acceptanceStart = relay.publications.length
  await page.getByRole("button", { name: "Accept", exact: true }).click()
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  const acceptedCollection = uniquePublishedEvents(
    relay.publications.slice(acceptanceStart)
  ).find((event) => event.kind === 30405)
  expect(acceptedCollection).toBeTruthy()
  expect(eventCoordinate(acceptedCollection!)).toBe(
    expectedCollectionCoordinate
  )
  expect(acceptedCollection!.tags).toContainEqual([
    "a",
    eventCoordinate(productEvent),
  ])
  return acceptedCollection!
}

async function selectOrganizerMarket(page: Page, title: string): Promise<void> {
  const manage = page.getByRole("button", {
    name: `Manage ${title}`,
    exact: true,
  })
  await expect(manage).toBeVisible({ timeout: 30_000 })
  await manage.click()
  await expect(
    page.getByRole("heading", { name: title, exact: true }).first()
  ).toBeVisible()
}

test.use({
  viewport: { width: 1440, height: 1000 },
  video: "off",
  trace: "off",
  screenshot: "off",
})

async function expectContainedEventBanner(page: Page): Promise<void> {
  const banner = page
    .locator(
      'img[src="https://cdn.conduit.market/conduit-test/synthetic-event-market.svg"]'
    )
    .last()
  await expect(banner).toBeVisible({ timeout: 30_000 })

  // A freshly loaded Vite document can paint the image before its stylesheet is
  // applied. Keep the assertion strict, but give the computed presentation a
  // moment to settle instead of making the whole smoke test retry-dependent.
  await expect
    .poll(() => banner.evaluate((image) => getComputedStyle(image).objectFit), {
      timeout: 10_000,
    })
    .toBe("contain")
  await expect
    .poll(
      () => banner.evaluate((image) => getComputedStyle(image).backgroundColor),
      { timeout: 10_000 }
    )
    .not.toBe("rgba(0, 0, 0, 0)")
  await expect
    .poll(
      () =>
        banner.evaluate((image) => image.complete && image.naturalWidth > 0),
      {
        timeout: 10_000,
      }
    )
    .toBe(true)

  const metrics = await banner.evaluate((image) => {
    const bounds = image.getBoundingClientRect()
    return {
      naturalRatio: image.naturalWidth / image.naturalHeight,
      renderedRatio: bounds.width / bounds.height,
    }
  })

  expect(
    Math.abs(metrics.renderedRatio - metrics.naturalRatio)
  ).toBeGreaterThan(0.05)
}

test("event banners remain fully contained on every surface and viewport @market @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Banner Review",
    organizerHandoffEnabled: true,
  })

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await expectContainedEventBanner(page)
  }

  await gotoAs(page, merchantUrl, market.merchantParticipationPath, "merchant")
  await expect(
    page.getByRole("button", { name: "Publish product", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await expectContainedEventBanner(page)
  }

  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", { name: "Synthetic Banner Review" })
  ).toBeVisible({ timeout: 30_000 })
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await expectContainedEventBanner(page)
  }
})

test("event catalog shops products by search, merchant, and sort before technical pickup records @market", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(30_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  // A correctly prepared banner must occupy the complete 3:1 frame.
  // Other event-banner coverage keeps a mismatched 2:1 source to verify fitting.
  await page.route(
    "https://cdn.conduit.market/conduit-test/synthetic-event-market.svg",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="600"><rect width="1800" height="600" fill="#211e31"/><rect x="12" y="12" width="1776" height="576" rx="20" fill="none" stroke="#bb00ff" stroke-width="8"/><text x="900" y="280" text-anchor="middle" fill="white" font-family="sans-serif" font-size="100">3:1 event banner</text><text x="900" y="390" text-anchor="middle" fill="white" font-family="sans-serif" font-size="48">1800 × 600 · full artwork visible</text></svg>',
      })
  )
  const eventTitle = "Synthetic Shopping Event"
  const market = await publishOrganizerMarket(page, relay, {
    title: eventTitle,
    organizerHandoffEnabled: true,
  })
  const createdAt = market.initialCollection.created_at + 1
  const secondMerchantSecret = generateSecretKey()
  const organizerNip05Suffix = "@identity.conduit.market"
  const organizerNip05Name = "o".repeat(100 - organizerNip05Suffix.length)
  const organizerNip05 = `${organizerNip05Name}${organizerNip05Suffix}`
  expect(organizerNip05).toHaveLength(100)
  await page.route(
    "https://identity.conduit.market/.well-known/nostr.json*",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          names: { [organizerNip05Name]: ORGANIZER_PUBKEY },
        }),
      })
  )
  const pickupGeohash = "dp3wj"
  const pickupLocation = market.pickupEvent!.tags.find(
    (tag) => tag[0] === "location"
  )![1]!
  const pickups = Array.from({ length: 26 }, (_, index) =>
    signEvent(
      index === 1 || index === 2 || (index >= 4 && index % 2 === 1)
        ? secondMerchantSecret
        : MERCHANT_SECRET,
      {
        kind: 30406,
        created_at: createdAt,
        content: market.pickupEvent!.content,
        tags: [
          ...market
            .pickupEvent!.tags.filter(
              (tag) => tag[0] !== "g" && (index !== 0 || tag[0] !== "location")
            )
            .map((tag) =>
              tag[0] === "d" ? ["d", `shopping-pickup-${index}`] : tag
            ),
          ["g", pickupGeohash],
        ],
      }
    )
  )
  const productSpecs = [
    { title: "Amber Mug", price: 3000, secret: MERCHANT_SECRET },
    { title: "Blue Tote", price: 1000, secret: secondMerchantSecret },
    { title: "Cedar Mug", price: 2000, secret: secondMerchantSecret },
    { title: "Dawn Coffee", price: 4000, secret: MERCHANT_SECRET },
  ]
  const products = productSpecs.map((spec, index) => {
    const template = createMerchantProductEvent({
      dTag: `shopping-product-${index}`,
      title: spec.title,
      collectionCoordinate: market.collectionCoordinate,
      pickupCoordinate: eventCoordinate(pickups[index]!),
      createdAt,
      priceSats: spec.price,
    })
    return signEvent(spec.secret, {
      kind: template.kind,
      created_at: template.created_at,
      content: template.content,
      tags: template.tags,
    })
  })
  const collection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: createdAt,
    content: market.initialCollection.content,
    tags: [
      ...market.initialCollection.tags.filter(
        (tag) => tag[0] !== "shipping_option"
      ),
      ...products.map((product) => ["a", eventCoordinate(product)]),
    ],
  })
  relay.seed(
    ...pickups,
    ...products,
    collection,
    signEvent(ORGANIZER_SECRET, {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify({
        display_name: "Event organizer",
        nip05: organizerNip05,
      }),
    }),
    ...[
      { secret: MERCHANT_SECRET, name: "Alpine Goods" },
      { secret: secondMerchantSecret, name: "Bay Coffee" },
    ].map(({ secret, name }) =>
      signEvent(secret, {
        kind: 0,
        created_at: createdAt,
        tags: [],
        content: JSON.stringify({ display_name: name }),
      })
    )
  )
  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  const catalogUrl = page.url()
  const shopHeading = page.getByRole("heading", { name: "Shop the event" })
  const banner = page.getByRole("img", { name: `${eventTitle} banner` })
  const cards = page.getByRole("listitem").filter({
    has: page.getByRole("heading", {
      name: /^(Amber Mug|Blue Tote|Cedar Mug|Dawn Coffee)$/,
    }),
  })
  const titles = cards.getByRole("heading", { level: 3 })
  const search = page.getByRole("searchbox", {
    name: "Search products or merchants",
  })
  const merchant = page.getByRole("combobox", { name: "Merchant", exact: true })
  const sort = page.getByRole("combobox", { name: "Sort products" })
  const technicalSummary = page.locator("summary").filter({
    hasText: /^Technical details\s*$/,
  })
  const technicalDetails = technicalSummary.locator("..")
  await expect(shopHeading).toBeVisible()
  await expect(banner).toBeVisible()
  await expect(titles).toHaveText(productSpecs.map((spec) => spec.title))
  await expect(
    cards.getByRole("button", { name: "Add", exact: true })
  ).toHaveCount(4)
  for (const card of await cards.all()) {
    await expect(
      card.getByRole("button", { name: "Add", exact: true })
    ).toBeEnabled()
  }
  await expect(
    cards.first().getByRole("button", { name: "Alpine Goods", exact: true })
  ).toBeVisible()
  await expect(technicalDetails).not.toHaveAttribute("open", "")
  // Geohash-only pickups retain their location; readable text takes precedence.
  for (const [index, location] of [pickupGeohash, pickupLocation].entries()) {
    const details = cards.nth(index).locator("details")
    await details.locator("summary").click()
    await expect(details.getByText(location, { exact: true })).toBeVisible()
    if (index === 1) {
      await expect(
        details.getByText(pickupGeohash, { exact: true })
      ).toHaveCount(0)
    }
    await details.locator("summary").click()
  }
  await expect(
    page.getByRole("button", { name: "All products", exact: true })
  ).toHaveAttribute("aria-pressed", "true")

  await sort.click()
  await page
    .getByRole("option", { name: "Price: low to high", exact: true })
    .click()
  await expect(titles).toHaveText([
    "Blue Tote",
    "Cedar Mug",
    "Amber Mug",
    "Dawn Coffee",
  ])
  await sort.click()
  await page
    .getByRole("option", { name: "Price: high to low", exact: true })
    .click()
  await expect(titles).toHaveText([
    "Dawn Coffee",
    "Amber Mug",
    "Cedar Mug",
    "Blue Tote",
  ])
  await sort.click()
  await page.getByRole("option", { name: "Merchant A–Z", exact: true }).click()
  await expect(titles).toHaveText([
    "Amber Mug",
    "Dawn Coffee",
    "Blue Tote",
    "Cedar Mug",
  ])
  await sort.click()
  await page.getByRole("option", { name: "Name A–Z", exact: true }).click()

  await search.fill("mug")
  await expect(titles).toHaveText(["Amber Mug", "Cedar Mug"])
  await merchant.click()
  await page.getByRole("option", { name: /Bay Coffee/ }).click()
  await expect(titles).toHaveText(["Cedar Mug"])
  await search.fill("coffee")
  // Merchant names are searchable, and the selected merchant narrows results.
  await expect(titles).toHaveText(["Blue Tote", "Cedar Mug"])
  await search.fill("no matching item")
  await expect(cards).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "No matching products", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await expect(search).toHaveValue("")
  await expect(merchant).toContainText("All merchants")
  await expect(titles).toHaveText(productSpecs.map((spec) => spec.title))

  await merchant.click()
  await page.getByRole("option", { name: /Alpine Goods/ }).click()
  await expect(titles).toHaveText(["Amber Mug", "Dawn Coffee"])
  await merchant.click()
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("Enter")
  await expect(merchant).toContainText("All merchants")
  await expect(titles).toHaveText(productSpecs.map((spec) => spec.title))
  await merchant.click()
  await page.keyboard.press("Enter")
  await expect(merchant).toContainText("All merchants")
  await expect(titles).toHaveText(productSpecs.map((spec) => spec.title))

  await cards
    .first()
    .getByRole("button", { name: "Alpine Goods", exact: true })
    .click()
  await expect(titles).toHaveText(["Amber Mug", "Dawn Coffee"])
  expect(page.url()).toBe(catalogUrl)
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await page.getByRole("button", { name: "By merchant", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "By merchant", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  for (const name of ["Alpine Goods", "Bay Coffee"]) {
    const heading = page.getByRole("heading", { name, exact: true })
    await expect(heading).toBeVisible()
    await expect(heading.locator("..")).toContainText("2 products")
  }
  await expect(titles).toHaveText([
    "Amber Mug",
    "Dawn Coffee",
    "Blue Tote",
    "Cedar Mug",
  ])
  await page.getByRole("button", { name: "All products", exact: true }).click()

  // Add many accepted merchant-owned pickup records through valid products.
  // The collection itself supports at most one organizer pickup; each merchant
  // product references its own same-author handoff option instead.
  const extraProducts = pickups.slice(4).map((pickup, index) => {
    const template = createMerchantProductEvent({
      dTag: `shopping-extra-${index}`,
      title: `Fixture item ${String(index + 5).padStart(2, "0")}`,
      collectionCoordinate: market.collectionCoordinate,
      pickupCoordinate: eventCoordinate(pickup),
      createdAt: createdAt + 1,
      priceSats: 5000 + index,
    })
    return signEvent(index % 2 === 1 ? secondMerchantSecret : MERCHANT_SECRET, {
      kind: template.kind,
      created_at: template.created_at,
      content: template.content,
      tags: template.tags,
    })
  })
  relay.seed(
    ...extraProducts,
    signEvent(ORGANIZER_SECRET, {
      kind: collection.kind,
      created_at: createdAt + 1,
      content: collection.content,
      tags: [
        ...collection.tags,
        ...extraProducts.map((product) => ["a", eventCoordinate(product)]),
      ],
    })
  )
  await page.reload()
  await expect(
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { level: 3 }) })
  ).toHaveCount(26)
  await expect(
    cards.first().getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()

  // A large pickup record set must remain available without pushing the catalog
  // below the record list, on both desktop and narrow mobile screens.
  for (const viewport of [
    { width: 1440, height: 1000, name: "desktop" },
    { width: 390, height: 844, name: "mobile" },
  ]) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(banner).toBeVisible()
    await expect
      .poll(() =>
        banner.evaluate((image) => {
          const bounds = image.getBoundingClientRect()
          return bounds.width / bounds.height
        })
      )
      .toBeCloseTo(3, 2)
    await expect
      .poll(() =>
        banner.evaluate((image) => image.naturalWidth / image.naturalHeight)
      )
      .toBe(3)
    await expect(search).toBeVisible()
    const organizerLabel = page.getByText(organizerNip05, { exact: true })
    await expect(organizerLabel).toBeVisible()
    if (viewport.name === "mobile") {
      const labelSize = await organizerLabel.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: element.getBoundingClientRect().right,
      }))
      expect(labelSize.width).toBeGreaterThan(0)
      expect(labelSize.scrollWidth).toBeGreaterThan(labelSize.width)
      expect(labelSize.right).toBeLessThanOrEqual(viewport.width)
    }
    await search.fill("Alpine Goods")
    await expect(titles).toHaveText(["Amber Mug", "Dawn Coffee"])
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click()
    await expect(titles).toHaveText(productSpecs.map((spec) => spec.title))
    await expect(technicalDetails).not.toHaveAttribute("open", "")
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1)
    const firstProductBounds = await cards.first().boundingBox()
    const technicalBounds = await technicalSummary.boundingBox()
    expect(firstProductBounds).not.toBeNull()
    expect(technicalBounds).not.toBeNull()
    expect(firstProductBounds!.y).toBeLessThan(technicalBounds!.y)
    // The first product is close to the header even with 26 pickup records.
    expect(firstProductBounds!.y).toBeLessThan(viewport.height * 1.5)
  }
  await technicalSummary.focus()
  await technicalSummary.press("Enter")
  await expect(technicalDetails).toHaveAttribute("open", "")
  await expect(technicalDetails.getByText(/^Pickup: /)).toHaveCount(26)
  await expect(
    technicalDetails.getByText("Product list", { exact: true })
  ).toBeVisible()
})

test("Market Events browses the same perspective on desktop, mobile, and keyboard @market", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(30_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Timeline Event",
    organizerHandoffEnabled: true,
  })

  // Guests get the curated Conduit perspective without a signer prompt, even
  // though this synthetic organizer is outside that perspective.
  await page.evaluate(() => localStorage.clear())
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${marketUrl}/events`)
  await expect(page.getByRole("heading", { name: "Events" })).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "Market browse" })
  ).toBeVisible()
  await expect(
    page.getByRole("group", { name: "Market perspective" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Conduit", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("button", { name: "Following", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("dialog", { name: "Sign in to Conduit" })
  ).toHaveCount(0)

  relay.seed(
    createFollowList(
      "buyer",
      [ORGANIZER_PUBKEY],
      Math.floor(Date.now() / 1000) + 1
    )
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoAs(page, marketUrl, "/events", "buyer", {
    source: "following",
    window: "all",
  })

  const eventCard = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Synthetic Timeline Event" }),
  })
  await expect(eventCard).toBeVisible({ timeout: 60_000 })
  await expect(eventCard.getByText("Synthetic Fixture Hall")).toBeVisible()
  await expect(eventCard.getByText("Upcoming", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Following", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1)

  const perspectiveButtons = page.getByRole("group", {
    name: "Market perspective",
  })
  await perspectiveButtons
    .getByRole("button", { name: "Conduit", exact: true })
    .focus()
  await page.keyboard.press("Tab")
  await expect(
    page.getByRole("button", { name: "Clear filters" })
  ).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByLabel("Date")).toBeFocused()

  const viewLink = eventCard.getByRole("link", { name: "View" })
  await viewLink.focus()
  await expect(viewLink).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(
    new RegExp(
      `/events/${market.canonicalNaddr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    )
  )
  await expect(
    page.getByRole("heading", { name: "Synthetic Timeline Event" })
  ).toBeVisible({ timeout: 60_000 })
})

test("late publish completion preserves a newly selected event @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const eventA = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Race Event A",
    organizerHandoffEnabled: true,
  })
  await expect
    .poll(
      () =>
        new URL(page.url()).searchParams.get("event") === eventA.canonicalNaddr
    )
    .toBe(true)
  let held: HeldRelayRequest
  await publishOrganizerMarket(page, relay, {
    title: "Synthetic Race Event B",
    organizerHandoffEnabled: false,
    beforePublish: (start) => {
      held = relay.holdRelayRequests((request) => {
        const collection = relay.publications
          .slice(start)
          .find((entry) => entry.event.kind === 30405)?.event
        if (!collection) return false
        return request.filters.some((filter) =>
          eventMatchesFilter(collection, filter)
        )
      })
    },
    afterEditorClosed: async () => {
      await held.captured
      await page
        .getByRole("button", {
          name: "Manage Synthetic Race Event A",
          exact: true,
        })
        .click()
      await expect
        .poll(
          () =>
            new URL(page.url()).searchParams.get("event") ===
            eventA.canonicalNaddr
        )
        .toBe(true)
      await expect(
        page.getByRole("heading", {
          name: "Synthetic Race Event A",
          exact: true,
        })
      ).toHaveCount(2)
      held.release()
      // The account mutation stays pending through the final publish callback.
      // Wait for it to settle before proving the newer selection is retained.
      await expect(
        page.getByRole("button", { name: "Create event", exact: true }).first()
      ).toBeEnabled()
      await expect
        .poll(
          () =>
            new URL(page.url()).searchParams.get("event") ===
            eventA.canonicalNaddr
        )
        .toBe(true)
      await expect(
        page.getByRole("heading", {
          name: "Synthetic Race Event A",
          exact: true,
        })
      ).toHaveCount(2)
      // Reopen B so the shared publication helper can verify its saved records.
      await page
        .getByRole("button", {
          name: "Manage Synthetic Race Event B",
          exact: true,
        })
        .click()
    },
  })
})

test("event membership and retry completions stay bound to their initiating event @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const eventA = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Race Event A",
    organizerHandoffEnabled: true,
  })
  const eventB = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Race Event B",
    organizerHandoffEnabled: false,
  })
  const product = createMerchantProductEvent({
    dTag: "event-selection-race-product",
    title: "Synthetic Event A Race Product",
    collectionCoordinate: eventA.collectionCoordinate,
    pickupCoordinate: eventA.pickupCoordinate!,
    createdAt: eventA.initialCollection.created_at + 1,
  })
  relay.seed(product)

  await selectOrganizerMarket(page, "Synthetic Race Event A")
  await page.getByRole("button", { name: "Refresh evidence" }).click()
  await expect(page.getByText("Pending request", { exact: true })).toBeVisible()

  const membershipAck = relay.holdNextPublicationAck(
    (event) =>
      event.kind === 30405 &&
      eventCoordinate(event) === eventA.collectionCoordinate &&
      event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === eventCoordinate(product)
      )
  )
  await page.getByRole("button", { name: "Accept", exact: true }).click()
  const acceptedCollection = await membershipAck.captured
  await selectOrganizerMarket(page, "Synthetic Race Event B")
  membershipAck.release()

  const savedStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  const deliveryStorageKey = `conduit:merchant:event-market-delivery:v1:${ORGANIZER_PUBKEY}`
  await expect
    .poll(() =>
      page.evaluate(
        ({ key, eventATitle, eventBTitle }) => {
          const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
            title?: string
            expectedCollectionEventId?: string
          }>
          return {
            eventA: saved.find((entry) => entry.title === eventATitle)
              ?.expectedCollectionEventId,
            eventB: saved.find((entry) => entry.title === eventBTitle)
              ?.expectedCollectionEventId,
          }
        },
        {
          key: savedStorageKey,
          eventATitle: "Synthetic Race Event A",
          eventBTitle: "Synthetic Race Event B",
        }
      )
    )
    .toEqual({
      eventA: acceptedCollection.id,
      eventB: eventB.initialCollection.id,
    })
  await expect(
    page
      .getByRole("heading", { name: "Synthetic Race Event B", exact: true })
      .first()
  ).toBeVisible()

  const membershipDeliveryReference = await page.evaluate(
    ({ key, eventId }) => {
      const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
        reference?: string
        delivery?: { signedEvent?: { id?: string } }
      }>
      return saved.find((entry) => entry.delivery?.signedEvent?.id === eventId)
        ?.reference
    },
    { key: deliveryStorageKey, eventId: acceptedCollection.id }
  )
  expect(membershipDeliveryReference).toBeTruthy()
  expect(eventCollectionReferenceCoordinate(membershipDeliveryReference!)).toBe(
    eventA.collectionCoordinate
  )

  const markedForRetry = await page.evaluate(
    ({ key, eventId }) => {
      const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
        delivery?: {
          acknowledgedCount?: number
          rejectedCount?: number
          timedOutCount?: number
          signedEvent?: { id?: string }
        }
      }>
      const entry = saved.find(
        (candidate) => candidate.delivery?.signedEvent?.id === eventId
      )
      if (!entry?.delivery) return false
      entry.delivery.acknowledgedCount = 0
      entry.delivery.rejectedCount = 0
      entry.delivery.timedOutCount = 1
      localStorage.setItem(key, JSON.stringify(saved))
      return true
    },
    { key: deliveryStorageKey, eventId: acceptedCollection.id }
  )
  expect(markedForRetry).toBe(true)

  await page.reload()
  await selectOrganizerMarket(page, "Synthetic Race Event A")
  const retryAck = relay.holdNextPublicationAck(
    (event) => event.id === acceptedCollection.id
  )
  await page.getByRole("button", { name: "Retry delivery" }).click()
  await retryAck.captured
  await selectOrganizerMarket(page, "Synthetic Race Event B")
  retryAck.release()

  await expect
    .poll(() =>
      page.evaluate(
        ({ savedKey, deliveryKey, eventATitle, eventBTitle, eventId }) => {
          const references = JSON.parse(
            localStorage.getItem(savedKey) ?? "[]"
          ) as Array<{ title?: string; expectedCollectionEventId?: string }>
          const deliveries = JSON.parse(
            localStorage.getItem(deliveryKey) ?? "[]"
          ) as Array<{
            reference?: string
            delivery?: {
              acknowledgedCount?: number
              signedEvent?: { id?: string }
            }
          }>
          const retried = deliveries.find(
            (entry) => entry.delivery?.signedEvent?.id === eventId
          )
          return {
            eventA: references.find((entry) => entry.title === eventATitle)
              ?.expectedCollectionEventId,
            eventB: references.find((entry) => entry.title === eventBTitle)
              ?.expectedCollectionEventId,
            acknowledgedCount: retried?.delivery?.acknowledgedCount,
            deliveryReference: retried?.reference,
          }
        },
        {
          savedKey: savedStorageKey,
          deliveryKey: deliveryStorageKey,
          eventATitle: "Synthetic Race Event A",
          eventBTitle: "Synthetic Race Event B",
          eventId: acceptedCollection.id,
        }
      )
    )
    .toMatchObject({
      eventA: acceptedCollection.id,
      eventB: eventB.initialCollection.id,
      acknowledgedCount: 1,
    })
  const retryDeliveryReference = await page.evaluate(
    ({ key, eventId }) => {
      const deliveries = JSON.parse(
        localStorage.getItem(key) ?? "[]"
      ) as Array<{
        reference?: string
        delivery?: { signedEvent?: { id?: string } }
      }>
      return deliveries.find(
        (entry) => entry.delivery?.signedEvent?.id === eventId
      )?.reference
    },
    { key: deliveryStorageKey, eventId: acceptedCollection.id }
  )
  expect(retryDeliveryReference).toBeTruthy()
  expect(eventCollectionReferenceCoordinate(retryDeliveryReference!)).toBe(
    eventA.collectionCoordinate
  )
  await expect(
    page
      .getByRole("heading", { name: "Synthetic Race Event B", exact: true })
      .first()
  ).toBeVisible()
})

test("keeps consecutive membership actions available while acknowledged collection readback is stale @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Membership Readback",
    organizerHandoffEnabled: true,
  })
  const firstProduct = createMerchantProductEvent({
    dTag: "membership-readback-first",
    title: "Synthetic first pending product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
  })
  const secondProduct = createMerchantProductEvent({
    dTag: "membership-readback-second",
    title: "Synthetic second pending product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 2,
  })
  relay.seed(firstProduct, secondProduct)
  await page.getByRole("button", { name: "Refresh evidence" }).click()

  const participationRow = (title: string) =>
    page
      .getByTestId("organizer-product-preview")
      .filter({ hasText: title })
      .locator("..")
  const firstRow = participationRow("Synthetic first pending product")
  const secondRow = participationRow("Synthetic second pending product")
  await expect(firstRow.getByRole("button", { name: "Accept" })).toBeEnabled()
  await expect(secondRow.getByRole("button", { name: "Accept" })).toBeEnabled()

  const firstMembershipAck = relay.holdNextPublicationAck(
    (event) =>
      event.kind === 30405 &&
      eventCoordinate(event) === market.collectionCoordinate &&
      event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === eventCoordinate(firstProduct)
      )
  )
  await firstRow.getByRole("button", { name: "Accept" }).click()
  const firstCollection = await firstMembershipAck.captured
  relay.remove(firstCollection)

  const staleExactRead = relay.holdRelayRequests((request) =>
    request.filters.some(
      (filter) =>
        filter.authors?.includes(ORGANIZER_PUBKEY) &&
        filter.kinds?.includes(30405)
    )
  )
  let secondMembershipAck: HeldPublicationAck | undefined
  try {
    firstMembershipAck.release()
    await staleExactRead.captured
    staleExactRead.release()

    const secondAccept = secondRow.getByRole("button", { name: "Accept" })
    await expect(secondAccept).toBeEnabled({ timeout: 5_000 })
    secondMembershipAck = relay.holdNextPublicationAck(
      (event) =>
        event.kind === 30405 &&
        eventCoordinate(event) === market.collectionCoordinate &&
        event.tags.some(
          (tag) => tag[0] === "a" && tag[1] === eventCoordinate(secondProduct)
        )
    )
    await secondAccept.click()
    const nextCollection = await secondMembershipAck.captured
    expect(nextCollection.tags).toContainEqual([
      "a",
      eventCoordinate(firstProduct),
    ])
    expect(nextCollection.tags).toContainEqual([
      "a",
      eventCoordinate(secondProduct),
    ])
  } finally {
    secondMembershipAck?.release()
    staleExactRead.release()
  }
})

test("keeps exact collection retry available while rejected membership readback is stale @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Rejected Membership Retry",
    organizerHandoffEnabled: true,
  })
  const requestedProduct = createMerchantProductEvent({
    dTag: "rejected-membership-retry",
    title: "Synthetic rejected membership product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
  })
  relay.seed(requestedProduct)
  await page.getByRole("button", { name: "Refresh evidence" }).click()

  const participationRow = page
    .getByTestId("organizer-product-preview")
    .filter({ hasText: "Synthetic rejected membership product" })
    .locator("..")
  const acceptProduct = participationRow.getByRole("button", {
    name: "Accept",
    exact: true,
  })
  await expect(acceptProduct).toBeEnabled()

  const membershipPublishStart = relay.publications.length
  relay.rejectKind(30405, true)
  await acceptProduct.click()
  const findRejectedCollection = () =>
    uniquePublishedEvents(
      relay.publications.slice(membershipPublishStart)
    ).find(
      (event) =>
        event.kind === 30405 &&
        eventCoordinate(event) === market.collectionCoordinate &&
        event.tags.some(
          (tag) =>
            tag[0] === "a" && tag[1] === eventCoordinate(requestedProduct)
        )
    )
  await expect
    .poll(() => findRejectedCollection()?.id, { timeout: 30_000 })
    .not.toBeUndefined()
  const rejectedCollection = findRejectedCollection()!
  await expect(
    page.getByText(
      "No relay acknowledged the signed collection event record.",
      { exact: true }
    )
  ).toBeVisible({ timeout: 30_000 })
  relay.rejectKind(30405, false)

  const savedStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  const deliveryStorageKey = `conduit:merchant:event-market-delivery:v1:${ORGANIZER_PUBKEY}`
  await expect
    .poll(() =>
      page.evaluate(
        ({ savedKey, deliveryKey, eventId }) => {
          const references = JSON.parse(
            localStorage.getItem(savedKey) ?? "[]"
          ) as Array<{ expectedCollectionEventId?: string }>
          const deliveries = JSON.parse(
            localStorage.getItem(deliveryKey) ?? "[]"
          ) as Array<{
            delivery?: {
              acknowledgedCount?: number
              signedEvent?: { id?: string }
            }
          }>
          return {
            expectedCollectionEventId: references[0]?.expectedCollectionEventId,
            acknowledgedCount: deliveries.find(
              (entry) => entry.delivery?.signedEvent?.id === eventId
            )?.delivery?.acknowledgedCount,
          }
        },
        {
          savedKey: savedStorageKey,
          deliveryKey: deliveryStorageKey,
          eventId: rejectedCollection.id,
        }
      )
    )
    .toEqual({
      expectedCollectionEventId: rejectedCollection.id,
      acknowledgedCount: 0,
    })

  await page.reload()
  await selectOrganizerMarket(page, "Synthetic Rejected Membership Retry")
  await expect(
    page.getByText("Showing earlier signed event evidence", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(acceptProduct).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Update event", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("heading", { name: "Organizer handoff queue", exact: true })
  ).toHaveCount(0)

  const retryDelivery = page.getByRole("button", {
    name: "Retry delivery",
    exact: true,
  })
  await expect(retryDelivery).toBeEnabled()
  const retryPublishStart = relay.publications.length
  await retryDelivery.click()
  await expect
    .poll(
      () =>
        relay.publications
          .slice(retryPublishStart)
          .map((publication) => publication.event.id),
      { timeout: 30_000 }
    )
    .toContain(rejectedCollection.id)
})

test("a late old collection retry ACK preserves a newer same-coordinate update @merchant", async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Late Retry Event",
    organizerHandoffEnabled: true,
  })
  const savedStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  const deliveryStorageKey = `conduit:merchant:event-market-delivery:v1:${ORGANIZER_PUBKEY}`
  const markedForRetry = await page.evaluate(
    ({ key, eventId }) => {
      const rows = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
        delivery?: {
          acknowledgedCount?: number
          rejectedCount?: number
          timedOutCount?: number
          signedEvent?: { id?: string }
        }
      }>
      const row = rows.find(
        (candidate) => candidate.delivery?.signedEvent?.id === eventId
      )
      if (!row?.delivery) return false
      row.delivery.acknowledgedCount = 0
      row.delivery.rejectedCount = 0
      row.delivery.timedOutCount = 1
      localStorage.setItem(key, JSON.stringify(rows))
      return true
    },
    { key: deliveryStorageKey, eventId: market.initialCollection.id }
  )
  expect(markedForRetry).toBe(true)

  await page.reload()
  await selectOrganizerMarket(page, "Synthetic Late Retry Event")
  const savedReferences = await page.evaluate(
    (key) => localStorage.getItem(key),
    savedStorageKey
  )
  expect(savedReferences).toBeTruthy()
  const concurrentContext = await browser.newContext()
  const concurrentPage = await concurrentContext.newPage()
  await installSyntheticEnvironment(concurrentPage, relay, "late-retry-mutator")
  await concurrentPage.addInitScript(
    ({ key, references }) => {
      if (references) localStorage.setItem(key, references)
    },
    { key: savedStorageKey, references: savedReferences }
  )
  await gotoAs(concurrentPage, merchantUrl, "/events", "organizer")
  await selectOrganizerMarket(concurrentPage, "Synthetic Late Retry Event")
  await expect(
    concurrentPage.getByRole("button", { name: "Update event", exact: true })
  ).toBeEnabled()
  const retryAck = relay.holdNextPublicationAck(
    (event) => event.id === market.initialCollection.id
  )
  await page.getByRole("button", { name: "Retry delivery" }).click()
  await retryAck.captured
  await expect(
    page.getByRole("button", { name: "Update event", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Create event", exact: true }).first()
  ).toBeDisabled()

  const updateStart = relay.publications.length
  await concurrentPage
    .getByRole("button", { name: "Update event", exact: true })
    .click()
  const editor = concurrentPage.getByRole("dialog", {
    name: "Update event market",
  })
  await expect(editor).toBeVisible()
  await editor
    .getByRole("textbox", { name: "Public summary Required", exact: true })
    .fill("Synthetic update published while the old retry ACK is held.")
  await editor.getByRole("button", { name: "Publish update" }).click()
  await expect(editor).toBeHidden({ timeout: 30_000 })

  const updatedRecords = uniquePublishedEvents(
    relay.publications.slice(updateStart)
  ).filter(
    (event) =>
      [31922, 31923, 30406, 30405].includes(event.kind) &&
      event.id !== market.initialCollection.id
  )
  const updatedCollection = updatedRecords.find(
    (event) =>
      event.kind === 30405 &&
      eventCoordinate(event) === market.collectionCoordinate &&
      event.id !== market.initialCollection.id
  )
  expect(updatedCollection).toBeTruthy()
  expect(updatedCollection!.created_at).toBeGreaterThan(
    market.initialCollection.created_at
  )

  // Separate contexts isolate mutation scopes. Transfer the persisted records
  // explicitly to reproduce another tab advancing this account's frontier.
  const updatedStorage = await concurrentPage.evaluate(
    ({ savedKey, deliveryKey }) => ({
      references: localStorage.getItem(savedKey),
      deliveries: localStorage.getItem(deliveryKey),
    }),
    { savedKey: savedStorageKey, deliveryKey: deliveryStorageKey }
  )
  expect(updatedStorage.references).toBeTruthy()
  expect(updatedStorage.deliveries).toBeTruthy()
  await page.evaluate(
    ({ savedKey, deliveryKey, references, deliveries }) => {
      if (references) localStorage.setItem(savedKey, references)
      if (deliveries) localStorage.setItem(deliveryKey, deliveries)
    },
    {
      savedKey: savedStorageKey,
      deliveryKey: deliveryStorageKey,
      ...updatedStorage,
    }
  )
  await concurrentContext.close()
  relay.remove(...updatedRecords)
  retryAck.release()

  await expect
    .poll(() =>
      page.evaluate(
        ({ savedKey, deliveryKey }) => {
          const references = JSON.parse(
            localStorage.getItem(savedKey) ?? "[]"
          ) as Array<{ expectedCollectionEventId?: string }>
          const deliveries = JSON.parse(
            localStorage.getItem(deliveryKey) ?? "[]"
          ) as Array<{
            delivery?: {
              record?: string
              signedEvent?: { id?: string }
            }
          }>
          return {
            savedEventId: references[0]?.expectedCollectionEventId,
            exactRetryEventId: deliveries.find(
              (row) => row.delivery?.record === "collection"
            )?.delivery?.signedEvent?.id,
          }
        },
        { savedKey: savedStorageKey, deliveryKey: deliveryStorageKey }
      )
    )
    .toEqual({
      savedEventId: updatedCollection!.id,
      exactRetryEventId: updatedCollection!.id,
    })
  await expect(
    page.getByRole("button", { name: "Update event", exact: true })
  ).toBeDisabled({ timeout: 30_000 })
  await expect(
    page.getByText("Showing earlier signed event evidence", { exact: true })
  ).toBeVisible()
})

test("legacy saved event keeps a newer exact retry beyond an older coordinate deletion @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Legacy Retry Event",
    organizerHandoffEnabled: true,
  })
  const newerCollection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: market.initialCollection.created_at + 2,
    tags: market.initialCollection.tags,
    content: market.initialCollection.content,
  })
  const savedStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  const deliveryStorageKey = `conduit:merchant:event-market-delivery:v1:${ORGANIZER_PUBKEY}`
  const preparedLegacyState = await page.evaluate(
    ({ savedKey, deliveryKey, newerEvent }) => {
      const references = JSON.parse(
        localStorage.getItem(savedKey) ?? "[]"
      ) as Array<Record<string, unknown>>
      for (const reference of references) {
        for (const key of Object.keys(reference)) {
          if (
            key.startsWith("expected") ||
            key === "replaceExpectedRecordFrontiers"
          ) {
            delete reference[key]
          }
        }
      }

      const deliveries = JSON.parse(
        localStorage.getItem(deliveryKey) ?? "[]"
      ) as Array<{
        delivery?: {
          record?: string
          acknowledgedRelayUrls?: string[]
          acknowledgedCount?: number
          rejectedCount?: number
          timedOutCount?: number
          signedEvent?: SignedEvent
        }
      }>
      const collections = deliveries.flatMap((entry) =>
        entry.delivery?.record === "collection" ? [entry.delivery] : []
      )
      if (collections.length === 0) return false
      for (const collection of collections) {
        collection.signedEvent = newerEvent
        collection.acknowledgedRelayUrls = []
        collection.acknowledgedCount = 0
        collection.rejectedCount = 0
        collection.timedOutCount = 1
      }
      localStorage.setItem(savedKey, JSON.stringify(references))
      localStorage.setItem(deliveryKey, JSON.stringify(deliveries))
      return true
    },
    {
      savedKey: savedStorageKey,
      deliveryKey: deliveryStorageKey,
      newerEvent: newerCollection,
    }
  )
  expect(preparedLegacyState).toBe(true)

  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      kind: 5,
      created_at: market.initialCollection.created_at + 1,
      tags: [["a", market.collectionCoordinate]],
      content: "",
    })
  )
  await gotoAs(page, merchantUrl, market.merchantParticipationPath, "organizer")
  await expect(
    page.getByRole("heading", { name: "Event deleted", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  const retryDelivery = page.getByRole("button", {
    name: "Retry delivery",
    exact: true,
  })
  await expect(retryDelivery).toBeVisible()
  const publicationCount = relay.publications.length
  await retryDelivery.click()
  await expect
    .poll(
      () =>
        relay.publications
          .slice(publicationCount)
          .map((publication) => publication.event.id),
      { timeout: 30_000 }
    )
    .toContain(newerCollection.id)
  await expect(page.getByText("Event loaded", { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.getByRole("button", { name: "Update event", exact: true })
  ).toBeEnabled({ timeout: 30_000 })
})

test("terminal event deletion removes the exact-record retry path @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Deleted Retry Event",
    organizerHandoffEnabled: true,
  })
  const deliveryStorageKey = `conduit:merchant:event-market-delivery:v1:${ORGANIZER_PUBKEY}`
  const markedForRetry = await page.evaluate(
    ({ key, eventId }) => {
      const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
        delivery?: {
          acknowledgedRelayUrls?: string[]
          acknowledgedCount?: number
          rejectedCount?: number
          timedOutCount?: number
          signedEvent?: { id?: string }
        }
      }>
      const entry = saved.find(
        (candidate) => candidate.delivery?.signedEvent?.id === eventId
      )
      if (!entry?.delivery) return false
      entry.delivery.acknowledgedRelayUrls = []
      entry.delivery.acknowledgedCount = 0
      entry.delivery.rejectedCount = 0
      entry.delivery.timedOutCount = 1
      localStorage.setItem(key, JSON.stringify(saved))
      return true
    },
    { key: deliveryStorageKey, eventId: market.initialCollection.id }
  )
  expect(markedForRetry).toBe(true)

  await page.reload()
  await selectOrganizerMarket(page, "Synthetic Deleted Retry Event")
  const retryDelivery = page.getByRole("button", {
    name: "Retry delivery",
    exact: true,
  })
  await expect(retryDelivery).toBeVisible()

  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      kind: 5,
      created_at: market.initialCollection.created_at + 1,
      tags: [["a", market.collectionCoordinate]],
      content: "",
    })
  )
  const publicationCount = relay.publications.length
  await page.getByRole("button", { name: "Refresh evidence" }).click()

  await expect(
    page.getByRole("heading", { name: "Event deleted", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(retryDelivery).toHaveCount(0)
  expect(relay.publications).toHaveLength(publicationCount)
  await page
    .getByRole("button", { name: "Retry event discovery", exact: true })
    .click()
  await expect(
    page.getByRole("button", {
      name: "Manage Synthetic Deleted Retry Event",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Event timeline" }).getByRole("heading", {
      name: "Synthetic Deleted Retry Event",
      exact: true,
    })
  ).toHaveCount(0)
})

test("organizer actions wait for an initial hinted read and use its newer collection @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Hinted Resolution Market",
    organizerHandoffEnabled: true,
  })
  const requestedProduct = createMerchantProductEvent({
    dTag: "hinted-resolution-request",
    title: "Synthetic hinted resolution request",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
  })

  const identifier = market.initialCollection.tags.find(
    (tag) => tag[0] === "d"
  )?.[1]
  expect(identifier).toBeTruthy()
  const hintedReference = nip19.naddrEncode({
    kind: 30405,
    pubkey: ORGANIZER_PUBKEY,
    identifier: identifier!,
    relays: [FIXTURE_RELAY],
  })
  const unhintedReference = nip19.naddrEncode({
    kind: 30405,
    pubkey: ORGANIZER_PUBKEY,
    identifier: identifier!,
  })
  const savedStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  await page.evaluate((key) => localStorage.removeItem(key), savedStorageKey)
  await gotoAs(page, merchantUrl, "/events", "organizer", {
    event: unhintedReference,
  })
  const updateEvent = page.getByRole("button", {
    name: "Update event",
    exact: true,
  })
  await expect(updateEvent).toBeEnabled({ timeout: 30_000 })

  relay.seed(requestedProduct)
  const refreshEvidence = page.getByRole("button", {
    name: "Refresh evidence",
    exact: true,
  })
  await refreshEvidence.click()
  await expect(refreshEvidence).toBeDisabled()
  await expect(refreshEvidence).toBeEnabled({ timeout: 30_000 })
  const acceptRequest = page.getByRole("button", {
    name: "Accept",
    exact: true,
  })
  await expect(acceptRequest).toBeEnabled({ timeout: 30_000 })

  const hintedRead = relay.holdRelayRequests(
    (request) =>
      request.relayUrl.startsWith(FIXTURE_RELAY) &&
      request.filters.some(
        (filter) =>
          filter.authors?.includes(ORGANIZER_PUBKEY) &&
          filter.kinds?.includes(30405)
      )
  )
  const catalogReferenceInput = page.getByLabel("Catalog naddr or link")
  await catalogReferenceInput.fill(hintedReference)
  await catalogReferenceInput.press("Enter")
  await expect
    .poll(() => new URL(page.url()).searchParams.get("event"))
    .toBe(hintedReference)
  await hintedRead.captured

  await expect
    .poll(
      async () =>
        (await updateEvent.count()) === 0 || (await updateEvent.isDisabled())
    )
    .toBe(true)
  await expect
    .poll(
      async () =>
        (await acceptRequest.count()) === 0 ||
        (await acceptRequest.isDisabled())
    )
    .toBe(true)

  const alreadyAcceptedProduct = createMerchantProductEvent({
    dTag: "hinted-resolution-existing",
    title: "Synthetic product already accepted by newer collection",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 2,
  })
  const newerCollection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: market.initialCollection.created_at + 3,
    tags: [
      ...market.initialCollection.tags,
      ["a", eventCoordinate(alreadyAcceptedProduct)],
    ],
    content: market.initialCollection.content,
  })
  relay.seed(alreadyAcceptedProduct, newerCollection)
  hintedRead.release()

  await expect(updateEvent).toBeEnabled({ timeout: 30_000 })
  await expect(acceptRequest).toBeEnabled({ timeout: 30_000 })
  const membershipAck = relay.holdNextPublicationAck(
    (event) =>
      event.kind === 30405 &&
      eventCoordinate(event) === market.collectionCoordinate &&
      event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === eventCoordinate(requestedProduct)
      )
  )
  await acceptRequest.click()
  const acceptedCollection = await membershipAck.captured
  membershipAck.release()
  await expect(page.getByText("Accepted", { exact: true }).first()).toBeVisible(
    {
      timeout: 30_000,
    }
  )
  expect(acceptedCollection.tags).toContainEqual([
    "a",
    eventCoordinate(alreadyAcceptedProduct),
  ])
  expect(acceptedCollection.tags).toContainEqual([
    "a",
    eventCoordinate(requestedProduct),
  ])
})

test("a newer external collection can remove the organizer pickup without leaving actions disabled @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic External Pickup Removal",
    organizerHandoffEnabled: true,
  })
  const savedStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
          expectedPickupCoordinate?: string
        }>
        return saved[0]?.expectedPickupCoordinate
      }, savedStorageKey)
    )
    .toBe(market.pickupCoordinate)

  const pickupRemovedCollection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: market.initialCollection.created_at + 5,
    tags: market.initialCollection.tags.filter(
      (tag) => tag[0] !== "shipping_option"
    ),
    content: market.initialCollection.content,
  })
  relay.seed(pickupRemovedCollection)
  await page.getByRole("button", { name: "Refresh evidence" }).click()

  await expect(
    page.getByText("Organizer handoff not offered", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole("button", { name: "Update event", exact: true })
  ).toBeEnabled({ timeout: 30_000 })
})

test("a newer external collection can replace its calendar without inheriting the old calendar timestamp @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic External Calendar Replacement",
    organizerHandoffEnabled: true,
  })

  const replacementCalendar = signEvent(ORGANIZER_SECRET, {
    kind: market.calendarEvent.kind,
    created_at: market.calendarEvent.created_at - 5,
    tags: market.calendarEvent.tags.map((tag) =>
      tag[0] === "d" ? ["d", "replacement-calendar"] : tag
    ),
    content: market.calendarEvent.content,
  })
  const replacementCollection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: market.initialCollection.created_at + 5,
    tags: market.initialCollection.tags.map((tag) =>
      tag[0] === "a" && tag[1] === market.calendarCoordinate
        ? ["a", eventCoordinate(replacementCalendar)]
        : tag
    ),
    content: market.initialCollection.content,
  })
  relay.seed(replacementCalendar, replacementCollection)
  await page.getByRole("button", { name: "Refresh evidence" }).click()

  await expect(page.getByText("Event loaded", { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.getByRole("button", { name: "Update event", exact: true })
  ).toBeEnabled({ timeout: 30_000 })
})

test("membership updates retain externally replaced children and retire removed pickup @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const eventTitle = "Synthetic Membership Child Frontier"
  const market = await publishOrganizerMarket(page, relay, {
    title: eventTitle,
    organizerHandoffEnabled: true,
  })
  const merchantProduct = await publishMerchantProductFromEvent(
    page,
    relay,
    market,
    {
      eventTitle,
      productTitle: "Synthetic child frontier product",
      handoffMode: "merchant",
    }
  )

  const replacementCalendar = signEvent(ORGANIZER_SECRET, {
    kind: market.calendarEvent.kind,
    created_at: market.calendarEvent.created_at - 5,
    tags: market.calendarEvent.tags.map((tag) =>
      tag[0] === "d" ? ["d", "membership-replacement-calendar"] : tag
    ),
    content: market.calendarEvent.content,
  })
  const replacementPickup = signEvent(ORGANIZER_SECRET, {
    kind: market.pickupEvent!.kind,
    created_at: market.pickupEvent!.created_at - 5,
    tags: market.pickupEvent!.tags.map((tag) =>
      tag[0] === "d" ? ["d", "membership-replacement-pickup"] : tag
    ),
    content: market.pickupEvent!.content,
  })
  const replacementCollection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: market.initialCollection.created_at + 5,
    tags: market.initialCollection.tags.map((tag) =>
      tag[0] === "a" && tag[1] === market.calendarCoordinate
        ? ["a", eventCoordinate(replacementCalendar)]
        : tag[0] === "shipping_option" && tag[1] === market.pickupCoordinate
          ? ["shipping_option", eventCoordinate(replacementPickup)]
          : tag
    ),
    content: market.initialCollection.content,
  })
  relay.seed(replacementCalendar, replacementPickup, replacementCollection)

  await gotoAs(page, merchantUrl, "/events", "organizer")
  await selectOrganizerMarket(page, eventTitle)
  const acceptedCollection = await acceptMerchantProduct(
    page,
    relay,
    merchantProduct,
    market.collectionCoordinate
  )
  expect(acceptedCollection.tags).toContainEqual([
    "a",
    eventCoordinate(replacementCalendar),
  ])
  expect(acceptedCollection.tags).toContainEqual([
    "shipping_option",
    eventCoordinate(replacementPickup),
  ])

  await page.reload()
  await selectOrganizerMarket(page, eventTitle)
  const removeProduct = page.getByRole("button", {
    name: "Remove",
    exact: true,
  })
  await expect(removeProduct).toBeEnabled({ timeout: 30_000 })

  const pickupRemovedCollection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: acceptedCollection.created_at + 5,
    tags: acceptedCollection.tags.filter((tag) => tag[0] !== "shipping_option"),
    content: acceptedCollection.content,
  })
  relay.seed(pickupRemovedCollection)
  await page.getByRole("button", { name: "Refresh evidence" }).click()
  await expect(
    page.getByText("Organizer handoff not offered", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(removeProduct).toBeEnabled({ timeout: 30_000 })

  const removalStart = relay.publications.length
  await removeProduct.click()
  await expect(removeProduct).toHaveCount(0, { timeout: 30_000 })
  const removedCollection = uniquePublishedEvents(
    relay.publications.slice(removalStart)
  ).find((event) => event.kind === 30405)
  expect(removedCollection).toBeTruthy()
  expect(removedCollection!.tags).toContainEqual([
    "a",
    eventCoordinate(replacementCalendar),
  ])
  expect(
    removedCollection!.tags.some(
      (tag) => tag[0] === "a" && tag[1] === eventCoordinate(merchantProduct)
    )
  ).toBe(false)
  expect(
    removedCollection!.tags.some((tag) => tag[0] === "shipping_option")
  ).toBe(false)

  await page.reload()
  await selectOrganizerMarket(page, eventTitle)
  await expect(
    page.getByRole("button", { name: "Update event", exact: true })
  ).toBeEnabled({ timeout: 30_000 })
  await expect(
    page.getByTestId("organizer-event-reconciliation-pending")
  ).toHaveCount(0)
  const savedStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
          expectedCollectionEventId?: string
          expectedCalendarCoordinate?: string
          expectedPickupCoordinate?: string
        }>
        return saved[0]
      }, savedStorageKey)
    )
    .toMatchObject({
      expectedCollectionEventId: removedCollection!.id,
      expectedCalendarCoordinate: eventCoordinate(replacementCalendar),
    })
  const savedReference = await page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{
      expectedPickupCoordinate?: string
    }>
    return saved[0]
  }, savedStorageKey)
  expect(savedReference?.expectedPickupCoordinate).toBeUndefined()
})

test("organizer publishes and accepts their own product as merchant pickup @market @merchant", async ({
  page,
}) => {
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Owner Product Event",
    organizerHandoffEnabled: true,
  })
  const product = await publishMerchantProductFromEvent(page, relay, market, {
    eventTitle: "Synthetic Owner Product Event",
    productTitle: "Synthetic Owner Product",
    handoffMode: "merchant",
    identity: "organizer",
    rejectAcceptanceOnce: true,
  })
  const accepted = uniquePublishedEvents(relay.publications).filter(
    (event) =>
      event.kind === 30405 &&
      event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === eventCoordinate(product)
      )
  )
  expect(accepted).toHaveLength(1)
  expect(accepted[0]!.pubkey).toBe(ORGANIZER_PUBKEY)
  expect(accepted[0]!.tags).toContainEqual([
    "shipping_option",
    market.pickupCoordinate!,
  ])
  expect(product.tags).toContainEqual(["visibility", "hidden"])

  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ display_name: "Synthetic Pickup Host" }),
    })
  )
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(
            window as typeof window & { __pickupCopiedNpub?: string }
          ).__pickupCopiedNpub = value
        },
      },
    })
  })
  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  const productCard = page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic Owner Product" })
  await expect(
    productCard.getByText("Pickup from merchant booth", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    productCard.getByText("Synthetic Pickup Host", { exact: true }).last()
  ).toBeVisible({ timeout: 30_000 })
  const pickupDetails = productCard
    .locator("summary")
    .filter({ hasText: "Handled by" })
  await pickupDetails.focus()
  await expect(pickupDetails).toBeFocused()
  await pickupDetails.press("Enter")
  await expect(productCard.locator("details")).toHaveAttribute("open", "")
  const handlerNpub = nip19.npubEncode(ORGANIZER_PUBKEY)
  await expect(productCard.locator(`a[href="/u/${handlerNpub}"]`)).toBeVisible()
  await productCard
    .getByRole("button", { name: "Copy pickup handler npub" })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __pickupCopiedNpub?: string })
            .__pickupCopiedNpub
      )
    )
    .toBe(handlerNpub)
  await productCard.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    page.getByText(
      "Synthetic Owner Product was added for pickup from merchant booth.",
      { exact: true }
    )
  ).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoAs(page, marketUrl, "/cart", "buyer")
  await expect(
    page.getByText("Synthetic Pickup Host", { exact: true }).first()
  ).toBeVisible({ timeout: 30_000 })
  await page
    .getByRole("button", { name: "Copy pickup handler npub" })
    .first()
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __pickupCopiedNpub?: string })
            .__pickupCopiedNpub
      )
    )
    .toBe(handlerNpub)
  await gotoAs(page, marketUrl, "/checkout", "buyer", {
    merchant: nip19.npubEncode(ORGANIZER_PUBKEY),
  })
  await expect(
    page.getByText("Pickup from merchant booth", { exact: true }).first()
  ).toBeVisible()
  await expect(
    page.getByText("Synthetic Pickup Host", { exact: true }).first()
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: /^Send order$/i })).toBeEnabled(
    { timeout: 30_000 }
  )
  await expect(page.getByText(/Organizer release authorization/)).toHaveCount(0)
})

test("paid organizer pickup uses ordinary checkout even after inbox withdrawal @market @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const relay = createRelayHarness()
  const declarationTime = Math.floor(Date.now() / 1000)
  relay.seed(
    createInboxDeclaration("organizer", declarationTime),
    createInboxDeclaration("merchant", declarationTime + 1),
    createInboxDeclaration("buyer", declarationTime + 2)
  )
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Paid Pickup Review",
    organizerHandoffEnabled: true,
  })
  const product = createMerchantProductEvent({
    dTag: "paid-pickup-review",
    title: "Synthetic Paid Pickup Product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
    priceSats: 10,
  })
  await acceptMerchantProduct(page, relay, product, market.collectionCoordinate)
  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  await page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic Paid Pickup Product" })
    .getByRole("button", { name: "Add", exact: true })
    .click()

  const hud = page.getByRole("region", { name: "Cart inventory", exact: true })
  const checkout = hud.getByRole("link", {
    name: /^(Continue to checkout|Checkout)$/i,
  })
  await expect(hud).toBeVisible()
  await expect(checkout).toHaveAttribute("href", /\/checkout\?merchant=/)
  await expect(checkout).not.toHaveAttribute("href", /intent=zap/)
  await expect(hud.getByRole("button", { name: /zap out/i })).toHaveCount(0)
  await expect(
    hud.getByText(
      "Checkout is needed to review event pickup and confirm who handles it."
    )
  ).toBeVisible()

  // A newer withdrawal must not turn a cached paid pickup into automatic intent.
  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      kind: 10050,
      created_at: declarationTime + 30,
      content: "",
      tags: [],
    })
  )
  await page.reload()
  await expect(checkout).toBeVisible()
  await expect(checkout).not.toHaveAttribute("href", /intent=zap/)
  await expect(hud.getByRole("button", { name: /zap out/i })).toHaveCount(0)
  const orderPublishStart = relay.publications.length
  await checkout.click()
  await expect(page).toHaveURL(/\/checkout\?merchant=/)
  expect(new URL(page.url()).searchParams.has("intent")).toBe(false)
  await expect(hud).toBeHidden()
  expect(
    relay.publications
      .slice(orderPublishStart)
      .some((event) => event.kind === 1059)
  ).toBe(false)
})

test("event timeline paints before held pickup reads and keeps cached cards until signed withdrawal @market", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const timings: Record<string, number> = {}
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic progressive timeline",
    organizerHandoffEnabled: true,
  })
  relay.seed(
    createFollowList(
      "buyer",
      [ORGANIZER_PUBKEY],
      Math.floor(Date.now() / 1000) + 1
    )
  )
  const card = page.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: "Synthetic progressive timeline",
      exact: true,
    }),
  })
  const held = relay.holdRelayRequests((request) =>
    request.filters.some(
      (filter) => filter.kinds?.length === 1 && filter.kinds[0] === 30406
    )
  )
  const coldStarted = Date.now()
  try {
    await gotoAs(page, marketUrl, "/events", "buyer", {
      source: "following",
      window: "all",
    })
    await held.captured
    // A usable organizer header must render before pickup hydration settles.
    await expect(card).toBeVisible()
    timings.coldListCardMs = Date.now() - coldStarted
    await expect(
      card.getByRole("link", { name: "View", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Retry discovery", exact: true })
    ).toBeDisabled()
  } finally {
    held.release()
  }
  await expect
    .poll(async () => {
      const retry = page.getByRole("button", {
        name: "Retry discovery",
        exact: true,
      })
      return (await retry.count()) === 0 || (await retry.isEnabled())
    })
    .toBe(true)
  await expect(card).toBeVisible()
  const publications = relay.publications.length
  const warmRead = relay.holdRelayRequests((request) =>
    request.filters.some((filter) =>
      filter.kinds?.some((kind) => [30405, 30406, 31922, 31923].includes(kind))
    )
  )
  const warmStarted = Date.now()
  try {
    await page.reload()
    await warmRead.captured
    await expect(card).toBeVisible()
    timings.warmListCardMs = Date.now() - warmStarted
    await expect(
      page.getByRole("button", { name: "Retry discovery", exact: true })
    ).toBeDisabled()
    // A newer collection withdrawing its event link is stronger evidence than
    // the retained card, including when the organizer refresh is incomplete.
    relay.seed(
      signEvent(ORGANIZER_SECRET, {
        kind: 30405,
        created_at: market.initialCollection.created_at + 20,
        content: market.initialCollection.content,
        tags: market.initialCollection.tags.filter(
          (tag) => !(tag[0] === "a" && tag[1] === market.calendarCoordinate)
        ),
      })
    )
  } finally {
    warmRead.release()
  }
  await expect(card).toHaveCount(0)
  expect(relay.publications).toHaveLength(publications)
  console.log(
    "Event timeline loading timings (synthetic, ms):",
    JSON.stringify(timings)
  )
})

test("guest booth checkout reaches a manual invoice without reading unselected pickup options @market", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic independent pickup freshness",
    organizerHandoffEnabled: true,
  })
  const otherSecret = generateSecretKey()
  const createdAt = market.initialCollection.created_at + 1
  const pickups = [MERCHANT_SECRET, otherSecret].map((secret) =>
    signEvent(secret, {
      kind: 30406,
      created_at: createdAt,
      content: "",
      tags: [
        ["d", "booth"],
        ["title", "Synthetic booth"],
        ["price", "0", "SAT"],
        ["country", "US"],
        ["service", "pickup"],
        ["location", "Synthetic public hall"],
      ],
    })
  )
  const product = createMerchantProductEvent({
    dTag: "live-booth-product",
    title: "Synthetic live booth product",
    priceSats: 1000,
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: eventCoordinate(pickups[0]!),
    createdAt,
  })
  const secondProduct = createMerchantProductEvent({
    dTag: "second-live-booth-product",
    title: "Synthetic second booth product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: eventCoordinate(pickups[0]!),
    createdAt,
    priceSats: 1000,
  })
  const otherProduct = signEvent(otherSecret, {
    kind: product.kind,
    created_at: createdAt,
    content: "Synthetic other booth product.",
    tags: product.tags.map((tag) =>
      tag[0] === "d"
        ? ["d", "other-booth-product"]
        : tag[0] === "title"
          ? ["title", "Synthetic other booth product"]
          : tag[0] === "shipping_option"
            ? ["shipping_option", eventCoordinate(pickups[1]!), "0"]
            : tag
    ),
  })
  const metadata = JSON.stringify([["text/plain", "Synthetic booth merchant"]])
  let callbackRequests = 0
  const invoice = makeBolt11Fixture({
    hrp: "lnbc20u",
    createdAt: Math.floor(Date.now() / 1000),
    fields: [bolt11PaymentHashField(), bolt11DescriptionHashField(metadata)],
  })
  await page.route("https://merchant-fixture.dev/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/callback") {
      callbackRequests += 1
      expect(url.searchParams.get("amount")).toBe("2000000")
      expect(url.searchParams.has("nostr")).toBe(false)
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ pr: invoice, routes: [] }),
      })
      return
    }
    expect(url.pathname).toBe("/.well-known/lnurlp/merchant")
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tag: "payRequest",
        callback: "https://merchant-fixture.dev/callback",
        minSendable: 1000,
        maxSendable: 10_000_000,
        metadata,
      }),
    })
  })
  relay.seed(
    createInboxDeclaration("merchant", createdAt),
    signEvent(MERCHANT_SECRET, {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify({
        name: "Synthetic booth merchant",
        lud16: "merchant@merchant-fixture.dev",
      }),
    }),
    ...pickups,
    product,
    secondProduct,
    otherProduct,
    signEvent(ORGANIZER_SECRET, {
      kind: 30405,
      created_at: createdAt + 1,
      content: market.initialCollection.content,
      tags: [
        ...market.initialCollection.tags,
        ["a", eventCoordinate(product)],
        ["a", eventCoordinate(secondProduct)],
        ["a", eventCoordinate(otherProduct)],
      ],
    })
  )
  await page.setViewportSize({ width: 390, height: 844 })
  // Market starts signed out; publishing the fixture used Merchant's origin.
  await page.goto(`${marketUrl}/events/${market.canonicalNaddr}`)
  const card = page.getByRole("listitem").filter({
    hasText: "Synthetic live booth product",
  })
  await expect(
    page
      .getByRole("listitem")
      .filter({
        hasText: "Synthetic other booth product",
      })
      .getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled({ timeout: 30_000 })
  await card.getByRole("button", { name: "Add", exact: true }).click()

  await page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic second booth product" })
    .getByRole("button", { name: "Add", exact: true })
    .click()

  // Neither a different booth nor the unused organizer handoff option belongs
  // to this order. Hold both reads until after invoice readiness.
  relay.remove(pickups[1]!)
  const isUnrelatedPickupRead = (request: RelayRequest) =>
    request.filters.some(
      (filter) =>
        filter.kinds?.includes(30406) &&
        (!filter.authors ||
          filter.authors.includes(pickups[1]!.pubkey) ||
          filter.authors.includes(ORGANIZER_PUBKEY))
    )
  const held = relay.holdRelayRequests(isUnrelatedPickupRead)
  const publicationStart = relay.publications.length
  try {
    await page.goto(`${marketUrl}/cart`)
    // Cart recommendations may still discover the other booth. Checkout must
    // advance while that browsing read is held and start no additional one.
    await held.captured
    const priorDiscoveryPickupReads = relay.requests.filter(
      isUnrelatedPickupRead
    ).length
    const checkoutRequestsStart = relay.requests.length
    await page.getByRole("button", { name: "Order", exact: true }).click()
    await expect(
      page.getByText("Merchant-only recovery", { exact: true })
    ).toBeVisible()
    await page.getByLabel("Email", { exact: true }).fill("guest@example.test")
    const continueButton = page.getByRole("button", {
      name: "Continue to Send Order",
      exact: true,
    })
    await expect(continueButton).toBeEnabled({ timeout: 10_000 })
    await expect(page.getByLabel(/Street address/i)).toHaveCount(0)
    await continueButton.click()
    const submit = page.getByRole("button", {
      name: "Send order and show invoice",
      exact: true,
    })
    await expect(submit).toBeEnabled({ timeout: 10_000 })
    const submitRequestsStart = relay.requests.length
    await submit.click()
    await expect(page).toHaveURL(/\/orders\?order=/, { timeout: 30_000 })
    await expect(
      page.getByRole("button", { name: "Copy invoice", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Open Lightning wallet", exact: true })
    ).toHaveAttribute("href", `lightning:${invoice}`)
    expect(callbackRequests).toBe(1)
    expect(
      relay.requests.slice(checkoutRequestsStart).filter(isUnrelatedPickupRead)
        .length
    ).toBe(0)
    const collectionReads = relay.requests
      .slice(submitRequestsStart)
      .filter((request) =>
        request.filters.some((filter) => filter.kinds?.includes(30405))
      )
    // Both selected products share one event verification, rather than each
    // product loading the event independently.
    expect(collectionReads.length).toBe(1)
    console.log(
      "Synthetic guest pickup checkout:",
      JSON.stringify({
        selectedProducts: 2,
        priorDiscoveryPickupReads,
        checkoutUnrelatedPickupReads: 0,
        submissionCollectionReads: collectionReads.length,
        invoiceCallbacks: callbackRequests,
      })
    )
    const privateOrders = uniquePrivatePublications(
      decryptPrivatePublications(
        relay.publications,
        MERCHANT_SECRET,
        publicationStart
      )
    ).filter((message) => rumorType(message.rumor) === "order")
    expect(privateOrders).toHaveLength(1)
    expect(privateOrders[0]!.rumor.kind).toBe(16)
    expect(
      privateOrders[0]!.rumor.tags
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1])
    ).toEqual([MERCHANT_PUBKEY])
    const orderPayload = JSON.parse(privateOrders[0]!.rumor.content) as {
      items: Array<{ productId: string }>
    }
    expect(orderPayload.items.map((item) => item.productId).sort()).toEqual(
      [eventCoordinate(product), eventCoordinate(secondProduct)].sort()
    )
  } finally {
    held.release()
  }
})

test("cold event catalog shows a completed merchant product before a slower merchant finishes @market", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic independently loading catalog",
    organizerHandoffEnabled: true,
  })
  const fast = createMerchantProductEvent({
    dTag: "fast-merchant-product",
    title: "Synthetic fast merchant product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
  })
  const slowSecret = generateSecretKey()
  const slow = signEvent(slowSecret, {
    kind: fast.kind,
    created_at: fast.created_at,
    content: "Synthetic slow merchant product fixture.",
    tags: fast.tags.map((tag) =>
      tag[0] === "d"
        ? ["d", "slow-merchant-product"]
        : tag[0] === "title"
          ? ["title", "Synthetic slow merchant product"]
          : tag
    ),
  })
  expect(slow.pubkey).not.toBe(fast.pubkey)
  const collection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: market.initialCollection.created_at + 2,
    content: market.initialCollection.content,
    tags: [
      ...market.initialCollection.tags,
      ["a", eventCoordinate(fast)],
      ["a", eventCoordinate(slow)],
    ],
  })
  relay.seed(
    fast,
    slow,
    collection,
    ...[MERCHANT_SECRET, slowSecret].map((secret) =>
      signEvent(secret, {
        kind: 10002,
        created_at: fast.created_at,
        content: "",
        tags: [["r", FIXTURE_RELAY]],
      })
    )
  )
  const held = relay.holdRelayRequests((request) =>
    request.filters.some(
      (filter) =>
        filter.kinds?.includes(30402) && filter.authors?.includes(slow.pubkey)
    )
  )
  const fastCard = page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic fast merchant product" })
  const slowCard = page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic slow merchant product" })
  try {
    // This is the context's first Market-origin navigation: neither product
    // has been read into its commerce cache by a product page or warm visit.
    await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
    await held.captured
    await expect
      .poll(() =>
        relay.requests.some((request) =>
          request.matchedEventIds.includes(fast.id)
        )
      )
      .toBe(true)
    await expect(fastCard).toBeVisible()
    await expect(
      fastCard.getByRole("button", { name: "Checking pickup…", exact: true })
    ).toBeDisabled()
    await expect(
      fastCard.getByRole("button", { name: "Add", exact: true })
    ).toHaveCount(0)
    await expect(slowCard).toHaveCount(0)
    await expect(page.getByTestId("event-refresh-status")).toBeVisible()
  } finally {
    held.release()
  }
  for (const card of [fastCard, slowCard]) {
    await expect(card).toBeVisible()
    await expect(
      card.getByText("Pickup from event organizer", { exact: true })
    ).toBeVisible()
    await expect(
      card.getByRole("button", { name: "Add", exact: true })
    ).toBeEnabled()
  }
})

test("event catalog paints before held product reads and keeps cached browsing closed to purchase @market", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const timings: Record<string, number> = {}
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic progressive catalog",
    organizerHandoffEnabled: true,
  })
  const product = createMerchantProductEvent({
    dTag: "progressive-catalog",
    title: "Synthetic progressive product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
  })
  const collection = signEvent(ORGANIZER_SECRET, {
    kind: 30405,
    created_at: market.initialCollection.created_at + 2,
    content: market.initialCollection.content,
    tags: [...market.initialCollection.tags, ["a", eventCoordinate(product)]],
  })
  relay.seed(product, collection)
  const held = relay.holdRelayRequests((request) =>
    request.filters.some((filter) => filter.kinds?.includes(30402))
  )
  const coldStarted = Date.now()
  try {
    await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
    await held.captured
    // Completion is held, so visibility here proves the page does not await
    // catalog authorization just to render the signed event header.
    await expect(
      page.getByRole("heading", {
        name: "Synthetic progressive catalog",
        exact: true,
      })
    ).toBeVisible()
    timings.coldHeaderMs = Date.now() - coldStarted
    await expect(page.getByTestId("event-refresh-status")).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Add", exact: true })
    ).toHaveCount(0)
  } finally {
    held.release()
  }
  const card = page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic progressive product" })
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()
  // Exercise the actual in-app product-to-event link with matching catalog
  // evidence already present. A return visit must not start another check.
  await gotoAs(
    page,
    marketUrl,
    `/products/${eventCoordinate(product)}`,
    "buyer"
  )
  await expect(
    page.getByRole("button", { name: "Add 1 to cart", exact: true })
  ).toBeEnabled()
  const navigationRead = relay.holdRelayRequests((request) =>
    request.filters.some((filter) =>
      filter.kinds?.some((kind) =>
        [30402, 30405, 30406, 31922, 31923].includes(kind)
      )
    )
  )
  try {
    const navigationStarted = Date.now()
    await page
      .getByRole("link", { name: "View event catalog", exact: true })
      .click()
    await expect(card).toBeVisible()
    timings.warmNavigationMs = Date.now() - navigationStarted
    await expect(
      card.getByRole("button", { name: "Add", exact: true })
    ).toBeEnabled()
    await expect(page.getByTestId("event-refresh-status")).toHaveCount(0)
  } finally {
    navigationRead.release()
  }
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()
  const publications = relay.publications.length
  const warmRead = relay.holdRelayRequests((request) =>
    request.filters.some((filter) =>
      filter.kinds?.some((kind) =>
        [30402, 30405, 30406, 31922, 31923].includes(kind)
      )
    )
  )
  const warmStarted = Date.now()
  try {
    await page.reload()
    await warmRead.captured
    await expect(
      page.getByRole("heading", {
        name: "Synthetic progressive catalog",
        exact: true,
      })
    ).toBeVisible()
    await expect(card).toBeVisible()
    timings.warmProductsMs = Date.now() - warmStarted
    await expect(
      card.getByRole("button", { name: "Checking pickup…", exact: true })
    ).toBeDisabled()
    await expect(
      card.getByRole("button", { name: "Add", exact: true })
    ).toHaveCount(0)
    // The next response carries stronger evidence than the cached preview.
    relay.seed(
      signEvent(ORGANIZER_SECRET, {
        kind: 5,
        created_at: collection.created_at + 1,
        content: "",
        tags: [
          ["a", market.collectionCoordinate],
          ["k", "30405"],
        ],
      })
    )
  } finally {
    warmRead.release()
  }
  await expect(
    page.getByRole("heading", { name: "Event deleted", exact: true })
  ).toBeVisible()
  await expect(card).toHaveCount(0)
  expect(relay.publications).toHaveLength(publications)
  console.log("Event loading timings (synthetic, ms):", JSON.stringify(timings))
})

test("event variation choices remain stable while cached pickup authorization refreshes @market", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic variation catalog",
    organizerHandoffEnabled: true,
  })
  const parentId = `30402:${MERCHANT_PUBKEY}:progressive-family`
  const records = ["parent", "Small", "Large"].map((size, index) =>
    signEvent(MERCHANT_SECRET, {
      kind: 30402,
      created_at: market.initialCollection.created_at + index + 1,
      content: "Synthetic event product options",
      tags: [
        [
          "d",
          index === 0
            ? "progressive-family"
            : `progressive-family-${size.toLowerCase()}`,
        ],
        [
          "title",
          index === 0
            ? "Synthetic event shirt"
            : `Synthetic event shirt ${size}`,
        ],
        ["type", index === 0 ? "variable" : "variation", "physical"],
        ["price", "1000", "SATS"],
        ["stock", "3"],
        ["visibility", "hidden"],
        ["image", "https://cdn.conduit.market/conduit-test/variation.png"],
        ["a", market.collectionCoordinate],
        ["shipping_option", market.pickupCoordinate!, "0"],
        ...(index === 0
          ? []
          : [
              ["a", parentId],
              ["spec", "size", size],
            ]),
      ],
    })
  )
  relay.seed(
    ...records,
    signEvent(ORGANIZER_SECRET, {
      kind: 30405,
      created_at: market.initialCollection.created_at + 4,
      content: market.initialCollection.content,
      tags: [
        ...market.initialCollection.tags,
        ...records.map((record) => ["a", eventCoordinate(record)]),
      ],
    })
  )
  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  const card = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("combobox", { name: "Choose size" }) })
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()
  const held = relay.holdRelayRequests((request) =>
    request.filters.some((filter) =>
      filter.kinds?.some((kind) =>
        [30402, 30405, 30406, 31922, 31923].includes(kind)
      )
    )
  )
  try {
    await page.reload()
    await held.captured
    const selector = card.getByRole("combobox", { name: "Choose size" })
    await expect(selector).toBeVisible()
    await expect(
      card.getByRole("button", { name: "Checking pickup…", exact: true })
    ).toBeDisabled()
    await selector.click()
    await expect(
      page.getByRole("option", { name: "Small", exact: true })
    ).toBeVisible()
    await page.getByRole("option", { name: "Large", exact: true }).click()
    await expect(selector).toContainText("Large")
  } finally {
    held.release()
  }
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()
  await expect(
    card.getByRole("combobox", { name: "Choose size" })
  ).toContainText("Large")
  relay.rejectReads(true)
  await page.reload()
  await expect(
    page.getByRole("alert").filter({ hasText: "Event evidence is stale" })
  ).toBeVisible()
  await expect(card).toBeVisible()
  await expect(
    card.getByRole("combobox", { name: "Choose size" })
  ).toBeVisible()
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toHaveCount(0)
  await expect(
    card.getByRole("button", { name: "Pickup unavailable", exact: true })
  ).toBeDisabled()
})

test("failed event refresh retains cards with stale warning and a working retry @market", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic failed refresh",
    organizerHandoffEnabled: true,
  })
  const product = createMerchantProductEvent({
    dTag: "failed-refresh",
    title: "Synthetic retained refresh product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
  })
  await acceptMerchantProduct(page, relay, product, market.collectionCoordinate)
  // Fail at the query boundary before progress, after the real signed catalog
  // has completed. Relay timeouts normally resolve as bounded stale results;
  // this covers the distinct rejected-query path with retained successful data.
  await page.route("**/src/lib/event-catalog-query.ts*", async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const renamed = source.replace(
      "import { loadRawEventCatalog }",
      "import { loadRawEventCatalog as loadOriginalEventCatalog }"
    )
    expect(renamed).not.toBe(source)
    const injected = renamed.replace(
      /const identity = eventCatalogQueryIdentity\(reference, scope\);?/,
      `$&
window.__failNextEventRefresh = () => {
  failNextEventRead = true;
  return client.refetchQueries({ queryKey: identity.queryKey });
};`
    )
    expect(injected).not.toBe(renamed)
    await route.fulfill({
      response,
      body: `${injected}
let failNextEventRead = false;
const loadRawEventCatalog = async (...args) => {
  if (failNextEventRead) {
    failNextEventRead = false;
    throw new Error("Synthetic failure before event progress");
  }
  return loadOriginalEventCatalog(...args);
};`,
    })
  })
  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  const card = page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic retained refresh product" })
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()
  const publicationCount = relay.publications.length
  await page.evaluate(async () => {
    const refresh = (
      window as unknown as { __failNextEventRefresh: () => Promise<void> }
    ).__failNextEventRefresh
    await refresh()
  })
  const warning = page
    .getByRole("alert")
    .filter({ hasText: "Event evidence is stale" })
  await expect(warning).toBeVisible()
  await expect(page.getByTestId("event-actionability-status")).toHaveCount(0)
  await expect(page.getByTestId("event-refresh-status")).toHaveCount(0)
  await expect(card).toBeVisible()
  await expect(
    card.getByRole("button", { name: "Pickup unavailable", exact: true })
  ).toBeDisabled()
  await page
    .getByRole("button", { name: "Refresh evidence", exact: true })
    .click()
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()
  await expect(warning).toHaveCount(0)
  await expect(page.getByTestId("event-actionability-status")).toHaveText(
    "1 product available."
  )
  expect(relay.publications).toHaveLength(publicationCount)
})

test("event availability copy excludes retained products without pickup authority @market", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const relay = createRelayHarness()
  await installSyntheticEnvironment(page, relay)
  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic availability evidence",
    organizerHandoffEnabled: true,
  })
  const product = createMerchantProductEvent({
    dTag: "availability-evidence",
    title: "Synthetic availability product",
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
  })
  await acceptMerchantProduct(page, relay, product, market.collectionCoordinate)
  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  const card = page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic availability product" })
  await expect(page.getByTestId("event-actionability-status")).toContainText(
    "1 product available."
  )
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toBeEnabled()

  // Exercise the route's retained-catalog contract at the query boundary.
  // Signed parsing and action authority have separate Core/adapter coverage;
  // this explicit projection fixture proves the prominent copy uses the same
  // availability evidence as the cards, including unresolved required records.
  await page.route("**/src/lib/event-catalog-query.ts*", async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    const renamed = source.replace(
      "import { loadRawEventCatalog }",
      "import { loadRawEventCatalog as loadOriginalEventCatalog }"
    )
    expect(renamed).not.toBe(source)
    await route.fulfill({
      response,
      body: `${renamed}
const loadRawEventCatalog = async (...args) => {
  const raw = await loadOriginalEventCatalog(...args);
  return { ...raw, complete: false,
    resolution: { ...raw.resolution, state: "partial", pickup: undefined, pickups: [] } };
};`,
    })
  })
  const publicationCount = relay.publications.length
  await page.reload()
  const warning = page
    .getByRole("alert")
    .filter({ hasText: "Event records unresolved" })
  await expect(warning).toContainText("0 products available.")
  await expect(warning).toContainText(
    "1 product remains unresolved and unavailable."
  )
  await expect(card).toBeVisible()
  await expect(
    card.getByRole("button", { name: "Pickup unavailable", exact: true })
  ).toBeDisabled()
  await expect(
    card.getByRole("button", { name: "Add", exact: true })
  ).toHaveCount(0)
  expect(relay.publications).toHaveLength(publicationCount)
})

test("organizer offer off publishes an empty catalog and permits booth handoff @market @merchant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(20_000)
  page.setDefaultNavigationTimeout(30_000)
  const relay = createRelayHarness()
  const browserErrors = captureBrowserErrors(page)
  await installSyntheticEnvironment(page, relay)

  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Merchant Booth Market",
    organizerHandoffEnabled: false,
  })
  expect(market.pickupEvent).toBeUndefined()

  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", {
      name: "Synthetic Merchant Booth Market",
      exact: true,
      level: 1,
    })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText("Pickup details are shown on each product.", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText(
      "The organizer has not accepted any products for this event.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    page.getByText("Event evidence is incomplete", { exact: true })
  ).toHaveCount(0)

  const merchantTemplate = createMerchantTemplateProductEvent(
    market.initialCollection.created_at + 1
  )
  expect(eventCoordinate(merchantTemplate)).toBe(MERCHANT_TEMPLATE_COORDINATE)
  relay.seed(
    merchantTemplate,
    createFollowList(
      "merchant",
      [ORGANIZER_PUBKEY],
      market.initialCollection.created_at + 2
    )
  )

  // Keep the explicit naddr fallback covered alongside the new followed feed.
  await gotoAs(page, merchantUrl, "/events", "merchant")
  await page.getByLabel("Open a known event").fill(market.canonicalNaddr)
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Publish product", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  const merchantProduct = await publishMerchantProductFromEvent(
    page,
    relay,
    market,
    {
      eventTitle: "Synthetic Merchant Booth Market",
      productTitle: MERCHANT_PRODUCT_TITLE,
      handoffMode: "merchant",
      templateTitle: MERCHANT_TEMPLATE_TITLE,
      discoveryMode: "followed",
    }
  )
  expect(eventCoordinate(merchantProduct)).not.toBe(
    MERCHANT_TEMPLATE_COORDINATE
  )

  await gotoAs(page, merchantUrl, "/events", "organizer")
  await expect(
    page.getByRole("heading", { name: "Events", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await selectOrganizerMarket(page, "Synthetic Merchant Booth Market")
  const acceptedCollection = await acceptMerchantProduct(
    page,
    relay,
    merchantProduct,
    market.collectionCoordinate
  )
  expect(acceptedCollection.created_at).toBeGreaterThan(
    market.initialCollection.created_at
  )
  expect(
    acceptedCollection.tags.filter((tag) => tag[0] === "shipping_option")
  ).toEqual([])
  await expect(
    page.getByTestId("organizer-event-actionability-status")
  ).toContainText("1 product available.")
  await expect(
    page.getByTestId("organizer-event-actionability-status")
  ).toHaveAttribute("role", "status")
  await expect(
    page.getByTestId("organizer-event-relay-read-coverage")
  ).toBeVisible()
  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", {
      name: "Synthetic Merchant Booth Market",
      exact: true,
      level: 1,
    })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText(MERCHANT_PRODUCT_TITLE, { exact: true })
  ).toBeVisible()
  await expect(page.getByTestId("event-actionability-status")).toContainText(
    "1 product available."
  )
  await expect(page.getByTestId("event-actionability-status")).toHaveAttribute(
    "role",
    "status"
  )
  const technicalDetails = page
    .locator("summary")
    .filter({ hasText: /^Technical details\s*$/ })
  await expect(page.getByTestId("event-relay-read-coverage")).toBeHidden()
  await technicalDetails.click()
  await expect(page.getByTestId("event-relay-read-coverage")).toBeVisible()
  await technicalDetails.click()
  const productCard = page
    .getByRole("listitem")
    .filter({ hasText: MERCHANT_PRODUCT_TITLE })
  await expect(
    productCard.getByText("Pickup from merchant booth", { exact: true })
  ).toBeVisible()
  await productCard.getByText("Details", { exact: true }).click()
  await expect(
    productCard.getByText(/no organizer receipt is sent/i)
  ).toBeVisible()
  await productCard.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    page.getByText(
      `${MERCHANT_PRODUCT_TITLE} was added for pickup from merchant booth.`,
      { exact: true }
    )
  ).toBeVisible()

  const checkoutReadStart = relay.requests.length
  const cartHud = page.getByRole("region", {
    name: "Cart inventory",
    exact: true,
  })
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(cartHud).toBeVisible()
    await expect(
      cartHud.getByRole("link", { name: MERCHANT_PRODUCT_TITLE, exact: true })
    ).toBeVisible()
    await expect(
      cartHud.getByRole("link", { name: "View cart", exact: true })
    ).toBeVisible()
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoAs(page, marketUrl, "/checkout", "buyer", {
    merchant: nip19.npubEncode(MERCHANT_PUBKEY),
  })
  await expect(cartHud).toBeHidden()
  await expect(
    page.getByRole("heading", { name: "Send Order", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText("Pickup from merchant booth", { exact: true }).first()
  ).toBeVisible()
  await expect(
    page.getByText(/no organizer receipt is sent/i).first()
  ).toBeVisible()
  await expect(page.getByText("Organizer pickup is not ready")).toHaveCount(0)
  await expect(page.getByLabel(/Street address/i)).toHaveCount(0)
  await expect(page.getByLabel(/Email/i)).toHaveCount(0)
  await expect(page.getByLabel(/Phone/i)).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Send order$/i })).toBeEnabled(
    { timeout: 30_000 }
  )
  const organizerInboxReads = relay.requests
    .slice(checkoutReadStart)
    .filter((request) =>
      request.filters.some(
        (filter) =>
          filter.kinds?.includes(10050) &&
          filter.authors?.includes(ORGANIZER_PUBKEY)
      )
    )
  expect(organizerInboxReads).toEqual([])
  await expect(
    page.locator(
      "vite-error-overlay, .vite-error-overlay, #webpack-dev-server-client-overlay"
    )
  ).toHaveCount(0)
  expect(browserErrors.pageErrors).toEqual([])
  expect(browserErrors.consoleErrors).toEqual([])
})

test("organizer handoff completes a private order receipt and exact ACK flow @market @merchant", async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000)
  page.setDefaultTimeout(25_000)
  page.setDefaultNavigationTimeout(30_000)
  const relay = createRelayHarness()
  const browserErrors = captureBrowserErrors(page)
  const declarationTime = Math.floor(Date.now() / 1000)
  relay.seed(
    createInboxDeclaration("organizer", declarationTime),
    createInboxDeclaration("merchant", declarationTime + 1),
    createInboxDeclaration("buyer", declarationTime + 2)
  )
  relay.seed(
    signEvent(ORGANIZER_SECRET, {
      kind: 0,
      created_at: declarationTime,
      tags: [],
      content: JSON.stringify({ display_name: "Friendly Handoff Organizer" }),
    }),
    signEvent(MERCHANT_SECRET, {
      kind: 0,
      created_at: declarationTime,
      tags: [],
      content: JSON.stringify({ display_name: "Friendly Handoff Merchant" }),
    })
  )
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(
            window as typeof window & { __merchantActorCopiedNpub?: string }
          ).__merchantActorCopiedNpub = value
        },
      },
    })
  })
  await installSyntheticEnvironment(page, relay, "acknowledger")

  const market = await publishOrganizerMarket(page, relay, {
    title: "Synthetic Organizer Handoff Market",
    organizerHandoffEnabled: true,
  })
  expect(market.pickupCoordinate).toBeTruthy()
  const productEvent = createMerchantProductEvent({
    dTag: ORGANIZER_PRODUCT_D_TAG,
    title: ORGANIZER_PRODUCT_TITLE,
    collectionCoordinate: market.collectionCoordinate,
    pickupCoordinate: market.pickupCoordinate!,
    createdAt: market.initialCollection.created_at + 1,
  })
  const acceptedCollection = await acceptMerchantProduct(
    page,
    relay,
    productEvent,
    market.collectionCoordinate
  )
  expect(acceptedCollection.tags).toContainEqual([
    "shipping_option",
    market.pickupCoordinate!,
  ])

  await expect(
    page.getByText("Friendly Handoff Organizer", { exact: true }).first()
  ).toBeVisible()
  await expect(
    page.getByText("Friendly Handoff Merchant", { exact: true }).first()
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Copy organizer signer npub", exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __merchantActorCopiedNpub?: string })
            .__merchantActorCopiedNpub
      )
    )
    .toBe(nip19.npubEncode(ORGANIZER_PUBKEY))
  await gotoAs(page, merchantUrl, market.merchantParticipationPath, "merchant")
  await expect(
    page.getByText("Friendly Handoff Organizer", { exact: true }).first()
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Copy organizer npub", exact: true })
  ).toBeVisible()

  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  await expect(
    page.getByRole("heading", {
      name: "Synthetic Organizer Handoff Market",
      exact: true,
      level: 1,
    })
  ).toBeVisible({ timeout: 30_000 })
  const productCard = page
    .getByRole("listitem")
    .filter({ hasText: ORGANIZER_PRODUCT_TITLE })
  await expect(
    productCard.getByText("Pickup from event organizer", { exact: true })
  ).toBeVisible()
  await expect(productCard.getByText("Free", { exact: true })).toBeVisible()
  await expect(productCard.getByText("0 sats", { exact: true })).toBeVisible()
  await productCard.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    page.getByText(
      `${ORGANIZER_PRODUCT_TITLE} was added for pickup from event organizer.`,
      { exact: true }
    )
  ).toBeVisible()

  await gotoAs(page, marketUrl, "/checkout", "buyer", {
    merchant: nip19.npubEncode(MERCHANT_PUBKEY),
  })
  await expect(
    page.getByRole("heading", { name: "Send Order", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText("Pickup from event organizer", { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByText(/No payment is required/).first()).toBeVisible()
  await expect(page.getByText("Free", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("0 sats", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Zap out with Lightning")).toHaveCount(0)
  await expect(page.getByText("Zap visibility")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: /show invoice|zap out/i })
  ).toHaveCount(0)
  await expect(page.getByLabel(/Street address/i)).toHaveCount(0)
  await expect(page.getByLabel(/Email/i)).toHaveCount(0)
  await expect(page.getByLabel(/Phone/i)).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Send order$/i })).toBeEnabled(
    { timeout: 30_000 }
  )

  const orderPublishStart = relay.publications.length
  await page.getByRole("button", { name: /^Send order$/i }).click()
  await expect(page).toHaveURL(/\/orders(?:\?|$)/, { timeout: 30_000 })
  const buyerPickupPanel = page
    .getByRole("heading", {
      name: "Pickup from event organizer",
      exact: true,
    })
    .locator("xpath=ancestor::section[1]")
  await expect(buyerPickupPanel).toBeVisible({ timeout: 30_000 })
  expect(
    await buyerPickupPanel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true)

  await expect
    .poll(
      () =>
        uniquePrivatePublications(
          decryptPrivatePublications(
            relay.publications,
            MERCHANT_SECRET,
            orderPublishStart
          )
        ).filter((message) => rumorType(message.rumor) === "order").length
    )
    .toBe(1)
  const merchantOrderMessage = uniquePrivatePublications(
    decryptPrivatePublications(
      relay.publications,
      MERCHANT_SECRET,
      orderPublishStart
    )
  ).find((message) => rumorType(message.rumor) === "order")!
  const buyerOrderSelfCopy = uniquePrivatePublications(
    decryptPrivatePublications(
      relay.publications,
      BUYER_SECRET,
      orderPublishStart
    )
  ).find((message) => rumorType(message.rumor) === "order")
  const organizerOrderLeg = uniquePrivatePublications(
    decryptPrivatePublications(
      relay.publications,
      ORGANIZER_SECRET,
      orderPublishStart
    )
  ).find((message) => rumorType(message.rumor) === "order")
  expect(merchantOrderMessage.wrap.kind).toBe(1059)
  expect(merchantOrderMessage.seal.kind).toBe(13)
  expect(merchantOrderMessage.rumor.kind).toBe(16)
  expect(merchantOrderMessage.rumor.pubkey).toBe(BUYER_PUBKEY)
  expect(
    merchantOrderMessage.rumor.tags
      .filter((tag) => tag[0] === "p")
      .map((tag) => tag[1])
  ).toEqual([MERCHANT_PUBKEY])
  expect(merchantOrderMessage.rumor.tags).not.toContainEqual([
    "p",
    ORGANIZER_PUBKEY,
  ])
  expect(buyerOrderSelfCopy).toBeTruthy()
  expect(organizerOrderLeg).toBeUndefined()

  const orderPayload = JSON.parse(merchantOrderMessage.rumor.content) as Record<
    string,
    unknown
  > & {
    id: string
    merchantPubkey: string
    buyerPubkey: string
    subtotal: number
    items: Array<{
      productId: string
      quantity: number
      fulfillment?: {
        handoffMode?: string
        handlerPubkey?: string
      }
    }>
  }
  expect(orderPayload).toMatchObject({
    merchantPubkey: MERCHANT_PUBKEY,
    buyerPubkey: BUYER_PUBKEY,
    subtotal: 0,
    items: [
      {
        productId: ORGANIZER_PRODUCT_COORDINATE,
        quantity: 1,
        fulfillment: {
          handoffMode: "organizer_handoff",
          handlerPubkey: ORGANIZER_PUBKEY,
        },
      },
    ],
  })
  expect(Object.hasOwn(orderPayload, "shippingAddress")).toBe(false)
  expect(Object.hasOwn(orderPayload, "guestContact")).toBe(false)
  expect(Object.hasOwn(orderPayload, "note")).toBe(false)

  await gotoAs(page, merchantUrl, "/orders", "merchant", {
    order: orderPayload.id,
  })
  await expect(
    page.getByRole("heading", { name: "Orders", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page
      .getByText(ORGANIZER_PRODUCT_TITLE, { exact: true })
      .filter({ visible: true })
      .first()
  ).toBeVisible({ timeout: 30_000 })
  const merchantPickup = page.getByTestId("merchant-order-pickup")
  await expect(
    merchantPickup.getByText("Friendly Handoff Organizer", { exact: true })
  ).toBeVisible()
  await merchantPickup
    .getByRole("button", { name: "Copy pickup organizer npub", exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __merchantActorCopiedNpub?: string })
            .__merchantActorCopiedNpub
      )
    )
    .toBe(nip19.npubEncode(ORGANIZER_PUBKEY))
  const acceptOrder = page.getByRole("button", {
    name: "Accept order",
    exact: true,
  })
  await expect(acceptOrder).toBeEnabled({ timeout: 30_000 })
  const acceptancePublishStart = relay.publications.length
  await acceptOrder.click()
  await expect(
    page.getByText("Status update sent to buyer", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      () =>
        uniquePrivatePublications(
          decryptPrivatePublications(
            relay.publications,
            BUYER_SECRET,
            acceptancePublishStart
          )
        ).filter((message) => {
          if (rumorType(message.rumor) !== "status_update") return false
          return (
            (JSON.parse(message.rumor.content) as { status?: string })
              .status === "accepted"
          )
        }).length
    )
    .toBe(1)
  const acceptedMessage = uniquePrivatePublications(
    decryptPrivatePublications(
      relay.publications,
      BUYER_SECRET,
      acceptancePublishStart
    )
  ).find((message) => {
    if (rumorType(message.rumor) !== "status_update") return false
    return (
      (JSON.parse(message.rumor.content) as { status?: string }).status ===
      "accepted"
    )
  })!
  const receiptPanel = page.getByTestId("merchant-organizer-handoff-receipt")
  await expect(receiptPanel).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole("heading", {
      name: "Ready for organizer pickup?",
      exact: true,
    })
  ).toBeVisible()
  const shareReceipt = page.getByRole("button", {
    name: "Prepare organizer release",
    exact: true,
  })
  await expect(shareReceipt).toBeEnabled({ timeout: 30_000 })

  const receiptPublishStart = relay.publications.length
  await shareReceipt.click()
  const releaseDialog = page.getByRole("alertdialog", {
    name: "Confirm organizer release",
  })
  await expect(releaseDialog).toBeVisible()
  const authorizeRelease = releaseDialog.getByRole("button", {
    name: "Authorize organizer release",
    exact: true,
  })
  await expect(authorizeRelease).toBeDisabled()
  await releaseDialog
    .getByRole("checkbox", {
      name: /I confirm payment is settled or nothing is owed/i,
    })
    .check()
  await expect(authorizeRelease).toBeEnabled()
  await authorizeRelease.click()
  await expect(
    page.getByText("Organizer release authorization delivered", {
      exact: true,
    })
  ).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      () =>
        uniquePrivatePublications(
          decryptPrivatePublications(
            relay.publications,
            ORGANIZER_SECRET,
            receiptPublishStart
          )
        ).filter(
          (message) =>
            rumorType(message.rumor) === "organizer_fulfillment_receipt"
        ).length
    )
    .toBe(1)
  const readyMessage = uniquePrivatePublications(
    decryptPrivatePublications(
      relay.publications,
      ORGANIZER_SECRET,
      receiptPublishStart
    )
  ).find(
    (message) => rumorType(message.rumor) === "organizer_fulfillment_receipt"
  )!
  const readyPayload = JSON.parse(readyMessage.rumor.content) as {
    type: string
    state: string
    paymentConfirmed: boolean
    orderReady: boolean
    releaseAuthorized: boolean
    claimRef: string
    merchantPubkey: string
    organizerPubkey: string
    option: { coordinate: string }
    items: Array<{
      product: { coordinate: string }
      quantity: number
      variants: unknown[]
    }>
  }
  expect(readyPayload).toMatchObject({
    type: "organizer_fulfillment_receipt",
    state: "ready_for_pickup",
    paymentConfirmed: true,
    orderReady: true,
    releaseAuthorized: true,
    merchantPubkey: MERCHANT_PUBKEY,
    organizerPubkey: ORGANIZER_PUBKEY,
    option: { coordinate: market.pickupCoordinate },
    items: [
      {
        product: { coordinate: ORGANIZER_PRODUCT_COORDINATE },
        quantity: 1,
        variants: [],
      },
    ],
  })
  const readySerialized = JSON.stringify(readyPayload)
  for (const forbidden of [
    "buyerPubkey",
    "guestContact",
    "shippingAddress",
    "address",
    "note",
    "invoice",
    "preimage",
    orderPayload.id,
  ]) {
    expect(readySerialized).not.toContain(forbidden)
  }
  expect(
    uniquePrivatePublications(
      decryptPrivatePublications(
        relay.publications,
        BUYER_SECRET,
        receiptPublishStart
      )
    ).filter(
      (message) => rumorType(message.rumor) === "organizer_fulfillment_receipt"
    )
  ).toEqual([])
  const pickupCode = formatPickupClaimCode(readyPayload.claimRef)

  relay.seed(...createCappedInboxNoise(ORGANIZER_PUBKEY, 400))

  const organizerEventMarketStorageKey = `conduit:merchant:event-markets:v1:${ORGANIZER_PUBKEY}`
  const savedOrganizerEventMarkets = await page.evaluate(
    (storageKey) => localStorage.getItem(storageKey),
    organizerEventMarketStorageKey
  )
  const concurrentContext = await browser.newContext()
  const concurrentPage = await concurrentContext.newPage()
  const concurrentBrowserErrors = captureBrowserErrors(concurrentPage)
  await installSyntheticEnvironment(concurrentPage, relay, "mutator")
  await concurrentPage.addInitScript(
    ({ storageKey, savedReferences }) => {
      if (savedReferences) localStorage.setItem(storageKey, savedReferences)
    },
    {
      storageKey: organizerEventMarketStorageKey,
      savedReferences: savedOrganizerEventMarkets,
    }
  )
  await gotoAs(concurrentPage, merchantUrl, "/events", "organizer")
  await selectOrganizerMarket(
    concurrentPage,
    "Synthetic Organizer Handoff Market"
  )
  const concurrentParticipationRow = concurrentPage
    .getByTestId("organizer-product-preview")
    .filter({ hasText: ORGANIZER_PRODUCT_TITLE })
    .locator("..")
  const concurrentRemoveProduct = concurrentParticipationRow.getByRole(
    "button",
    { name: "Remove", exact: true }
  )
  await expect(concurrentRemoveProduct).toBeEnabled({ timeout: 30_000 })
  await expect(
    concurrentPage
      .getByTestId("organizer-handoff-receipt-queue")
      .locator("article")
      .filter({ hasText: pickupCode })
      .getByRole("button", { name: "Mark handed out", exact: true })
  ).toBeEnabled({ timeout: 30_000 })

  await gotoAs(page, merchantUrl, "/events", "organizer")
  await selectOrganizerMarket(page, "Synthetic Organizer Handoff Market")
  const queue = page.getByTestId("organizer-handoff-receipt-queue")
  await expect(queue).toBeVisible({ timeout: 30_000 })
  await expect(queue.getByText(/Receipt discovery is incomplete/i)).toBeVisible(
    { timeout: 30_000 }
  )
  await expect
    .poll(() =>
      relay.requests.some((request) =>
        request.filters.some(
          (filter) =>
            filter.kinds?.includes(1059) &&
            Array.isArray(filter["#p"]) &&
            filter["#p"].some((value) => value === ORGANIZER_PUBKEY) &&
            filter.limit === 400 &&
            request.matchedEventIds.length === 400
        )
      )
    )
    .toBe(true)
  const queuedClaim = queue.locator("article").filter({ hasText: pickupCode })
  await expect(queuedClaim).toBeVisible({ timeout: 30_000 })
  await expect(
    queuedClaim.getByText(ORGANIZER_PRODUCT_TITLE, { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(queuedClaim.getByText("Qty 1", { exact: true })).toBeVisible()
  await expect(
    queuedClaim.getByText(`Pickup code ${pickupCode}`, { exact: true })
  ).toBeVisible()
  await expect(
    queuedClaim.getByText("Ready for pickup", { exact: true })
  ).toBeVisible()
  await expect(
    queuedClaim.getByText("Friendly Handoff Merchant", { exact: true })
  ).toBeVisible()
  await queuedClaim
    .getByRole("button", { name: "Copy handoff merchant npub", exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __merchantActorCopiedNpub?: string })
            .__merchantActorCopiedNpub
      )
    )
    .toBe(nip19.npubEncode(MERCHANT_PUBKEY))
  const acknowledge = queuedClaim.getByRole("button", {
    name: "Mark handed out",
    exact: true,
  })
  await expect(acknowledge).toBeEnabled({ timeout: 30_000 })

  const participationRow = page
    .getByTestId("organizer-product-preview")
    .filter({ hasText: ORGANIZER_PRODUCT_TITLE })
    .locator("..")
  const removeProduct = participationRow.getByRole("button", {
    name: "Remove",
    exact: true,
  })
  await expect(removeProduct).toBeEnabled({ timeout: 30_000 })

  let acknowledgementReceiptReadStarted = false
  const merchandiseRead = relay.holdRelayRequests((request) => {
    if (request.clientId !== "acknowledger") return false
    if (
      request.filters.some(
        (filter) =>
          filter.kinds?.includes(1059) &&
          filter["#p"]?.includes(ORGANIZER_PUBKEY)
      )
    ) {
      acknowledgementReceiptReadStarted = true
      return false
    }
    return (
      acknowledgementReceiptReadStarted &&
      request.filters.some(
        (filter) =>
          filter.kinds?.includes(30402) && filter.ids?.includes(productEvent.id)
      )
    )
  })
  const staleHandoffPublishStart = relay.publications.length
  await acknowledge.click()
  await merchandiseRead.captured
  await expect(
    queuedClaim.getByRole("button", {
      name: "Sending exact update...",
      exact: true,
    })
  ).toBeDisabled()
  await expect(removeProduct).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Update event", exact: true })
  ).toBeDisabled()

  const removalAck = relay.holdNextPublicationAck(
    (event) =>
      event.kind === 30405 &&
      eventCoordinate(event) === market.collectionCoordinate &&
      !event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === ORGANIZER_PRODUCT_COORDINATE
      )
  )
  await concurrentRemoveProduct.click()
  const removedCollection = await removalAck.captured
  expect(removedCollection.created_at).toBeGreaterThan(
    acceptedCollection.created_at
  )
  const removedSavedOrganizerEventMarkets = await concurrentPage.evaluate(
    (storageKey) => localStorage.getItem(storageKey),
    organizerEventMarketStorageKey
  )
  expect(removedSavedOrganizerEventMarkets).toBeTruthy()
  await page.evaluate(
    ({ storageKey, savedReferences }) => {
      if (savedReferences) localStorage.setItem(storageKey, savedReferences)
    },
    {
      storageKey: organizerEventMarketStorageKey,
      savedReferences: removedSavedOrganizerEventMarkets,
    }
  )
  await expect
    .poll(() =>
      page.evaluate(
        ({ organizerPubkey, eventId }) => {
          const raw = localStorage.getItem(
            `conduit:merchant:event-markets:v1:${organizerPubkey}`
          )
          if (!raw) return false
          const saved = JSON.parse(raw) as Array<{
            expectedCollectionEventId?: string
          }>
          return saved.some(
            (reference) => reference.expectedCollectionEventId === eventId
          )
        },
        {
          organizerPubkey: ORGANIZER_PUBKEY,
          eventId: removedCollection.id,
        }
      )
    )
    .toBe(true)
  relay.remove(removedCollection)
  removalAck.release()
  const acceptAgain = concurrentParticipationRow.getByRole("button", {
    name: "Accept",
    exact: true,
  })
  await expect(acceptAgain).toBeEnabled({ timeout: 30_000 })

  merchandiseRead.release()
  await expect(
    queue.getByText(/latest signed event records are not yet readable/i)
  ).toBeVisible({ timeout: 30_000 })
  expect(
    uniquePrivatePublications(
      decryptPrivatePublications(
        relay.publications,
        MERCHANT_SECRET,
        staleHandoffPublishStart
      )
    ).filter((message) => rumorType(message.rumor) === "organizer_handoff_ack")
  ).toEqual([])

  // The stale-read phase is complete. Make the removed graph observable before
  // the independent organizer starts a new edit; cached-only child evidence
  // must not be used as fresh authority for the recovery phase.
  relay.seed(removedCollection)
  await concurrentPage.getByRole("button", { name: "Refresh evidence" }).click()
  await expect(acceptAgain).toBeEnabled({ timeout: 30_000 })

  const restoreAck = relay.holdNextPublicationAck(
    (event) =>
      event.kind === 30405 &&
      eventCoordinate(event) === market.collectionCoordinate &&
      event.tags.some(
        (tag) => tag[0] === "a" && tag[1] === ORGANIZER_PRODUCT_COORDINATE
      )
  )
  await acceptAgain.click()
  const restoredCollection = await restoreAck.captured
  expect(restoredCollection.created_at).toBeGreaterThan(
    removedCollection.created_at
  )
  restoreAck.release()
  await expect(
    concurrentParticipationRow.getByText("Accepted", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  expect(concurrentBrowserErrors.pageErrors).toEqual([])
  expect(concurrentBrowserErrors.consoleErrors).toEqual([])
  await concurrentContext.close()

  await page.getByRole("button", { name: "Refresh evidence" }).click()
  await expect(queue).toBeVisible({ timeout: 30_000 })
  await expect(acknowledge).toBeEnabled({ timeout: 30_000 })

  const ackPublishStart = relay.publications.length
  await acknowledge.click()
  await expect(
    queuedClaim.getByText("Handed out", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      () =>
        uniquePrivatePublications(
          decryptPrivatePublications(
            relay.publications,
            MERCHANT_SECRET,
            ackPublishStart
          )
        ).filter(
          (message) => rumorType(message.rumor) === "organizer_handoff_ack"
        ).length
    )
    .toBe(1)
  const ackMessage = uniquePrivatePublications(
    decryptPrivatePublications(
      relay.publications,
      MERCHANT_SECRET,
      ackPublishStart
    )
  ).find((message) => rumorType(message.rumor) === "organizer_handoff_ack")!
  const ackPayload = JSON.parse(ackMessage.rumor.content) as {
    type: string
    state: string
    claimRef: string
    readyReceiptId: string
    merchantPubkey: string
    organizerPubkey: string
  }
  expect(ackPayload).toMatchObject({
    type: "organizer_handoff_ack",
    state: "handed_out",
    claimRef: readyPayload.claimRef,
    readyReceiptId: readyMessage.rumor.id,
    merchantPubkey: MERCHANT_PUBKEY,
    organizerPubkey: ORGANIZER_PUBKEY,
  })

  const merchantAckReadStart = relay.requests.length
  await gotoAs(page, merchantUrl, "/orders", "merchant", {
    order: orderPayload.id,
  })
  await expect
    .poll(() =>
      relay.requests
        .slice(merchantAckReadStart)
        .some((request) => request.matchedEventIds.includes(ackMessage.wrap.id))
    )
    .toBe(true)
  const refreshedReceiptPanel = page.getByTestId(
    "merchant-organizer-handoff-receipt"
  )
  await expect(refreshedReceiptPanel).toHaveAttribute(
    "data-ack-read-state",
    "clear",
    { timeout: 30_000 }
  )
  await expect(refreshedReceiptPanel).toHaveAttribute("data-ack-exact", "true")
  await expect(
    refreshedReceiptPanel.getByText("Organizer handed out", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  const complete = page.getByRole("button", {
    name: "Mark picked up / complete",
    exact: true,
  })
  const pickupUnverified = page.getByTestId("merchant-order-pickup-unverified")
  const retryVerification = pickupUnverified.getByRole("button", {
    name: "Retry verification",
    exact: true,
  })
  // Retry is visible but disabled while pickup verification is still running.
  // Wait for a settled action before deciding whether recovery is needed.
  await expect(complete.or(retryVerification)).toBeEnabled({ timeout: 30_000 })
  if (await retryVerification.isVisible()) {
    await expect(pickupUnverified).toContainText(
      "Current signed pickup evidence could not be verified from relays. Try again when relay access recovers."
    )
    await retryVerification.click()
    await expect(pickupUnverified).toHaveCount(0, { timeout: 30_000 })
  }
  await expect(complete).toBeEnabled({ timeout: 30_000 })

  const completionPublishStart = relay.publications.length
  await complete.click()
  await expect(
    page.getByText("Status update sent to buyer", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText("Complete", { exact: true }).first()
  ).toBeVisible()
  await expect
    .poll(
      () =>
        uniquePrivatePublications(
          decryptPrivatePublications(
            relay.publications,
            BUYER_SECRET,
            completionPublishStart
          )
        ).filter((message) => {
          if (rumorType(message.rumor) !== "status_update") return false
          const payload = JSON.parse(message.rumor.content) as {
            status?: string
          }
          return payload.status === "complete"
        }).length
    )
    .toBe(1)
  const completeMessage = uniquePrivatePublications(
    decryptPrivatePublications(
      relay.publications,
      BUYER_SECRET,
      completionPublishStart
    )
  ).find((message) => {
    if (rumorType(message.rumor) !== "status_update") return false
    return (
      (JSON.parse(message.rumor.content) as { status?: string }).status ===
      "complete"
    )
  })!
  expect(merchantOrderMessage.publicationIndex).toBeLessThan(
    acceptedMessage.publicationIndex
  )
  expect(acceptedMessage.publicationIndex).toBeLessThan(
    readyMessage.publicationIndex
  )
  expect(readyMessage.publicationIndex).toBeLessThan(
    ackMessage.publicationIndex
  )
  expect(ackMessage.publicationIndex).toBeLessThan(
    completeMessage.publicationIndex
  )
  await expect(
    page.locator(
      "vite-error-overlay, .vite-error-overlay, #webpack-dev-server-client-overlay"
    )
  ).toHaveCount(0)
  expect(browserErrors.pageErrors).toEqual([])
  expect(browserErrors.consoleErrors).toEqual([])
})
