import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import { SHIPPING_COUNTRIES } from "./countries"
import { EVENT_KINDS } from "./kinds"
import { getNdk } from "./ndk"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import { fetchSignedEventsFanoutDetailed } from "./relay-reader"
import { publishWithPlanner } from "./relay-publish"
import {
  compareReplaceableEventFrontiers,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { normalizeOwnerSelectedRelayUrls } from "./relay-settings"

export const MERCHANT_SHIPPING_SETTINGS_D_TAG =
  "conduit/merchant-shipping-settings"
const FORMAT = "conduit-merchant-shipping-settings"
const VERSION = 1
const GEOHASH = /^[0123456789bcdefghjkmnpqrstuvwxyz]{4}$/
const PUBKEY = /^[0-9a-f]{64}$/i
const acceptedCountries = new Map(
  SHIPPING_COUNTRIES.map((country) => [country.code, country.name])
)

export interface MerchantShippingArea {
  location: string
  geohash: string
}

export interface MerchantShippingCountry {
  code: string
  name: string
  restrictTo: string[]
  exclude: string[]
}

export interface MerchantShippingSettings {
  countries: MerchantShippingCountry[]
  shipsFrom: MerchantShippingArea | null
}

export interface MerchantShippingRevision {
  eventId: string
  createdAt: number
}

export type MerchantShippingReadResult =
  | {
      state: "found"
      settings: MerchantShippingSettings
      revision: MerchantShippingRevision
      coverageComplete: boolean
    }
  | { state: "not_found" }
  | { state: "unavailable"; reason: "relay_read" | "invalid_document" }

function ownerPubkey(pubkey: string): string {
  const owner = pubkey.trim().toLowerCase()
  if (!PUBKEY.test(owner))
    throw new Error("Connected merchant identity is invalid.")
  return owner
}

export function parseMerchantShippingSettings(
  input: unknown
): MerchantShippingSettings {
  if (!input || typeof input !== "object")
    throw new Error("Invalid shipping settings")
  const document = input as Record<string, unknown>
  if (
    document.format !== FORMAT ||
    document.version !== VERSION ||
    !Array.isArray(document.countries)
  )
    throw new Error("Unsupported shipping settings")
  const countries: MerchantShippingCountry[] = []
  const seen = new Set<string>()
  for (const item of document.countries) {
    if (!item || typeof item !== "object")
      throw new Error("Invalid destination")
    const country = item as Record<string, unknown>
    const code = country.code
    if (
      typeof code !== "string" ||
      !acceptedCountries.has(code) ||
      seen.has(code)
    )
      throw new Error("Invalid destination country")
    if (
      !Array.isArray(country.restrictTo) ||
      !Array.isArray(country.exclude) ||
      [...country.restrictTo, ...country.exclude].some(
        (value) =>
          typeof value !== "string" || !value.trim() || value.length > 64
      )
    )
      throw new Error("Invalid postal rule")
    seen.add(code)
    countries.push({
      code,
      name: acceptedCountries.get(code)!,
      restrictTo: country.restrictTo,
      exclude: country.exclude,
    })
  }
  const area = document.shipsFrom
  if (
    area !== null &&
    (!area ||
      typeof area !== "object" ||
      typeof (area as Record<string, unknown>).location !== "string" ||
      !(area as { location: string }).location.trim() ||
      (area as { location: string }).location.length > 240 ||
      typeof (area as Record<string, unknown>).geohash !== "string" ||
      !GEOHASH.test((area as { geohash: string }).geohash))
  )
    throw new Error("Invalid ships from area")
  return { countries, shipsFrom: area as MerchantShippingArea | null }
}

export function serializeMerchantShippingSettings(
  settings: MerchantShippingSettings
): string {
  const normalized = parseMerchantShippingSettings({
    format: FORMAT,
    version: VERSION,
    ...settings,
  })
  return JSON.stringify({ format: FORMAT, version: VERSION, ...normalized })
}

export function selectMerchantShippingEvent(
  events: readonly SignedPublicNostrEvent[],
  pubkey: string
): SignedPublicNostrEvent | null {
  const owner = ownerPubkey(pubkey)
  return (
    events
      .filter(
        (event) =>
          event.kind === EVENT_KINDS.APPLICATION_DATA &&
          event.pubkey.toLowerCase() === owner &&
          event.tags.filter((tag) => tag[0] === "d").length === 1 &&
          event.tags.some(
            (tag) =>
              tag[0] === "d" && tag[1] === MERCHANT_SHIPPING_SETTINGS_D_TAG
          )
      )
      .sort(
        (a, b) =>
          -compareReplaceableEventFrontiers(
            { createdAt: a.created_at, eventId: a.id },
            { createdAt: b.created_at, eventId: b.id }
          )
      )[0] ?? null
  )
}

export async function fetchMerchantShippingSettings(
  pubkey: string,
  dependencies: {
    fetchEvents?: typeof fetchSignedEventsFanoutDetailed
    readRelayUrls?: string[]
    shouldContinue?: () => boolean
  } = {}
): Promise<MerchantShippingReadResult> {
  const owner = ownerPubkey(pubkey)
  let relayUrls = dependencies.readRelayUrls
  if (!relayUrls) {
    const snapshot =
      await readDurableAccountRelaySettingsPlanningSnapshot(owner)
    const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls(
      snapshot.settings.entries.flatMap((entry) =>
        entry.readEnabled || entry.writeEnabled ? [entry.url] : []
      )
    )
    const relayListPlan = planRelayReads({
      intent: "relay_lists",
      authenticatedPubkey: owner,
      ownerSelectedRelayUrls,
      settings: snapshot.settings,
      signedRelayListAuthoritative: snapshot.signedRelayListAuthoritative,
      maxRelays: 8,
    })
    const relayLists = await getRelayLists([owner], {
      accountPubkey: owner,
      authenticatedPubkey: owner,
      relayUrls: relayListPlan.candidateRelayUrls,
      maxRelayAttempts: relayListPlan.maxRelayAttempts,
      ownerSelectedRelayUrls: relayListPlan.ownerSelectedRelayUrls,
      appRelayUrls: relayListPlan.appRelayUrls,
      personalRelayUrls: relayListPlan.personalRelayUrls,
      independentRelayUrls: relayListPlan.independentRelayUrls,
      shouldContinue: dependencies.shouldContinue,
    })
    const plan = planRelayReads({
      intent: "general",
      authors: [owner],
      relayLists,
      authenticatedPubkey: owner,
      ownerSelectedRelayUrls,
      settings: snapshot.settings,
      signedRelayListAuthoritative: snapshot.signedRelayListAuthoritative,
      maxRelays: 8,
    })
    relayUrls = Array.from(
      new Set([
        ...plan.relayUrls,
        ...config.appWriteRelayUrls,
        ...config.corePublicFallbackRelayUrls,
      ])
    )
  }
  relayUrls = Array.from(new Set(relayUrls)).slice(0, 8)
  if (relayUrls.length === 0)
    return { state: "unavailable", reason: "relay_read" }
  try {
    const result = await (
      dependencies.fetchEvents ?? fetchSignedEventsFanoutDetailed
    )(
      {
        kinds: [EVENT_KINDS.APPLICATION_DATA],
        authors: [owner],
        "#d": [MERCHANT_SHIPPING_SETTINGS_D_TAG],
        limit: 12,
      },
      {
        relayUrls,
        maxRelayAttempts: 8,
        accountPubkey: owner,
        authenticatedPubkey: owner,
        shouldContinue: dependencies.shouldContinue,
        connectTimeoutMs: 2_000,
        fetchTimeoutMs: 3_000,
      }
    )
    if (!result.eventsVerified)
      return { state: "unavailable", reason: "relay_read" }
    const coverageComplete =
      result.relays.length === relayUrls.length &&
      result.relays.every((relay) => relay.status === "success")
    const latest = selectMerchantShippingEvent(result.events, owner)
    if (!latest)
      return coverageComplete
        ? { state: "not_found" }
        : { state: "unavailable", reason: "relay_read" }
    try {
      return {
        state: "found",
        settings: parseMerchantShippingSettings(
          JSON.parse(latest.content) as unknown
        ),
        revision: { eventId: latest.id, createdAt: latest.created_at },
        coverageComplete,
      }
    } catch {
      return { state: "unavailable", reason: "invalid_document" }
    }
  } catch {
    if (dependencies.shouldContinue?.() === false)
      throw new Error("Merchant session changed during shipping settings read")
    return { state: "unavailable", reason: "relay_read" }
  }
}

export async function publishMerchantShippingSettings(input: {
  pubkey: string
  settings: MerchantShippingSettings
  acceptedRevision?: MerchantShippingRevision | null
  dependencies?: {
    signer?: NDKSigner
    fetchEvents?: typeof fetchSignedEventsFanoutDetailed
    readRelayUrls?: string[]
    publishEvent?: typeof publishWithPlanner
    shouldContinue?: () => boolean
    now?: () => number
  }
}): Promise<MerchantShippingRevision> {
  const owner = ownerPubkey(input.pubkey)
  const ndk = getNdk()
  const signer = input.dependencies?.signer ?? ndk.signer
  if (!signer || (await signer.user()).pubkey.toLowerCase() !== owner)
    throw new Error(
      "Connect the matching merchant signer before saving shipping settings"
    )
  const current = await fetchMerchantShippingSettings(owner, input.dependencies)
  if (current.state === "unavailable")
    throw new Error(
      "Shipping settings could not be read from relays. Retry before replacing them."
    )
  if (current.state === "found" && !current.coverageComplete)
    throw new Error(
      "Shipping settings read was incomplete. Retry before replacing them."
    )
  if (current.state === "found" && !input.acceptedRevision)
    throw new Error(
      "Published shipping settings were found. Reload before saving."
    )
  if (current.state === "not_found" && input.acceptedRevision)
    throw new Error(
      "The previously published shipping settings are unavailable. Retry before saving."
    )
  if (
    input.acceptedRevision &&
    current.state === "found" &&
    current.revision.eventId !== input.acceptedRevision.eventId
  )
    throw new Error(
      "Shipping settings changed on another session. Reload before saving."
    )
  const createdAt = Math.max(
    Math.floor((input.dependencies?.now?.() ?? Date.now()) / 1000),
    (current.state === "found" ? current.revision.createdAt : 0) + 1,
    (input.acceptedRevision?.createdAt ?? 0) + 1
  )
  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.APPLICATION_DATA
  event.pubkey = owner
  event.created_at = createdAt
  event.tags = [["d", MERCHANT_SHIPPING_SETTINGS_D_TAG]]
  event.content = serializeMerchantShippingSettings(input.settings)
  await event.sign(signer)
  await (input.dependencies?.publishEvent ?? publishWithPlanner)(event, {
    intent: "author_event",
    authorPubkey: owner,
    authenticatedPubkey: owner,
    accountPubkey: owner,
    refreshRelayLists: false,
    deliveryMode: "standard",
    shouldContinue: input.dependencies?.shouldContinue,
  })
  return { eventId: event.id, createdAt }
}
