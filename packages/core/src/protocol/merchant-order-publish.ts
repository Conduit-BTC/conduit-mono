import { getEventHash } from "nostr-tools"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { type PrivateMessageEvent } from "./messaging"
import type { CommerceInboxStore } from "./commerce-inbox-store"
import { cacheParsedOrderMessage } from "./commerce"
import { getCommerceInbox, type CommerceInbox } from "./commerce-inbox"
import { EVENT_KINDS } from "./kinds"
import {
  cacheAcceptedDirectMessageRumor,
  createAcceptedInboxSendCheckpoint,
  type AccountInboxSendResult,
} from "./inbox-send"
import { getAccountSigner } from "./session-signer"
import { appendConduitClientTag } from "./nip89"
import { parseOrderMessageRumorEvent, type ParsedOrderMessage } from "./orders"
import {
  createValidatedOrderRouteScope,
  publishPrivateMessage,
} from "./messaging"
import type { PrivateMessageDeliveryRoute } from "./private-message-routing"
import {
  decodeConduitCommerceExtension,
  encodeOpenMarketsMerchantReply,
} from "./commerce-wire"
import {
  hasConflictingOpenMarketsOrders,
  openMarketsLocalOrderId,
} from "./open-markets-orders"

export type MerchantOrderDelivery = "buyer_and_self" | "self_only"

export interface PublishMerchantOrderMessageInput {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  type:
    | "payment_request"
    | "status_update"
    | "shipping_update"
    | "receipt"
    | "message"
  payload: Record<string, unknown>
  tags?: string[][]
  delivery: MerchantOrderDelivery
  /** Active authenticated account; never inferred from merchantPubkey. */
  authenticatedPubkey?: string | null
  /** Live account session authority for declaration reads and relay writes. */
  shouldContinue?: () => boolean
  /** Durable caller fence before immutable recipient staging or recovery. */
  onRecipientDeliveryStarting?: () => void | Promise<void>
  /** Background automation skips foreground-only interactive coordination. */
  signerInteraction?: "external" | "background_external"
  /** Local replay binding after independent exact invoice settlement verification. */
  paidInvoiceConfirmation?: { invoice: string; amountMsats: number }
  /** The durable inventory decision fixes the accepted notification's identity. */
  inventoryAcceptanceAt?: number
}

type PreparedMerchantOrderMessageInput = PublishMerchantOrderMessageInput & {
  /** Derived only from a retained, authenticated inbound order. */
  wireOrderId?: string
  commerceExtensionVersion?: 1 | 2
}

export function getMerchantOrderDeliveryRecipients(
  input: Pick<
    PublishMerchantOrderMessageInput,
    "merchantPubkey" | "buyerPubkey" | "delivery"
  >
): string[] {
  return input.delivery === "self_only"
    ? [input.merchantPubkey]
    : [input.buyerPubkey, input.merchantPubkey]
}

export function buildMerchantOrderRumorTags(
  input: Pick<
    PublishMerchantOrderMessageInput,
    "buyerPubkey" | "orderId" | "type" | "tags"
  >
): string[][] {
  return appendConduitClientTag(
    [
      ["p", input.buyerPubkey],
      ["type", input.type],
      ["order", input.orderId],
      ...(input.tags ?? []),
    ],
    "merchant"
  )
}

export async function cachePublishedMerchantOrderMessage(
  message: ParsedOrderMessage,
  owner: CommerceInbox,
  cacheMessage: typeof cacheParsedOrderMessage = cacheParsedOrderMessage
): Promise<boolean> {
  try {
    await cacheMessage(message, owner)
    return true
  } catch {
    console.warn("Published merchant order message could not be cached locally")
    return false
  }
}

function prepareMerchantRumor(
  rumor: PrivateMessageEvent,
  merchantPubkey: string
): void {
  rumor.pubkey = merchantPubkey
  if (!rumor.id)
    rumor.id = getEventHash({
      ...rumor,
      kind: rumor.kind!,
      created_at: rumor.created_at!,
    })
}

export interface PublishMerchantOrderMessageResult extends AccountInboxSendResult {
  /** Lane used for the critical recipient leg (route-lane provenance). */
  deliveryRoute: Exclude<PrivateMessageDeliveryRoute, "blocked">
}

