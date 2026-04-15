import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import { EVENT_KINDS } from "./kinds"

export type ConduitAppId = "market" | "merchant"

export interface ConduitNip89AppDefinition {
  id: ConduitAppId
  name: string
  about: string
  dTag: string
  pubkey: string | null
  relayHint: string
  supportedKinds: number[]
  web: Array<{ url: string; entity?: string }>
}

export interface NIP89ClientTagParts {
  name: string
  address: string
  relayHint: string
}

type NostrTag = string[]

function makeWebTag(url: string, entity?: string): string[] {
  return entity ? ["web", url, entity] : ["web", url]
}

function createAppDefinition(params: {
  id: ConduitAppId
  name: string
  about: string
  dTag: string
  pubkey: string | null
  relayHint: string
  supportedKinds: number[]
  web: Array<{ url: string; entity?: string }>
}): ConduitNip89AppDefinition {
  return {
    id: params.id,
    name: params.name,
    about: params.about,
    dTag: params.dTag,
    pubkey: params.pubkey,
    relayHint: params.relayHint,
    supportedKinds: params.supportedKinds,
    web: params.web,
  }
}

const appDefinitions: Record<ConduitAppId, ConduitNip89AppDefinition> = {
  market: createAppDefinition({
    id: "market",
    name: "Conduit Market",
    about: "Buyer marketplace app for discovering products and sending orders over Nostr.",
    dTag: config.nip89MarketDTag,
    pubkey: config.nip89MarketPubkey,
    relayHint: config.nip89RelayHint,
    supportedKinds: [EVENT_KINDS.PROFILE, 3, EVENT_KINDS.ORDER],
    web: [
      { url: "https://shop.conduit.market/e/<bech32>" },
      { url: "https://shop.conduit.market/p/<bech32>", entity: "nprofile" },
      { url: "https://shop.conduit.market/a/<bech32>", entity: "naddr" },
    ],
  }),
  merchant: createAppDefinition({
    id: "merchant",
    name: "Conduit Merchant",
    about: "Seller app for listings, invoices, fulfillment, and buyer conversations.",
    dTag: config.nip89MerchantDTag,
    pubkey: config.nip89MerchantPubkey,
    relayHint: config.nip89RelayHint,
    supportedKinds: [EVENT_KINDS.PROFILE, EVENT_KINDS.DELETION, EVENT_KINDS.ORDER, EVENT_KINDS.PRODUCT, 23194],
    web: [
      { url: "https://sell.conduit.market/e/<bech32>" },
      { url: "https://sell.conduit.market/p/<bech32>", entity: "nprofile" },
      { url: "https://sell.conduit.market/a/<bech32>", entity: "naddr" },
    ],
  }),
}

export function getConduitNip89AppDefinition(appId: ConduitAppId): ConduitNip89AppDefinition {
  return appDefinitions[appId]
}

export function getConduitNip89HandlerAddress(appId: ConduitAppId): string | null {
  const app = getConduitNip89AppDefinition(appId)
  if (!app.pubkey) return null
  return `${EVENT_KINDS.APPLICATION_HANDLER}:${app.pubkey}:${app.dTag}`
}

export function buildNip89ClientTag(parts: NIP89ClientTagParts): string[] {
  return ["client", parts.name, parts.address, parts.relayHint]
}

export function buildConduitClientTag(appId: ConduitAppId): string[] | null {
  const app = getConduitNip89AppDefinition(appId)
  const address = getConduitNip89HandlerAddress(appId)
  if (!address) return null
  return buildNip89ClientTag({
    name: app.name,
    address,
    relayHint: app.relayHint,
  })
}

function isConduitClientTagForApp(tag: NostrTag, appId: ConduitAppId): boolean {
  if (tag[0] !== "client") return false
  const app = getConduitNip89AppDefinition(appId)
  return tag[1] === app.name || tag[2]?.endsWith(`:${app.dTag}`) === true
}

export function appendConduitClientTag(tags: NostrTag[] | undefined, appId: ConduitAppId): NostrTag[] {
  const nextTags = Array.from(tags ?? []).filter((tag) => !isConduitClientTagForApp(tag, appId))
  const clientTag = buildConduitClientTag(appId)
  if (!clientTag) return nextTags
  nextTags.push(clientTag)
  return nextTags
}

export function buildConduitHandlerEventContent(appId: ConduitAppId): string {
  const app = getConduitNip89AppDefinition(appId)
  return JSON.stringify({
    name: app.name,
    about: app.about,
  })
}

export function buildConduitHandlerEventTags(appId: ConduitAppId): string[][] {
  const app = getConduitNip89AppDefinition(appId)
  const tags: string[][] = [
    ["d", app.dTag],
    ...app.supportedKinds.map((kind) => ["k", String(kind)]),
    ...app.web.map((entry) => makeWebTag(entry.url, entry.entity)),
  ]
  return tags
}

export async function publishConduitHandlerEvent(params: {
  appId: ConduitAppId
  nsec: string
  relayUrls?: string[]
}): Promise<{ eventId: string; address: string }> {
  const app = getConduitNip89AppDefinition(params.appId)
  if (!app.pubkey) {
    throw new Error(`Missing configured pubkey for ${params.appId} NIP-89 handler`)
  }

  const signer = new NDKPrivateKeySigner(params.nsec)
  const signerUser = await signer.user()
  if (signerUser.pubkey !== app.pubkey) {
    throw new Error(`Configured pubkey for ${params.appId} does not match the provided NSEC`)
  }

  const ndk = new NDK({
    explicitRelayUrls: params.relayUrls && params.relayUrls.length > 0 ? params.relayUrls : [app.relayHint],
    signer,
  })

  await ndk.connect(5000)

  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.APPLICATION_HANDLER
  event.created_at = Math.floor(Date.now() / 1000)
  event.content = buildConduitHandlerEventContent(params.appId)
  event.tags = buildConduitHandlerEventTags(params.appId)

  await event.sign(signer)
  await event.publish()

  return {
    eventId: event.id,
    address: `${EVENT_KINDS.APPLICATION_HANDLER}:${app.pubkey}:${app.dTag}`,
  }
}
