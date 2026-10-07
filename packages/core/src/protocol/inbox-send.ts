import {
  createPrivateMessageRumor,
  type PrivateMessageEvent,
} from "./private-message-primitives"
import {
  publishPrivateMessage,
  privateMessageCounterparty,
} from "./private-message-delivery"
import {
  getProtectedReadAuthorization,
  assertProtectedReadAuthorization,
} from "./protected-read-authorization"
import { getAccountSigner } from "./session-signer"

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
  dependencies = { getSigner: getAccountSigner, send: publishPrivateMessage }
): Promise<void> {
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
  await dependencies.send({
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
  })
}