export function getMerchantOrderPublishTarget(
  input: Pick<
    PublishMerchantOrderMessageInput,
    "merchantPubkey" | "buyerPubkey" | "orderId" | "delivery"
  >,
  rumor: PrivateMessageEvent
) {
  const recipientPubkey =
    input.delivery === "self_only" ? input.merchantPubkey : input.buyerPubkey
  return {
    recipientPubkey,
    selfCopy: input.delivery === "buyer_and_self",
    validatedOrderScope:
      rumor.kind === 16
        ? createValidatedOrderRouteScope({
            rumor,
            orderId: input.orderId,
            senderPubkey: input.merchantPubkey,
            recipientPubkey,
            rumorRecipientPubkey: input.buyerPubkey,
          })
        : undefined,
  }
}

function buildMerchantOrderRumor(
  input: PreparedMerchantOrderMessageInput,
  createdAt = input.inventoryAcceptanceAt ?? Date.now()
): PrivateMessageEvent {
  if (
    input.inventoryAcceptanceAt !== undefined &&
    (!Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      input.type !== "status_update" ||
      input.payload.status !== "accepted" ||
      !input.tags?.some((tag) => tag[0] === "status" && tag[1] === "accepted"))
  )
    throw new Error("Invalid inventory acceptance notification")
  let rumor = {
    id: "",
    pubkey: input.merchantPubkey,
    kind: EVENT_KINDS.ORDER,
    created_at: Math.floor(createdAt / 1000),
    tags: buildMerchantOrderRumorTags(input),
    content: JSON.stringify({
      ...input.payload,
      orderId: input.orderId,
      merchantPubkey: input.merchantPubkey,
      buyerPubkey: input.buyerPubkey,
      createdAt,
    }),
  } as PrivateMessageEvent
  if (input.wireOrderId)
    rumor = encodeOpenMarketsMerchantReply(
      rumor,
      input.wireOrderId,
      input.commerceExtensionVersion ?? 1
    )
  prepareMerchantRumor(rumor, input.merchantPubkey)
  return rumor
}

function paidConfirmationIdentity(input: PreparedMerchantOrderMessageInput) {
  const confirmation = input.paidInvoiceConfirmation!
  const intent = [
    input.merchantPubkey,
    input.buyerPubkey,
    input.orderId,
    confirmation.invoice.trim().toLowerCase(),
    confirmation.amountMsats,
  ]
  return {
    intent,
    logicalId: `merchant-paid-confirmation:${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(intent))))}`,
  }
}

