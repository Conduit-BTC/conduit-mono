import { z } from "zod"
import { isValidSignedPublicNostrEvent } from "./signed-event"

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const signedWrapSchema = z
  .object({
    id: hash,
    pubkey: hash,
    created_at: z.number().int().safe().nonnegative(),
    kind: z.literal(1059),
    tags: z.array(z.array(z.string().max(4096)).max(8)).max(8),
    content: z.string().max(256 * 1024),
    sig: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict()
  .refine(isValidSignedPublicNostrEvent)
const schema = z
  .object({
    schemaVersion: z.literal(1),
    handoffId: hash,
    rumorId: hash,
    orderId: z.string().min(1).max(512),
    purchaseScope: hash,
    purchaseClaimDigest: hash,
    senderPubkey: hash,
    merchantPubkey: hash,
    organizerPubkey: hash,
    buyerIdentityKind: z.enum(["signed_in", "guest_ephemeral"]),
    createdAt: z.number().int().safe().nonnegative(),
    wrappedToRecipient: signedWrapSchema,
    merchantDelivered: z.boolean(),
    acknowledged: z.boolean(),
  })
  .strict()
export type EventMarketFreePurchaseDelivery = z.infer<typeof schema>

export function parseEventMarketFreePurchaseDelivery(
  value: unknown
): EventMarketFreePurchaseDelivery {
  const row = schema.parse(value)
  const recipients = row.wrappedToRecipient.tags.filter((tag) => tag[0] === "p")
  if (
    row.wrappedToRecipient.kind !== 1059 ||
    recipients.length !== 1 ||
    recipients[0]?.length !== 2 ||
    recipients[0]?.[1] !== row.organizerPubkey ||
    row.merchantPubkey === row.organizerPubkey ||
    (row.acknowledged && !row.merchantDelivered)
  )
    throw new Error("Saved free pickup delivery is invalid.")
  return row
}
