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
const INBOX_NOISE_SECRET = generateSecretKey()
const ORGANIZER_PRODUCT_D_TAG = "synthetic-organizer-handoff-product"
const ORGANIZER_PRODUCT_COORDINATE = `30402:${MERCHANT_PUBKEY}:${ORGANIZER_PRODUCT_D_TAG}`
const ORGANIZER_PRODUCT_TITLE = "Synthetic organizer handoff mug"
const MERCHANT_TEMPLATE_D_TAG = "synthetic-existing-product"
const MERCHANT_TEMPLATE_COORDINATE = `30402:${MERCHANT_PUBKEY}:${MERCHANT_TEMPLATE_D_TAG}`
const MERCHANT_TEMPLATE_TITLE = "Existing merchant mug"
const MERCHANT_PRODUCT_TITLE = "Synthetic merchant booth mug"
const FIXTURE_RELAY = `ws://127.0.0.1:${
  process.env.PLAYWRIGHT_RELAY_PORT ?? "7777"
}`
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

type RelayRequest = {
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
  const rejectedKinds = new Set<number>()

  return {
    publications,
    requests,
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
    events(): SignedEvent[] {
      return Array.from(eventsById.values())
    },
    async install(page: Page): Promise<void> {
      await page.routeWebSocket(FIXTURE_RELAY, (socket) => {
        socket.onMessage((message) => {
          if (typeof message !== "string") return
          const frame = parseRelayFrame(message)
          if (!frame || typeof frame[0] !== "string") return

          if (frame[0] === "REQ" && typeof frame[1] === "string") {
            const subscriptionId = frame[1]
            const filters = frame.slice(2).filter(isRelayFilter)
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
            requests.push({
              relayUrl: socket.url(),
              subscriptionId,
              filters: structuredClone(filters),
              matchedEventIds: limitedMatches.map((event) => event.id),
            })
            for (const event of limitedMatches) {
              socket.send(JSON.stringify(["EVENT", subscriptionId, event]))
            }
            socket.send(JSON.stringify(["EOSE", subscriptionId]))
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
  relay: RelayHarness
): Promise<void> {
  await relay.install(page)
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
  }
): Promise<PublishedOrganizerMarket> {
  await gotoAs(page, merchantUrl, "/events", "organizer")
  await expect(
    page.getByRole("heading", { name: "Events", exact: true })
  ).toBeVisible()
  await page.getByRole("tab", { name: "My events", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "My events", exact: true })
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
    .getByRole("textbox", { name: "Image URL Required", exact: true })
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
  await editor.getByRole("button", { name: "Publish event" }).click()
  await expect(editor).toBeHidden({ timeout: 30_000 })
  await expect(page.getByText("Active", { exact: true })).toBeVisible()
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
    page.getByRole("tab", { name: "Find events", exact: true })
  ).toHaveAttribute("data-state", "active")

  if (options.discoveryMode === "followed") {
    await expect(
      page.getByRole("heading", {
        name: "Events from organizers you follow",
        exact: true,
      })
    ).toBeVisible({ timeout: 30_000 })
    await page
      .getByRole("button", { name: `View ${options.eventTitle}`, exact: true })
      .click()
  } else if (options.discoveryMode === "direct") {
    await page.getByLabel("Event naddr or link").fill(market.canonicalNaddr)
    await page.getByRole("button", { name: "Open", exact: true }).click()
  }
  await expect(
    page.getByRole("button", { name: "Publish product", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  await page.getByRole("button", { name: "Publish product" }).click()
  const editor = page.getByRole("dialog", {
    name: `Publish a product to ${options.eventTitle}`,
  })
  await expect(editor).toBeVisible()
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
}): SignedEvent {
  return signEvent(MERCHANT_SECRET, {
    kind: 30402,
    created_at: input.createdAt,
    content: `${input.title} synthetic browser-only fixture.`,
    tags: [
      ["d", input.dTag],
      ["title", input.title],
      ["summary", "Synthetic accepted zero-cost product fixture."],
      ["price", "0", "SAT"],
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
  expect(productTitle).toBeTruthy()
  const productPreview = page.getByTestId("organizer-product-preview")
  await expect(productPreview).toHaveAttribute("data-preview-state", "verified")
  await expect(
    productPreview.getByText(productTitle!, { exact: true })
  ).toBeVisible()
  await expect(
    productPreview.getByText("Synthetic accepted zero-cost product fixture.", {
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

test.use({
  viewport: { width: 1440, height: 1000 },
  video: "off",
  trace: "off",
  screenshot: "off",
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

  await gotoAs(page, marketUrl, `/events/${market.canonicalNaddr}`, "buyer")
  const productCard = page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic Owner Product" })
  await expect(
    productCard.getByText("Pickup from merchant booth", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await productCard.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    page.getByText(
      "Synthetic Owner Product was added for pickup from merchant booth.",
      { exact: true }
    )
  ).toBeVisible()
  await gotoAs(page, marketUrl, "/checkout", "buyer", {
    merchant: nip19.npubEncode(ORGANIZER_PUBKEY),
  })
  await expect(
    page.getByText("Pickup from merchant booth", { exact: true }).first()
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /^Send order$/i })).toBeEnabled(
    { timeout: 30_000 }
  )
  await expect(page.getByText(/Organizer release authorization/)).toHaveCount(0)
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
    page.getByText(
      "Organizer handoff is not offered. Accepted merchants may provide their own pickup point.",
      { exact: true }
    )
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
  await page.getByLabel("Event naddr or link").fill(market.canonicalNaddr)
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
  await page.getByRole("tab", { name: "My events", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "My events", exact: true })
  ).toBeVisible()
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
  await gotoAs(page, marketUrl, "/checkout", "buyer", {
    merchant: nip19.npubEncode(MERCHANT_PUBKEY),
  })
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
  await installSyntheticEnvironment(page, relay)

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
  const shareReceipt = receiptPanel.getByRole("button", {
    name: "Review release authorization",
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

  await gotoAs(page, merchantUrl, "/events", "organizer")
  await page.getByRole("tab", { name: "My events", exact: true }).click()
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
  const acknowledge = queuedClaim.getByRole("button", {
    name: "Mark handed out",
    exact: true,
  })
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