/** Preserve one logical confirmation; the transport owner still stages/replays wraps. */
async function getPaidInvoiceConfirmationRumor(
  input: PreparedMerchantOrderMessageInput,
  store: CommerceInboxStore,
  assertCurrent: () => void
): Promise<PrivateMessageEvent> {
  const confirmation = input.paidInvoiceConfirmation!
  const invoice = confirmation.invoice.trim().toLowerCase()
  if (
    input.type !== "status_update" ||
    input.payload.status !== "paid" ||
    !input.tags?.some((tag) => tag[0] === "status" && tag[1] === "paid") ||
    !/^[0-9a-f]{64}$/.test(input.buyerPubkey) ||
    !input.orderId.trim() ||
    input.orderId.length > 128 ||
    !invoice ||
    invoice.length > 32_768 ||
    !Number.isSafeInteger(confirmation.amountMsats) ||
    confirmation.amountMsats <= 0
  )
    throw new Error("Invalid paid invoice confirmation intent")
  const { intent, logicalId } = paidConfirmationIdentity(input)
  assertCurrent()
  let row = await store.database.commerceInboxDeliveries.get(
    store.key(logicalId)
  )
  assertCurrent()
  if (!row) {
    const value = await store.seal(
      {
        version: 1,
        intent,
        delivery: input.delivery,
        rumor: buildMerchantOrderRumor(input),
      },
      logicalId
    )
    assertCurrent()
    row = await store.database.transaction(
      "rw",
      store.database.commerceInboxDeliveries,
      async () => {
        assertCurrent()
        const id = store.key(logicalId)
        const current = await store.database.commerceInboxDeliveries.get(id)
        if (current) return current
        const selected = {
          id,
          accountPubkey: store.principal,
          kind: "merchant_paid_confirmation" as const,
          value,
          updatedAt: Date.now(),
        }
        await store.database.commerceInboxDeliveries.add(selected)
        assertCurrent()
        return selected
      }
    )
  }
  assertCurrent()
  if (
    row.kind !== "merchant_paid_confirmation" ||
    row.accountPubkey !== store.principal
  )
    throw new Error("Saved paid confirmation binding changed")
  const saved = await store
    .open<{
      version: number
      intent: unknown
      delivery: MerchantOrderDelivery
      rumor: PrivateMessageEvent
    }>(row.value, logicalId)
    .catch(() => {
      assertCurrent()
      throw new Error("Saved paid confirmation binding changed")
    })
  assertCurrent()
  try {
    const rumor = saved.rumor
    const payload = JSON.parse(decodeConduitCommerceExtension(rumor).content)
    const expected = buildMerchantOrderRumor(input, payload.createdAt)
    if (
      saved.version !== 1 ||
      JSON.stringify(saved.intent) !== JSON.stringify(intent) ||
      saved.delivery !== input.delivery ||
      rumor.pubkey !== input.merchantPubkey ||
      rumor.kind !== EVENT_KINDS.ORDER ||
      !Number.isSafeInteger(rumor.created_at) ||
      !Number.isSafeInteger(payload.createdAt) ||
      payload.createdAt < 0 ||
      rumor.created_at !== Math.floor(payload.createdAt / 1000) ||
      JSON.stringify(rumor.tags) !== JSON.stringify(expected.tags) ||
      rumor.id !==
        getEventHash({ ...rumor, kind: 16, created_at: rumor.created_at! }) ||
      rumor.content !== expected.content
    )
      throw new Error("Invalid checkpoint")
    return rumor
  } catch {
    // Never replace an unreadable/conflicting operation with a fresh timestamp.
    throw new Error("Saved paid confirmation binding changed")
  }
}

