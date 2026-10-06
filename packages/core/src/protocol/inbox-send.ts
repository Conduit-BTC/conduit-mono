import { CommerceInboxStore } from "./commerce-inbox-store"
import {
  createPrivateMessageRumor,
  inspectRetainedOwnPrivateMessageRelayReadiness,
  wrapPrivateMessage,
  type PrivateMessageEvent,
} from "./messaging"
import { getProtectedReadAuthorization } from "./protected-read-authorization"
import { getAccountSigner } from "./session-signer"
import {
  resolveInboxDeclaration,
  selectPrivateMessageDeliveryRoute,
} from "./private-message-routing"
import {
  publishWithPlanner,
  RelayPublishDiagnosticsError,
} from "./relay-publish"
import {
  stagePrivateDelivery,
  recordPrivateDelivery,
  holdPrivateDeliveryClaim,
  retryPrivateDeliveries,
  type PrivateDeliveryLeg,
  type PrivateDeliveryJob,
} from "./private-message-delivery"

/** Two-party replies and attachments share exact plans, wraps and delivery. */
export async function sendAccountInboxRumor(input: {
  principal: string
  recipients: string[]
  kind?: 14 | 15 | 16 | 17
  content: string
  tags?: string[][]
  rumor?: PrivateMessageEvent
}): Promise<void> {
  const authorization = getProtectedReadAuthorization(input.principal)
  const signer = getAccountSigner()
  if (!authorization || !signer || signer.pubkey !== input.principal)
    throw new Error("Reconnect your signer to send")
  const store = new CommerceInboxStore(authorization)
  const recipients = [
    ...new Set(input.recipients.map((p) => p.trim().toLowerCase())),
  ]
    .filter((p) => p !== input.principal)
    .sort()
  if (
    recipients.length !== 1 ||
    recipients.some((p) => !/^[0-9a-f]{64}$/.test(p))
  )
    throw new Error("Invalid conversation participants")
  if (!input.content.trim() || input.content.length > 32_768)
    throw new Error("Message is outside the supported range")
  const own = await inspectRetainedOwnPrivateMessageRelayReadiness(
    input.principal
  )
  store.assertCurrent()
  if (own.state !== "ready")
    throw new Error("Set up your inbox in Network before sending")
  const rumor = createPrivateMessageRumor({
    ...(input.rumor ?? {}),
    pubkey: input.principal,
    kind: input.rumor?.kind ?? input.kind ?? 14,
    created_at: input.rumor?.created_at ?? Math.floor(Date.now() / 1000),
    tags: [
      ...recipients.map((p) => ["p", p]),
      ...(input.rumor?.tags ?? input.tags ?? []).filter(
        (tag) => tag[0] !== "p"
      ),
    ],
    content: input.content,
  })
  if (input.rumor?.id && rumor.id !== input.rumor.id)
    throw new Error("Conversation rumor changed")
  const saved = await store.database.commerceInboxDeliveries.get(
    store.key(`delivery:${rumor.id}`)
  )
  if (saved) {
    await retryPrivateDeliveries(
      input.principal,
      publishWithPlanner,
      `delivery:${rumor.id}`,
      store
    )
    const current = await store.database.commerceInboxDeliveries.get(saved.id)
    store.assertCurrent()
    const job =
      current &&
      (await store.open<PrivateDeliveryJob>(
        current.value,
        `delivery:${rumor.id}`
      ))
    if (
      !job ||
      job.legs.some(
        (leg) =>
          recipients.includes(leg.recipientPubkey) && !leg.acknowledged.length
      )
    )
      throw new Error(
        "Saved message is still waiting for participant relay acceptance"
      )
    return
  }
  const legs: PrivateDeliveryLeg[] = []
  for (const recipientPubkey of [...recipients, input.principal]) {
    const declaration = await resolveInboxDeclaration(recipientPubkey, {
      requestingAccountPubkey: input.principal,
      authenticatedPubkey: input.principal,
      allowLocalRelayUrlsForPubkey: input.principal,
      shouldContinue: () => {
        store.assertCurrent()
        return true
      },
    })
    store.assertCurrent()
    const route = selectPrivateMessageDeliveryRoute({
      rumorKind: 14,
      declaration,
      validatedOrder: false,
      authenticatedOwnerPubkey: input.principal,
      ownerSelectedRelayUrls:
        recipientPubkey === input.principal ? own.relayUrls : [],
    })
    if (route.route === "blocked")
      throw new Error("A participant has no usable declared inbox")
    legs.push({
      recipientPubkey,
      event: await wrapPrivateMessage(
        rumor as PrivateMessageEvent,
        { pubkey: recipientPubkey },
        signer
      ),
      relayUrls: [...route.relayUrls],
      ownerSelectedRelayUrls: [...route.ownerSelectedRelayUrls],
      compatibility: false,
      acknowledged: [],
      failed: [],
    })
  }
  // All encrypted legs and authorized targets exist before the first write.
  const id = await stagePrivateDelivery(store, {
    senderPubkey: input.principal,
    rumorId: rumor.id,
    legs,
    createdAt: Date.now(),
  })
  let incomplete = false
  const claim = await holdPrivateDeliveryClaim(store, id)
  try {
    for (const leg of legs) {
      claim.assertCurrent()
      let result
      try {
        result = await publishWithPlanner(leg.event, {
          intent: "recipient_event",
          authorPubkey: input.principal,
          accountPubkey: input.principal,
          authenticatedPubkey: input.principal,
          recipientPubkeys: [leg.recipientPubkey],
          exclusiveRelayUrls: leg.relayUrls,
          ownerSelectedRelayUrls: leg.ownerSelectedRelayUrls,
          independentRelayUrls: leg.relayUrls,
          deliveryMode: "critical",
          shouldContinue: () => {
            claim.assertCurrent()
            return true
          },
        })
      } catch (error) {
        if (error instanceof RelayPublishDiagnosticsError)
          result = error.diagnostics
        else {
          await recordPrivateDelivery(store, id, leg.event.id, null, {
            holdClaim: true,
          })
          throw error
        }
      }
      await recordPrivateDelivery(store, id, leg.event.id, result, {
        holdClaim: true,
      })
      if (
        !result?.successfulRelayUrls.length &&
        leg.recipientPubkey !== input.principal
      )
        incomplete = true
      if (leg.recipientPubkey === input.principal)
        await store.receive(leg.event)
    }
  } finally {
    await claim.release()
  }
  if (incomplete)
    throw new Error(
      "Message saved for retry; some participants have no relay acceptance yet"
    )
}
