import {
  buildEventMarketPickupDraft,
  isValidSignedPublicNostrEvent,
  publishEventMarketPickupOption,
  retryEventMarketPickupOption,
  type OrganizerEventMarketPickupPublishInput,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const STORAGE_PREFIX = "conduit:merchant:event-pickup-delivery:v1"

interface StoredMerchantPickupDelivery {
  coordinate: string
  signedEvent: SignedPublicNostrEvent
  acknowledged: boolean
}

export interface EnsureMerchantBoothPickupInput {
  authorPubkey: string
  dTag: string
  title: string
  location?: string
  geohash?: string
  country: string
  onSignerRequest?: () => void
  storage?: Pick<Storage, "getItem" | "setItem"> | null
}

export interface EnsuredMerchantBoothPickup {
  coordinate: string
  signedEvent: SignedPublicNostrEvent
}

function storageKey(authorPubkey: string, coordinate: string): string {
  return `${STORAGE_PREFIX}:${authorPubkey}:${encodeURIComponent(coordinate)}`
}

function getStorage(
  storage: EnsureMerchantBoothPickupInput["storage"]
): Pick<Storage, "getItem" | "setItem"> | null {
  if (storage !== undefined) return storage
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function singleDTag(event: SignedPublicNostrEvent): string | null {
  const values = event.tags
    .filter((tag) => tag[0] === "d" && typeof tag[1] === "string")
    .map((tag) => tag[1]!)
  return values.length === 1 ? values[0]! : null
}

function readStoredDelivery(
  storage: Pick<Storage, "getItem">,
  authorPubkey: string,
  coordinate: string
): StoredMerchantPickupDelivery | null {
  const invalidStateMessage =
    "Saved merchant pickup retry data is invalid. Publishing was stopped before signing so an earlier pickup is not replaced."
  try {
    const raw = storage.getItem(storageKey(authorPubkey, coordinate))
    if (raw === null) return null
    const parsed = JSON.parse(
      raw
    ) as Partial<StoredMerchantPickupDelivery> | null
    if (
      !parsed ||
      parsed.coordinate !== coordinate ||
      typeof parsed.acknowledged !== "boolean" ||
      !parsed.signedEvent ||
      !isValidSignedPublicNostrEvent(parsed.signedEvent) ||
      parsed.signedEvent.kind !== 30406 ||
      parsed.signedEvent.pubkey !== authorPubkey ||
      singleDTag(parsed.signedEvent) !==
        coordinate.split(":").slice(2).join(":")
    ) {
      throw new Error(invalidStateMessage)
    }
    return parsed as StoredMerchantPickupDelivery
  } catch (error) {
    if (error instanceof Error && error.message === invalidStateMessage) {
      throw error
    }
    throw new Error(invalidStateMessage, { cause: error })
  }
}

function saveStoredDelivery(
  storage: Pick<Storage, "setItem">,
  authorPubkey: string,
  delivery: StoredMerchantPickupDelivery
): void {
  try {
    storage.setItem(
      storageKey(authorPubkey, delivery.coordinate),
      JSON.stringify(delivery)
    )
  } catch {
    throw new Error(
      "The signed merchant pickup could not be saved for exact retry. Relay publishing was stopped."
    )
  }
}

function semanticEventMatches(
  signedEvent: SignedPublicNostrEvent,
  pickup: OrganizerEventMarketPickupPublishInput
): boolean {
  const draft = buildEventMarketPickupDraft({
    dTag: pickup.dTag,
    title: pickup.title,
    price: Number(pickup.price),
    currency: pickup.currency,
    countries: pickup.countries ??
      pickup.countryCodes ?? [pickup.country ?? ""],
    location: pickup.location,
    geohash: pickup.geohash,
    content: pickup.content,
    clientAppId: pickup.clientAppId,
  })
  return (
    signedEvent.kind === draft.kind &&
    signedEvent.content === draft.content &&
    JSON.stringify(signedEvent.tags) === JSON.stringify(draft.tags)
  )
}

/**
 * Ensure an acknowledged, author-owned booth pickup exists before a product
 * revision references it. An interrupted delivery always retries the exact
 * persisted signed event before a newer semantic revision can be signed.
 */
export async function ensureMerchantBoothPickup(
  input: EnsureMerchantBoothPickupInput
): Promise<EnsuredMerchantBoothPickup> {
  const authorPubkey = input.authorPubkey.trim().toLowerCase()
  const coordinate = `30406:${authorPubkey}:${input.dTag}`
  const storage = getStorage(input.storage)
  if (!storage) {
    throw new Error(
      "Durable pickup retry storage is unavailable. Publishing was stopped before signing."
    )
  }
  const pickup: OrganizerEventMarketPickupPublishInput = {
    dTag: input.dTag,
    title: input.title,
    price: 0,
    currency: "SAT",
    countries: [input.country],
    location: input.location,
    geohash: input.geohash,
    content: "",
    clientAppId: "merchant",
  }

  let stored = readStoredDelivery(storage, authorPubkey, coordinate)
  if (stored && !stored.acknowledged) {
    await retryEventMarketPickupOption({
      authorPubkey,
      signedEvent: stored.signedEvent,
    })
    stored = { ...stored, acknowledged: true }
    saveStoredDelivery(storage, authorPubkey, stored)
  }
  if (stored && semanticEventMatches(stored.signedEvent, pickup)) {
    return { coordinate, signedEvent: stored.signedEvent }
  }

  let signedEvent: SignedPublicNostrEvent | null = null
  input.onSignerRequest?.()
  const result = await publishEventMarketPickupOption({
    authorPubkey,
    pickup,
    previousCreatedAt: stored?.signedEvent.created_at,
    onSignedEvent: (record) => {
      signedEvent = record.signedEvent
      saveStoredDelivery(storage, authorPubkey, {
        coordinate,
        signedEvent: record.signedEvent,
        acknowledged: false,
      })
    },
  })
  signedEvent = result.signedEvent ?? signedEvent
  if (!signedEvent) {
    throw new Error("The signed merchant pickup result was unavailable.")
  }
  saveStoredDelivery(storage, authorPubkey, {
    coordinate,
    signedEvent,
    acknowledged: true,
  })
  return { coordinate, signedEvent }
}
