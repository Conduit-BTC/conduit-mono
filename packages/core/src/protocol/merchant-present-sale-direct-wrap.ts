import { type NDKSigner } from "@nostr-dev-kit/ndk"

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

function assertDirectAuthorizationEvent(
  event: SignedPublicNostrEvent,
  input: { buyerPubkey: string; merchantPubkey: string }
): void {
  if (
    event.kind !== EVENT_KINDS.ORDER ||
    !isValidSignedPublicNostrEvent(event) ||
    event.pubkey.toLowerCase() !== input.merchantPubkey.toLowerCase() ||
    !exactRecipient(event, input.buyerPubkey)
  ) {
    throw new Error(
      "Direct merchant-present authorization is invalid or belongs to another sale."
    )
  }
}

export interface PrepareMerchantPresentSaleDirectAuthorizationInput {
  authorization: MerchantPresentSaleAuthorizationSchema
  merchantSigner: NDKSigner
}

/**
 * Sign one exact booth authorization for a direct, out-of-band handoff such as
 * a QR code. The event is never published or routed as a private message, and
 * the guest order key is not used to receive or decrypt it.
 */
export async function prepareMerchantPresentSaleDirectAuthorization(
  input: PrepareMerchantPresentSaleDirectAuthorizationInput
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

  const event = buildMerchantPresentSaleAuthorizationRumor(authorization)
  await event.sign(input.merchantSigner)
  const signed = event.rawEvent() as SignedPublicNostrEvent
  assertDirectAuthorizationEvent(signed, authorization)
  return signed
}

export interface ReceiveMerchantPresentSaleDirectAuthorizationInput {
  /** Exact signed event transferred directly; this helper never fetches. */
  event: SignedPublicNostrEvent
  order: OrderSchema
  reviewedCommerceFingerprint: string
  /** Unix seconds. Defaults to the current clock. */
  now?: number
}

/**
 * Verify one explicitly supplied merchant-signed booth authorization. There is
 * no relay read, polling loop, guest-key decryption, or general receive
 * authority in this path.
 */
export function receiveMerchantPresentSaleDirectAuthorization(
  input: ReceiveMerchantPresentSaleDirectAuthorizationInput
): MerchantPresentSaleAuthorizationSchema {
  const order = orderSchema.parse(input.order)
  assertDirectAuthorizationEvent(input.event, {
    buyerPubkey: order.buyerPubkey,
    merchantPubkey: order.merchantPubkey,
  })
  const authorization = parseMerchantPresentSaleAuthorizationRumor(input.event)
  return validateMerchantPresentSaleAuthorization({
    authorization,
    order,
    reviewedCommerceFingerprint: input.reviewedCommerceFingerprint,
    now: input.now,
  })
}
