import {
  db,
  type LocalProductStockCheckpoint,
  type ProductListingDeliveryJob,
} from "../db"
import { withLocalProductCoordinateLocks } from "./local-product-coordinate-lock"
import { isValidSignedPublicNostrEvent } from "./signed-event"
import type { SignedPublicNostrEvent } from "./signed-event"

export interface LocalProductStockRecovery {
  checkpoint: LocalProductStockCheckpoint
  signedEvent: SignedPublicNostrEvent
  listingJob: ProductListingDeliveryJob
}

function matchesExactStock(
  row: LocalProductStockRecovery,
  input: {
    merchantPubkey: string
    orderId: string
    addressId: string
    signedEventId: string
  }
): boolean {
  return (
    row.checkpoint.merchantPubkey === input.merchantPubkey &&
    row.checkpoint.orderId === input.orderId &&
    row.checkpoint.productAddressId === input.addressId &&
    row.checkpoint.signedEventId === input.signedEventId &&
    row.signedEvent.id === input.signedEventId
  )
}

/** Read exact committed bytes; an orphaned checkpoint is not a retry grant. */
export async function getLocalProductStockRecoveryForOrder(
  merchantPubkey: string,
  orderId: string
): Promise<LocalProductStockRecovery[]> {
  return db.transaction(
    "r",
    db.localProductStockCheckpoints,
    db.productListingOutbox,
    async () => {
      const checkpoints = await db.localProductStockCheckpoints
        .where("orderId")
        .equals(orderId)
        .filter((row) => row.merchantPubkey === merchantPubkey)
        .toArray()
      const recovered: LocalProductStockRecovery[] = []
      for (const checkpoint of checkpoints) {
        const listingJob = await db.productListingOutbox.get(
          `product-listing:${checkpoint.signedEventId}`
        )
        const signedEvent = listingJob?.signedEvents[0]
        if (
          !listingJob ||
          listingJob.signedEvents.length !== 1 ||
          !signedEvent ||
          !isValidSignedPublicNostrEvent(signedEvent) ||
          signedEvent.id !== checkpoint.signedEventId ||
          signedEvent.pubkey !== merchantPubkey ||
          listingJob.merchantPubkey !== merchantPubkey
        ) {
          throw new Error("Signed stock recovery evidence is incomplete")
        }
        recovered.push({ checkpoint, signedEvent, listingJob })
      }
      return recovered.sort(
        (left, right) =>
          right.checkpoint.committedAt - left.checkpoint.committedAt ||
          right.signedEvent.created_at - left.signedEvent.created_at ||
          left.checkpoint.signedEventId.localeCompare(
            right.checkpoint.signedEventId
          )
      )
    }
  )
}

/** Retry only the exact pending event committed with the stock decision. */
export async function confirmLocalProductStockRecovery(input: {
  merchantPubkey: string
  orderId: string
  addressId: string
  signedEventId: string
}): Promise<LocalProductStockRecovery> {
  return withLocalProductCoordinateLocks([input.addressId], async () => {
    const rows = await getLocalProductStockRecoveryForOrder(
      input.merchantPubkey,
      input.orderId
    )
    const row = rows.find((candidate) => matchesExactStock(candidate, input))
    if (
      !row ||
      row.checkpoint.state !== "pending" ||
      rows.some(
        (candidate) =>
          candidate.checkpoint.productAddressId === input.addressId &&
          candidate.checkpoint.state === "applied"
      )
    ) {
      throw new Error("This exact stock update is no longer pending")
    }
    return row
  })
}

/** The product revision remains; only its order decision becomes final. */
export async function settleLocalProductStockRecovery(input: {
  merchantPubkey: string
  orderId: string
  addressId: string
  signedEventId: string
  kind: "applied" | "unpublished"
}): Promise<"saved" | "stale"> {
  return withLocalProductCoordinateLocks([input.addressId], () =>
    db.transaction(
      "rw",
      db.localProductStockCheckpoints,
      db.productListingOutbox,
      async () => {
        const id = `${input.merchantPubkey}:${encodeURIComponent(input.orderId)}:${encodeURIComponent(input.addressId)}:${input.signedEventId}`
        const checkpoint = await db.localProductStockCheckpoints.get(id)
        const listingJob = await db.productListingOutbox.get(
          `product-listing:${input.signedEventId}`
        )
        if (
          !checkpoint ||
          checkpoint.state !== "pending" ||
          checkpoint.merchantPubkey !== input.merchantPubkey ||
          checkpoint.orderId !== input.orderId ||
          checkpoint.productAddressId !== input.addressId ||
          checkpoint.signedEventId !== input.signedEventId ||
          listingJob?.merchantPubkey !== input.merchantPubkey ||
          listingJob.signedEvents.length !== 1 ||
          listingJob.signedEvents[0]?.id !== input.signedEventId ||
          listingJob.state !==
            (input.kind === "applied" ? "delivered" : "failed")
        ) {
          return "stale"
        }
        await db.localProductStockCheckpoints.update(id, {
          state: input.kind,
        })
        return "saved"
      }
    )
  )
}
