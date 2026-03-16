import {
  db,
  EVENT_KINDS,
  parseOrderMessageRumorEvent,
  fetchEventsFanout,
  requireNdkConnected,
  type ParsedOrderMessage,
} from "@conduit/core"
import { giftUnwrap, NDKEvent, type NDKFilter, type NDKSigner } from "@nostr-dev-kit/ndk"

export type BuyerConversation = {
  id: string
  orderId: string
  merchantPubkey: string
  messages: ParsedOrderMessage[]
  latestAt: number
  latestType: ParsedOrderMessage["type"]
  status: string | null
  totalSummary: string | null
}

function raceTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

async function tryUnwrap(event: NDKEvent, signer: NDKSigner) {
  try {
    return await raceTimeout(
      (async () => {
        try {
          return await giftUnwrap(event, undefined, signer, "nip44")
        } catch {
          // fall through to nip04
        }

        try {
          return await giftUnwrap(event, undefined, signer, "nip04")
        } catch {
          return null
        }
      })(),
      8_000,
      null,
    )
  } catch {
    return null
  }
}

async function unwrapBatch(events: NDKEvent[], signer: NDKSigner, batchSize = 5): Promise<Array<Awaited<ReturnType<typeof tryUnwrap>>>> {
  const results: Array<Awaited<ReturnType<typeof tryUnwrap>>> = []

  for (let index = 0; index < events.length; index += batchSize) {
    const batch = events.slice(index, index + batchSize)
    const batchResults = await Promise.all(batch.map((event) => tryUnwrap(event, signer)))
    results.push(...batchResults)
  }

  return results
}

const knownWrapIds = new Set<string>()

export async function fetchBuyerMessages(buyerPubkey: string): Promise<ParsedOrderMessage[]> {
  const cached = await db.orderMessages
    .where("recipientPubkey").equals(buyerPubkey)
    .or("senderPubkey").equals(buyerPubkey)
    .toArray()

  const cachedById = new Map<string, ParsedOrderMessage>()
  for (const row of cached) {
    try {
      cachedById.set(row.id, JSON.parse(row.rawContent) as ParsedOrderMessage)
    } catch {
      // skip corrupt cache rows
    }
  }

  try {
    const ndk = await requireNdkConnected()
    const signer = ndk.signer
    if (!signer) {
      if (cachedById.size > 0) {
        const result = Array.from(cachedById.values())
        result.sort((a, b) => a.createdAt - b.createdAt)
        return result
      }
      throw new Error("Connect your Nostr signer to view messages.")
    }

    const filter: NDKFilter = {
      kinds: [EVENT_KINDS.GIFT_WRAP],
      "#p": [buyerPubkey],
      limit: 200,
    }

    const wrapped = await fetchEventsFanout(filter, {
      connectTimeoutMs: 4_000,
      fetchTimeoutMs: 12_000,
    }) as NDKEvent[]

    const newWrapped = wrapped.filter((event) => !knownWrapIds.has(event.id))
    const unwrapped = await unwrapBatch(newWrapped, signer)

    const newRows: Array<{
      id: string
      orderId: string
      type: string
      senderPubkey: string
      recipientPubkey: string
      createdAt: number
      rawContent: string
      cachedAt: number
    }> = []

    for (const rumor of unwrapped) {
      if (!rumor || rumor.kind !== EVENT_KINDS.ORDER) continue
      try {
        const parsed = parseOrderMessageRumorEvent(rumor)
        if (!cachedById.has(parsed.id)) {
          newRows.push({
            id: parsed.id,
            orderId: parsed.orderId,
            type: parsed.type,
            senderPubkey: parsed.senderPubkey,
            recipientPubkey: parsed.recipientPubkey,
            createdAt: parsed.createdAt,
            rawContent: JSON.stringify(parsed),
            cachedAt: Date.now(),
          })
        }
        cachedById.set(parsed.id, parsed)
      } catch {
        // ignore malformed order messages
      }
    }

    for (const event of wrapped) knownWrapIds.add(event.id)

    if (newRows.length > 0) {
      await db.orderMessages.bulkPut(newRows)
    }
  } catch (error) {
    if (cachedById.size > 0) {
      const result = Array.from(cachedById.values())
      result.sort((a, b) => a.createdAt - b.createdAt)
      return result
    }
    throw error
  }

  const result = Array.from(cachedById.values())
  result.sort((a, b) => a.createdAt - b.createdAt)
  return result
}

export function buildBuyerConversations(messages: ParsedOrderMessage[], buyerPubkey: string): BuyerConversation[] {
  const grouped = new Map<string, ParsedOrderMessage[]>()

  for (const message of messages) {
    const bucket = grouped.get(message.orderId) ?? []
    bucket.push(message)
    grouped.set(message.orderId, bucket)
  }

  const conversations: BuyerConversation[] = []
  for (const [orderId, bucket] of grouped.entries()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt)
    const latest = bucket[bucket.length - 1]
    if (!latest) continue

    const firstOrder = bucket.find((message) => message.type === "order")
    const latestStatus = [...bucket]
      .reverse()
      .find((message) => message.type === "status_update")

    const otherParticipants = Array.from(
      new Set(
        bucket
          .map((message) =>
            message.senderPubkey === buyerPubkey ? message.recipientPubkey : message.senderPubkey
          )
          .filter(Boolean)
      )
    )

    const merchantPubkey = otherParticipants[0] ?? ""

    conversations.push({
      id: orderId,
      orderId,
      merchantPubkey,
      messages: bucket,
      latestAt: latest.createdAt,
      latestType: latest.type,
      status: latestStatus?.type === "status_update" ? latestStatus.payload.status : null,
      totalSummary:
        firstOrder?.type === "order"
          ? `${firstOrder.payload.subtotal} ${firstOrder.payload.currency}`
          : null,
    })
  }

  conversations.sort((a, b) => b.latestAt - a.latestAt)
  return conversations
}
