import {
  giftWrap,
  NDKEvent,
  NDKUser,
  type NDKEncryptionScheme,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import {
  merchantPresentSaleAuthorizationSchema,
  orderSchema,
  type MerchantPresentSaleAuthorizationSchema,
  type OrderSchema,
} from "../schemas"
import { EVENT_KINDS } from "./kinds"
import {
  buildMerchantPresentSaleAuthorizationRumor,
  parseMerchantPresentSaleAuthorizationRumor,
  validateMerchantPresentSaleAuthorization,
} from "./merchant-present-sale"
import { unwrapGiftWrap, type GiftUnwrapFn } from "./messaging"
import { getNdk } from "./ndk"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

function exactRecipient(
  event: Pick<SignedPublicNostrEvent, "tags">,
  buyerPubkey: string
): boolean {
  const recipients = event.tags.filter(
    (tag) => tag[0] === "p" && typeof tag[1] === "string"
  )
  return (
    recipients.length === 1 &&
    recipients[0]![1]!.toLowerCase() === buyerPubkey.toLowerCase()
  )
}

function assertDirectAuthorizationWrap(
  event: SignedPublicNostrEvent,
  buyerPubkey: string
): void {
  if (
    event.kind !== EVENT_KINDS.GIFT_WRAP ||
    !isValidSignedPublicNostrEvent(event) ||
    !exactRecipient(event, buyerPubkey)
  ) {
    throw new Error(
      "Direct merchant-present authorization wrap is invalid or belongs to another buyer."
    )
  }
}

export interface PrepareMerchantPresentSaleDirectWrapInput {
  authorization: MerchantPresentSaleAuthorizationSchema
  merchantSigner: NDKSigner
  /** Focused construction seam; production uses NDK's NIP-17/NIP-59 helper. */
  giftWrapFn?: typeof giftWrap
}

/**
 * Prepare one signed NIP-59 wrap for an out-of-band transfer such as a QR.
 * This function performs no relay discovery, inbox polling, persistence, or
 * publication and does not create a sender self-copy.
 */
export async function prepareMerchantPresentSaleDirectWrap(
  input: PrepareMerchantPresentSaleDirectWrapInput
): Promise<SignedPublicNostrEvent> {
  const authorization = merchantPresentSaleAuthorizationSchema.parse(
    input.authorization
  )
  const signerPubkey = (await input.merchantSigner.user()).pubkey.toLowerCase()
  if (signerPubkey !== authorization.merchantPubkey.toLowerCase()) {
    throw new Error(
      "Direct merchant-present authorization signer is not the order merchant."
    )
  }
  const rumor = buildMerchantPresentSaleAuthorizationRumor(authorization)
  rumor.ndk ??= getNdk()
  const wrapped = await (input.giftWrapFn ?? giftWrap)(
    rumor,
    new NDKUser({ pubkey: authorization.buyerPubkey }),
    input.merchantSigner,
    { rumorKind: EVENT_KINDS.ORDER }
  )
  const signed = wrapped.rawEvent() as SignedPublicNostrEvent
  assertDirectAuthorizationWrap(signed, authorization.buyerPubkey)
  return signed
}

export type MerchantPresentSaleDirectDecrypt = (
  sender: NDKUser,
  value: string,
  scheme?: NDKEncryptionScheme
) => Promise<string>

function createExactDirectWrapDecryptSigner(input: {
  wrap: SignedPublicNostrEvent
  buyerPubkey: string
  merchantPubkey: string
  decrypt: MerchantPresentSaleDirectDecrypt
}): NDKSigner {
  const buyerPubkey = input.buyerPubkey.toLowerCase()
  const merchantPubkey = input.merchantPubkey.toLowerCase()
  const buyer = new NDKUser({ pubkey: buyerPubkey })
  let phase: "outer" | "seal" | "spent" = "outer"
  let sealCiphertext: string | null = null

  const reject = (): never => {
    throw new Error(
      "Guest decrypt capability is limited to one merchant-present authorization wrap."
    )
  }

  return {
    pubkey: buyerPubkey,
    blockUntilReady: async () => buyer,
    user: async () => buyer,
    userSync: buyer,
    sign: async () => reject(),
    encryptionEnabled: async (scheme) =>
      !scheme || scheme === "nip44" ? ["nip44"] : [],
    encrypt: async () => reject(),
    decrypt: async (sender, value, scheme) => {
      if (scheme !== "nip44") return reject()
      if (phase === "outer") {
        if (
          sender.pubkey.toLowerCase() !== input.wrap.pubkey.toLowerCase() ||
          value !== input.wrap.content
        ) {
          return reject()
        }
        const sealJson = await input.decrypt(sender, value, scheme)
        let seal: unknown
        try {
          seal = JSON.parse(sealJson)
        } catch {
          return reject()
        }
        if (
          !seal ||
          typeof seal !== "object" ||
          Array.isArray(seal) ||
          (seal as { kind?: unknown }).kind !== EVENT_KINDS.SEAL ||
          typeof (seal as { pubkey?: unknown }).pubkey !== "string" ||
          (seal as { pubkey: string }).pubkey.toLowerCase() !==
            merchantPubkey ||
          typeof (seal as { content?: unknown }).content !== "string"
        ) {
          return reject()
        }
        sealCiphertext = (seal as { content: string }).content
        phase = "seal"
        return sealJson
      }
      if (
        phase !== "seal" ||
        sender.pubkey.toLowerCase() !== merchantPubkey ||
        value !== sealCiphertext
      ) {
        return reject()
      }
      phase = "spent"
      return input.decrypt(sender, value, scheme)
    },
    toPayload: () => reject(),
  }
}

export interface ReceiveMerchantPresentSaleDirectWrapInput {
  /** Exact signed outer event transferred directly; this helper never fetches. */
  wrap: SignedPublicNostrEvent
  order: OrderSchema
  reviewedCommerceFingerprint: string
  /** Bound access to the guest's ephemeral key; callers must not expose it. */
  decrypt: MerchantPresentSaleDirectDecrypt
  /** Unix seconds. Defaults to the current clock. */
  now?: number
  timeoutMs?: number
  /** Focused test seam; production uses NDK's verified NIP-59 unwrap. */
  giftUnwrap?: GiftUnwrapFn
}

/**
 * Decrypt one explicitly supplied wrap and accept only the exact booth-order
 * capability. There is no relay read, polling loop, signing, encryption, or
 * general message receive authority in this path.
 */
export async function receiveMerchantPresentSaleDirectWrap(
  input: ReceiveMerchantPresentSaleDirectWrapInput
): Promise<MerchantPresentSaleAuthorizationSchema> {
  const order = orderSchema.parse(input.order)
  assertDirectAuthorizationWrap(input.wrap, order.buyerPubkey)
  const event = new NDKEvent(undefined, input.wrap)
  const decryptSigner = createExactDirectWrapDecryptSigner({
    wrap: input.wrap,
    buyerPubkey: order.buyerPubkey.toLowerCase(),
    merchantPubkey: order.merchantPubkey.toLowerCase(),
    decrypt: input.decrypt,
  })
  const outcome = await unwrapGiftWrap(event, decryptSigner, {
    timeoutMs: input.timeoutMs,
    giftUnwrap: input.giftUnwrap,
  })
  if (outcome.status !== "ok") {
    throw new Error(
      outcome.status === "decrypt_failed"
        ? `Direct merchant-present authorization could not be decrypted (${outcome.reason}).`
        : "Direct wrap did not contain a merchant-present authorization."
    )
  }
  const authorization = parseMerchantPresentSaleAuthorizationRumor(
    outcome.rumor
  )
  return validateMerchantPresentSaleAuthorization({
    authorization,
    order,
    reviewedCommerceFingerprint: input.reviewedCommerceFingerprint,
    now: input.now,
  })
}
