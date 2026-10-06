import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { NostrKeySigner } from "./nostr-event-signer"
import { getAccountSigner } from "./session-signer"
import { z } from "zod"
import {
  getDirectMessageConversationList,
  cacheParsedDirectMessage,
} from "./commerce"
import { decodeEventMarketReference } from "./event-market"
import { resolveEventMarketOrganizerInbox } from "./event-market-handoff"
import {
  buildDirectMessageRumor,
  publishPrivateMessage,
  parseDirectMessageRumor,
  unwrapGiftWrap,
  type ParsedDirectMessage,
} from "./messaging"
import { getNdk } from "./ndk"
import { publishWithPlanner } from "./relay-publish"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX = /^[0-9a-f]{64}$/
const PREFIX = "Event Market participation v1\n"
const schema = z
  .object({
    version: z.literal(1),
    action: z.enum(["request", "invite", "decline", "withdraw"]),
    marketCoordinate: z.string(),
    merchantPubkey: z.string().regex(HEX),
    organizerPubkey: z.string().regex(HEX),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
export type EventMarketEnrollmentPayload = z.infer<typeof schema>
export interface EventMarketEnrollmentMessage extends EventMarketEnrollmentPayload {
  id: string
}
export interface EventMarketEnrollmentState {
  merchantPubkey: string
  status: "requested" | "invited" | "declined" | "withdrawn"
  latest: EventMarketEnrollmentMessage
}

function actors(payload: EventMarketEnrollmentPayload): [string, string] {
  return payload.action === "request" || payload.action === "withdraw"
    ? [payload.merchantPubkey, payload.organizerPubkey]
    : [payload.organizerPubkey, payload.merchantPubkey]
}
function validPayload(value: unknown): EventMarketEnrollmentPayload {
  const payload = schema.parse(value)
  const decoded = decodeEventMarketReference(payload.marketCoordinate, [30409])
  if (
    !decoded ||
    decoded.coordinate !== payload.marketCoordinate ||
    decoded.authorPubkey !== payload.organizerPubkey
  )
    throw new Error(
      "Participation must name the exact organizer's Event Market."
    )
  return payload
}
/** Presentation only: does not authenticate a message or authorize admission. */
export function getEventMarketEnrollmentDisplayContent(
  content: string
): string {
  if (!content.startsWith(PREFIX)) return content
  try {
    const payload = validPayload(JSON.parse(content.slice(PREFIX.length)))
    const labels: Record<EventMarketEnrollmentPayload["action"], string> = {
      request: "Requested to join an event.",
      invite: "Invited a merchant to join an event.",
      decline: "Declined a request to join an event.",
      withdraw: "Withdrew a request to join an event.",
    }
    return labels[payload.action]
  } catch {
    return content
  }
}

/** Parsed NIP-17 messages already carry authenticated seal/rumor sender identity. */
export function parseEventMarketEnrollmentMessage(
  message: ParsedDirectMessage
): EventMarketEnrollmentMessage | null {
  if (message.transport !== "nip17" || !message.content.startsWith(PREFIX))
    return null
  try {
    const payload = validPayload(
      JSON.parse(message.content.slice(PREFIX.length))
    )
    const [sender, recipient] = actors(payload)
    if (
      message.senderPubkey !== sender ||
      message.recipientPubkey !== recipient ||
      !HEX.test(message.id) ||
      message.createdAt !== payload.createdAt * 1000
    )
      return null
    return { ...payload, id: message.id }
  } catch {
    return null
  }
}
/** Enrollment is an advisory conversation state; it never creates admission. */
export function reduceEventMarketEnrollment(input: {
  marketCoordinate: string
  messages: readonly EventMarketEnrollmentMessage[]
}): EventMarketEnrollmentState[] {
  const latest = new Map<string, EventMarketEnrollmentMessage>()
  for (const message of input.messages) {
    if (message.marketCoordinate !== input.marketCoordinate) continue
    const previous = latest.get(message.merchantPubkey)
    if (
      !previous ||
      message.createdAt > previous.createdAt ||
      (message.createdAt === previous.createdAt && message.id > previous.id)
    )
      latest.set(message.merchantPubkey, message)
  }
  const statuses = {
    request: "requested",
    invite: "invited",
    decline: "declined",
    withdraw: "withdrawn",
  } as const
  return [...latest.values()].map((message) => ({
    merchantPubkey: message.merchantPubkey,
    status: statuses[message.action],
    latest: message,
  }))
}

export async function readEventMarketEnrollment(input: {
  accountPubkey: string
  marketCoordinate: string
  shouldContinue?: () => boolean
}) {
  if (input.shouldContinue?.() === false)
    throw new Error("Participation session changed.")
  const result = await getDirectMessageConversationList({
    principalPubkey: input.accountPubkey,
  })
  if (input.shouldContinue?.() === false)
    throw new Error("Participation session changed.")
  const messages = result.data
    .flatMap((conversation) => conversation.messages ?? [])
    .flatMap((message) => {
      const parsed = parseEventMarketEnrollmentMessage(message)
      return parsed ? [parsed] : []
    })
  return {
    states: reduceEventMarketEnrollment({
      marketCoordinate: input.marketCoordinate,
      messages,
    }),
    stale: result.meta.stale,
    inbox: result.meta.inbox,
  }
}

export interface EventMarketEnrollmentDelivery {
  version: 1
  payload: EventMarketEnrollmentPayload
  rumorId: string
  signedRecipientWrap: SignedPublicNostrEvent
  signedSelfWrap: SignedPublicNostrEvent
}
export type EnrollmentStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>
function storageKey(owner: string, market: string) {
  return `conduit:event-market-enrollment:1:${owner}:${market}`
}
function storage(): EnrollmentStorage {
  if (typeof localStorage === "undefined")
    throw new Error(
      "Local recovery storage is required before sending participation."
    )
  return localStorage
}
function validateDelivery(
  value: EventMarketEnrollmentDelivery
): EventMarketEnrollmentDelivery {
  const payload = validPayload(value.payload)
  const [sender, recipient] = actors(payload)
  if (
    value.version !== 1 ||
    !HEX.test(value.rumorId) ||
    !isValidSignedPublicNostrEvent(value.signedRecipientWrap) ||
    !isValidSignedPublicNostrEvent(value.signedSelfWrap) ||
    value.signedRecipientWrap.kind !== 1059 ||
    value.signedSelfWrap.kind !== 1059 ||
    value.signedRecipientWrap.tags.find((tag) => tag[0] === "p")?.[1] !==
      recipient ||
    value.signedSelfWrap.tags.find((tag) => tag[0] === "p")?.[1] !== sender
  )
    throw new Error("Saved participation delivery needs review.")
  return value
}
export function loadEventMarketEnrollmentDelivery(
  owner: string,
  market: string,
  persistence = storage()
): EventMarketEnrollmentDelivery | null {
  const raw = persistence.getItem(storageKey(owner, market))
  if (!raw) return null
  try {
    const record = validateDelivery(JSON.parse(raw))
    if (
      actors(record.payload)[0] !== owner ||
      record.payload.marketCoordinate !== market
    )
      throw new Error("Wrong participation owner.")
    return record
  } catch {
    throw new Error(
      "Saved participation delivery needs review before another message."
    )
  }
}

function rumorFor(payload: EventMarketEnrollmentPayload) {
  const [sender, recipient] = actors(payload)
  return buildDirectMessageRumor({
    senderPubkey: sender,
    recipientPubkey: recipient,
    appId: "merchant",
    content: PREFIX + JSON.stringify(payload),
    createdAt: payload.createdAt,
    subject: "Event Market participation",
  })
}
interface EnrollmentDeliveryDependencies {
  send: typeof publishPrivateMessage
  cache: typeof cacheParsedDirectMessage
  inbox: typeof resolveEventMarketOrganizerInbox
  publish: typeof publishWithPlanner
  unwrap: typeof unwrapGiftWrap
}
const defaultDeliveryDependencies: EnrollmentDeliveryDependencies = {
  send: publishPrivateMessage,
  cache: cacheParsedDirectMessage,
  inbox: resolveEventMarketOrganizerInbox,
  publish: publishWithPlanner,
  unwrap: unwrapGiftWrap,
}

export async function publishEventMarketEnrollment(
  input: {
    payload: EventMarketEnrollmentPayload
    authenticatedPubkey: string
    signer: NostrKeySigner
    shouldContinue?: () => boolean
    persistence?: EnrollmentStorage
  },
  dependencies: EnrollmentDeliveryDependencies = defaultDeliveryDependencies
): Promise<void> {
  const payload = validPayload(input.payload)
  const [sender, recipient] = actors(payload)
  if (
    sender !== input.authenticatedPubkey ||
    input.shouldContinue?.() === false
  )
    throw new Error("Connect the participation sender's signer.")
  const persistence = input.persistence ?? storage()
  if (
    loadEventMarketEnrollmentDelivery(
      sender,
      payload.marketCoordinate,
      persistence
    )
  )
    throw new Error(
      "Retry saved participation delivery before sending another message."
    )
  const rumor = rumorFor(payload)
  const result = await dependencies.send({
    rumor,
    senderPubkey: sender,
    recipientPubkey: recipient,
    accountPubkey: sender,
    authenticatedPubkey: sender,
    signer: input.signer,
    rumorKind: 14,
    selfCopy: true,
    signerInteraction: "external",
    shouldContinue: input.shouldContinue,
    onWrapped: (prepared) => {
      const record = validateDelivery({
        version: 1,
        payload,
        rumorId: prepared.rumorId,
        signedRecipientWrap:
          prepared.wrappedToRecipient.rawEvent() as SignedPublicNostrEvent,
        signedSelfWrap:
          prepared.wrappedToSelf?.rawEvent() as SignedPublicNostrEvent,
      })
      const serialized = JSON.stringify(record)
      persistence.setItem(
        storageKey(sender, payload.marketCoordinate),
        serialized
      )
      if (
        persistence.getItem(storageKey(sender, payload.marketCoordinate)) !==
        serialized
      )
        throw new Error("Participation recovery was not saved before delivery.")
    },
  })
  await dependencies.cache(parseDirectMessageRumor(rumor))
  if (
    result.recipientDelivery.successfulRelayUrls.length > 0 &&
    result.selfDelivery?.successfulRelayUrls.length
  )
    persistence.removeItem(storageKey(sender, payload.marketCoordinate))
  else
    throw new Error(
      "Participation was sent but its saved recovery copy still needs delivery. Retry the same message."
    )
}
/** Republishes the exact signed ciphertext; no new request or signer prompt. */
export async function retryEventMarketEnrollmentDelivery(
  input: {
    record: EventMarketEnrollmentDelivery
    authenticatedPubkey: string
    shouldContinue?: () => boolean
    signer?: NostrKeySigner
    persistence?: EnrollmentStorage
  },
  dependencies: EnrollmentDeliveryDependencies = defaultDeliveryDependencies
): Promise<void> {
  const record = validateDelivery(input.record)
  const [sender, recipient] = actors(record.payload)
  if (
    sender !== input.authenticatedPubkey ||
    input.shouldContinue?.() === false
  )
    throw new Error("Saved participation belongs to another signer.")
  const signer = input.signer ?? getAccountSigner()
  if (!signer)
    throw new Error("Connect the saved participation sender's signer.")
  const recovered = await dependencies.unwrap(
    new NDKEvent(getNdk(), record.signedSelfWrap),
    signer
  )
  const exact =
    recovered.status === "ok"
      ? parseEventMarketEnrollmentMessage(
          parseDirectMessageRumor(recovered.rumor)
        )
      : null
  if (
    !exact ||
    exact.id !== record.rumorId ||
    Object.keys(record.payload).some(
      (key) =>
        exact[key as keyof EventMarketEnrollmentPayload] !==
        record.payload[key as keyof EventMarketEnrollmentPayload]
    )
  )
    throw new Error(
      "Saved participation does not match its authenticated recovery copy."
    )
  for (const [owner, wrap] of [
    [recipient, record.signedRecipientWrap],
    [sender, record.signedSelfWrap],
  ] as const) {
    const inbox = await dependencies.inbox(owner, {
      requestingAccountPubkey: sender,
      authenticatedPubkey: sender,
      shouldContinue: input.shouldContinue,
    })
    if (inbox.state !== "ready")
      throw new Error(
        "Set up a private-message inbox in Network settings, then retry saved participation."
      )
    const result = await dependencies.publish(wrap, {
      intent: "recipient_event",
      authorPubkey: sender,
      accountPubkey: sender,
      authenticatedPubkey: sender,
      recipientPubkeys: [owner],
      exclusiveRelayUrls: inbox.relayUrls,
      deliveryMode: "critical",
      shouldContinue: input.shouldContinue,
    })
    if (!result.successfulRelayUrls.length)
      throw new Error("Participation still needs a relay acknowledgment.")
  }
  await dependencies.cache(
    parseDirectMessageRumor(
      recovered.status === "ok" ? recovered.rumor : rumorFor(record.payload)
    )
  )
  const persistence = input.persistence ?? storage()
  persistence.removeItem(storageKey(sender, record.payload.marketCoordinate))
}
