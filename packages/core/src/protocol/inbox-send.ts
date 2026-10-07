import {
  createPrivateMessageRumor,
  type PrivateMessageEvent,
} from "./private-message-primitives"
import {
  publishPrivateMessage,
  privateMessageCounterparty,
} from "./private-message-delivery"
import {
  CommerceInboxStore,
  projectDirectOrFileRumor,
} from "./commerce-inbox-store"
import {
  getProtectedReadAuthorization,
  assertProtectedReadAuthorization,
} from "./protected-read-authorization"
import { getAccountSigner } from "./session-signer"

export interface AccountInboxSendResult {
  recipient: "accepted"
  selfCopy: "complete" | "partial" | "pending"
  localHistory: "saved" | "unavailable"
  /** A local post-ACK checkpoint failed; never retry the semantic send. */
  checkpointFailure?: true
}

interface AccountInboxSendDependencies {
  getSigner: typeof getAccountSigner
  send: typeof publishPrivateMessage
  persistProjection?: (
    projection: ReturnType<typeof projectDirectOrFileRumor>
  ) => Promise<void>
}

/** Conversation payload adapter; delivery, staging and replay have one core owner. */
export async function sendAccountInboxRumor(
  input: {
    principal: string
    recipients: string[]
    kind?: 14 | 15 | 16 | 17
    content: string
    tags?: string[][]
    rumor?: PrivateMessageEvent
  },
  dependencies: AccountInboxSendDependencies = {
    getSigner: getAccountSigner,
    send: publishPrivateMessage,
  }
): Promise<AccountInboxSendResult> {
  const signer = dependencies.getSigner()
  const authorization = getProtectedReadAuthorization(input.principal)
  if (!authorization || !signer || signer.pubkey !== input.principal)
    throw new Error("Reconnect your signer to send")
  const recipient = privateMessageCounterparty(
    input.principal,
    input.recipients
  )
  if (!input.content.trim() || input.content.length > 32_768)
    throw new Error("Message is outside the supported range")
  const rumor = createPrivateMessageRumor({
    pubkey: input.principal,
    kind: input.rumor?.kind ?? input.kind ?? 14,
    created_at: input.rumor?.created_at ?? Math.floor(Date.now() / 1000),
    tags: [
      ["p", recipient],
      ...(input.rumor?.tags ?? input.tags ?? []).filter(
        (tag) => tag[0] !== "p"
      ),
    ],
    content: input.content,
  })
  if (input.rumor?.id && rumor.id !== input.rumor.id)
    throw new Error("Conversation rumor changed")
  const projection =
    rumor.kind === 14 || rumor.kind === 15
      ? projectDirectOrFileRumor(rumor, input.principal)
      : null
  let localHistory: AccountInboxSendResult["localHistory"] = "unavailable"
  let persistAttempted = false
  const persistAcceptedProjection = async () => {
    persistAttempted = true
    if (!projection) return
    try {
      assertProtectedReadAuthorization(authorization, input.principal)
      if (dependencies.persistProjection)
        await dependencies.persistProjection(projection)
      else
        await new CommerceInboxStore(authorization).putProjection(projection, 1)
      assertProtectedReadAuthorization(authorization, input.principal)
      localHistory = "saved"
    } catch {
      // Return an explicit unavailable result without undoing recipient acceptance.
    }
  }
  const sent = await dependencies.send({
    rumor,
    senderPubkey: input.principal,
    recipientPubkey: recipient,
    accountPubkey: input.principal,
    authenticatedPubkey: input.principal,
    signer,
    rumorKind: rumor.kind as 14 | 15 | 16 | 17,
    shouldContinue: () => {
      assertProtectedReadAuthorization(authorization, input.principal)
      return true
    },
    onRecipientAccepted: persistAcceptedProjection,
  })
  // An exact saved-delivery resume can return before the callback is reached.
  if (!persistAttempted) await persistAcceptedProjection()
  return {
    recipient: "accepted",
    selfCopy:
      sent.selfDeliveryStatus === "partial_success"
        ? "partial"
        : sent.selfDeliveryStatus === "full_success" && !sent.selfCopyError
          ? "complete"
          : "pending",
    localHistory,
    ...(sent.checkpointFailure || localHistory === "unavailable"
      ? { checkpointFailure: true as const }
      : {}),
  }
}