export async function publishMerchantOrderMessage(
  input: PublishMerchantOrderMessageInput
): Promise<PublishMerchantOrderMessageResult> {
  const signer = getAccountSigner()
  if (!signer) throw new Error("Signer not connected")
  let accountOwner: CommerceInbox | null = null
  try {
    accountOwner = getCommerceInbox(input.merchantPubkey)
  } catch {
    // Recipient delivery remains available; local history is reported after ACK.
  }

  let prepared: PreparedMerchantOrderMessageInput = {
    ...input,
    wireOrderId: undefined,
  }
  let retainedNamedOrder = false
  if (accountOwner && input.orderId.startsWith("open-markets:")) {
    await accountOwner.initialize()
    if (
      input.type !== "message" &&
      hasConflictingOpenMarketsOrders(
        accountOwner
          .getSnapshot()
          .orderMessages.filter((message) => message.orderId === input.orderId)
      )
    )
      throw new Error("Conflicting order terms require review")
    const order = accountOwner
      .getSnapshot()
      .orderMessages.find(
        (message) =>
          message.type === "order" &&
          message.orderId === input.orderId &&
          message.senderPubkey === input.buyerPubkey &&
          message.recipientPubkey === input.merchantPubkey
      )
    retainedNamedOrder =
      order?.type === "order" && order.wireFormat !== "open_markets"
    if (
      order?.wireFormat === "open_markets" &&
      order.wireOrderId &&
      openMarketsLocalOrderId(
        order.wireOrderId,
        input.buyerPubkey,
        input.merchantPubkey
      ) === input.orderId
    ) {
      prepared = {
        ...input,
        wireOrderId: order.wireOrderId,
        commerceExtensionVersion: order.commerceExtensionVersion,
      }
      const distinctNamedOrder = accountOwner
        .getSnapshot()
        .orderMessages.some(
          (message) =>
            message.type === "order" &&
            message.wireFormat !== "open_markets" &&
            message.orderId === order.wireOrderId &&
            message.senderPubkey === input.buyerPubkey &&
            message.recipientPubkey === input.merchantPubkey
        )
      if (order.conduitExtension && !distinctNamedOrder) {
        accountOwner.store.assertCurrent()
        const legacy = {
          ...input,
          orderId: order.wireOrderId,
          wireOrderId: undefined,
        }
        const pending =
          await accountOwner.store.database.merchantPendingInvoices.get(
            `${input.merchantPubkey}:${order.wireOrderId}`
          )
        const confirmation = input.paidInvoiceConfirmation
          ? await accountOwner.store.database.commerceInboxDeliveries.get(
              accountOwner.store.key(paidConfirmationIdentity(legacy).logicalId)
            )
          : undefined
        accountOwner.store.assertCurrent()
        const namedHistory = accountOwner
          .getSnapshot()
          .orderMessages.some(
            (message) =>
              message.orderId === input.orderId &&
              message.legacyNumericOrder &&
              message.senderPubkey === input.merchantPubkey &&
              message.recipientPubkey === input.buyerPubkey
          )
        if (
          namedHistory ||
          (pending?.orderId === order.wireOrderId &&
            pending.merchantPubkey === input.merchantPubkey &&
            pending.buyerPubkey === input.buyerPubkey) ||
          (confirmation?.kind === "merchant_paid_confirmation" &&
            confirmation.accountPubkey === input.merchantPubkey)
        ) {
          prepared = legacy
          retainedNamedOrder = true
        }
      }
    }
  }
  if (
    input.orderId.startsWith("open-markets:") &&
    !prepared.wireOrderId &&
    !retainedNamedOrder
  )
    throw new Error("Compatible order history is unavailable")

  const assertConfirmationAuthority = () => {
    if (
      !accountOwner ||
      signer.pubkey !== input.merchantPubkey ||
      input.authenticatedPubkey !== input.merchantPubkey ||
      getAccountSigner() !== signer ||
      input.shouldContinue?.() === false
    )
      throw new Error("Paid confirmation account session changed")
    accountOwner.store.assertCurrent()
  }
  let rumor: PrivateMessageEvent
  if (input.paidInvoiceConfirmation) {
    assertConfirmationAuthority()
    rumor = await getPaidInvoiceConfirmationRumor(
      prepared,
      accountOwner!.store,
      assertConfirmationAuthority
    )
  } else rumor = buildMerchantOrderRumor(prepared)
  const parsed = rumor.kind === 14 ? null : parseOrderMessageRumorEvent(rumor)
  const checkpoint = createAcceptedInboxSendCheckpoint(async () => {
    if (!accountOwner) throw new Error("Local order history unavailable")
    if (parsed) {
      if (!(await cachePublishedMerchantOrderMessage(parsed, accountOwner)))
        throw new Error("Local order history unavailable")
    } else {
      await cacheAcceptedDirectMessageRumor(rumor, accountOwner)
    }
  })

  const target = getMerchantOrderPublishTarget(prepared, rumor)
  const sent = await publishPrivateMessage({
    rumor,
    senderPubkey: input.merchantPubkey,
    accountPubkey: input.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.paidInvoiceConfirmation
      ? () => {
          assertConfirmationAuthority()
          return true
        }
      : input.shouldContinue,
    recipientPubkey: target.recipientPubkey,
    signer,
    rumorKind: rumor.kind === 14 ? 14 : 16,
    selfCopy: target.selfCopy,
    deliveryStore: accountOwner?.store,
    signerInteraction: input.signerInteraction ?? "background_external",
    onRecipientAccepted: checkpoint.onRecipientAccepted,
    onRecipientDeliveryStarting: input.onRecipientDeliveryStarting,
    // Merchant replies, invoices, and proofs belong to a validated inbound
    // order lifecycle, so they qualify for compatibility routing (CND-208).
    validatedOrderScope: target.validatedOrderScope,
    telemetryApp: "merchant",
  })
  if (sent.selfCopyError) {
    console.warn("Merchant order self-copy publish failed")
  }

  return {
    ...(await checkpoint.complete(sent, target.selfCopy)),
    deliveryRoute: sent.deliveryRoute,
  }
}
