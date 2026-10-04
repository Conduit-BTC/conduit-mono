import { CommerceInboxStore } from "./commerce-inbox-store"
import { getProtectedReadAuthorization } from "./protected-read-authorization"
import {
  publishWithPlanner,
  RelayPublishDiagnosticsError,
  type PublishWithPlannerResult,
} from "./relay-publish"
import {
  resolveInboxDeclaration,
  type CompatibilityOrderRelaySource,
} from "./private-message-routing"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export interface PrivateDeliveryLeg {
  recipientPubkey: string
  event: SignedPublicNostrEvent
  relayUrls: string[]
  ownerSelectedRelayUrls: string[]
  compatibility: boolean
  relaySources?: Record<string, "declared" | CompatibilityOrderRelaySource>
  truncated?: boolean
  acknowledged: string[]
  failed: string[]
  delivery?: PublishWithPlannerResult
}
export interface PrivateDeliveryJob {
  rumorId: string
  senderPubkey: string
  legs: PrivateDeliveryLeg[]
  createdAt: number
}

export async function stagePrivateDelivery(
  store: CommerceInboxStore,
  job: PrivateDeliveryJob
): Promise<string> {
  store.assertCurrent()
  if (
    job.senderPubkey !== store.principal ||
    !job.legs.length ||
    job.legs.some(
      (leg) =>
        !isValidSignedPublicNostrEvent(leg.event) ||
        leg.event.kind !== 1059 ||
        !leg.event.tags.some(
          (tag) => tag[0] === "p" && tag[1] === leg.recipientPubkey
        ) ||
        !leg.relayUrls.length
    )
  )
    throw new Error("Invalid private delivery stage")
  const logicalId = `delivery:${job.rumorId}`
  const value = await store.seal(structuredClone(job), logicalId)
  await store.database.transaction(
    "rw",
    store.database.commerceInboxDeliveries,
    async () => {
      store.assertCurrent()
      const id = store.key(logicalId)
      if (await store.database.commerceInboxDeliveries.get(id))
        throw new Error(
          "Private message is already staged; retry the saved delivery"
        )
      await store.database.commerceInboxDeliveries.put({
        id,
        accountPubkey: store.principal,
        value,
        state: "queued",
        updatedAt: Date.now(),
        claim: { owner: crypto.randomUUID(), expiresAt: Date.now() + 60_000 },
      })
      store.assertCurrent()
    }
  )
  return logicalId
}

export async function recordPrivateDelivery(
  store: CommerceInboxStore,
  id: string,
  eventId: string,
  delivery: PublishWithPlannerResult | null,
  options: { holdClaim?: boolean } = {}
): Promise<void> {
  // Encryption stays outside the IndexedDB transaction. Compare the cipher
  // revision inside it so parallel leg outcomes merge with the latest job.
  for (let attempt = 0; attempt < 32; attempt++) {
    const row = await store.database.commerceInboxDeliveries.get(store.key(id))
    store.assertCurrent()
    if (!row) throw new Error("Private delivery stage is missing")
    const job = await store.open<PrivateDeliveryJob>(row.value, id)
    const leg = job.legs.find((candidate) => candidate.event.id === eventId)
    if (!leg) throw new Error("Private delivery bytes changed")
    leg.delivery = delivery ?? leg.delivery
    leg.acknowledged = [
      ...new Set([
        ...leg.acknowledged,
        ...(delivery?.successfulRelayUrls ?? []).filter((relay) =>
          leg.relayUrls.includes(relay)
        ),
      ]),
    ]
    leg.failed = leg.relayUrls.filter(
      (relay) => !leg.acknowledged.includes(relay)
    )
    const value = await store.seal(job, id)
    const committed = await store.database.transaction(
      "rw",
      store.database.commerceInboxDeliveries,
      async () => {
        store.assertCurrent()
        const current = await store.database.commerceInboxDeliveries.get(row.id)
        if (!current) throw new Error("Private delivery stage is missing")
        if (
          current.value.nonce.some(
            (byte, index) => byte !== row.value.nonce[index]
          )
        )
          return false
        await store.database.commerceInboxDeliveries.update(row.id, {
          value,
          claim:
            !options.holdClaim &&
            (job.legs.at(-1)?.event.id === eventId ||
              !delivery?.successfulRelayUrls.length)
              ? undefined
              : current.claim,
          state: job.legs.every((l) =>
            l.relayUrls.every((relay) => l.acknowledged.includes(relay))
          )
            ? "accepted"
            : job.legs.some((l) => l.acknowledged.length)
              ? "partial"
              : "failed",
          updatedAt: Date.now(),
        })
        store.assertCurrent()
        return true
      }
    )
    if (committed) return
  }
  throw new Error(
    "Private delivery outcomes changed concurrently; retry the saved delivery"
  )
}

/** Keep a staged multi-leg send owned until its entire publish attempt exits. */
export async function holdPrivateDeliveryClaim(
  store: CommerceInboxStore,
  id: string
) {
  const row = await store.database.commerceInboxDeliveries.get(store.key(id))
  store.assertCurrent()
  const owner = row?.claim?.owner
  if (!owner) throw new Error("Private delivery claim is missing")
  let lost = false
  const assertCurrent = () => {
    store.assertCurrent()
    if (lost)
      throw new Error(
        "Private delivery ownership changed; retry the saved delivery"
      )
  }
  const heartbeat = setInterval(() => {
    void store.database
      .transaction("rw", store.database.commerceInboxDeliveries, async () => {
        assertCurrent()
        const current = await store.database.commerceInboxDeliveries.get(
          store.key(id)
        )
        if (current?.claim?.owner !== owner)
          throw new Error("Private delivery ownership changed")
        await store.database.commerceInboxDeliveries.update(current.id, {
          claim: { owner, expiresAt: Date.now() + 60_000 },
        })
      })
      .catch(() => {
        lost = true
        clearInterval(heartbeat)
      })
  }, 10_000)
  return {
    assertCurrent,
    release: async () => {
      clearInterval(heartbeat)
      assertCurrent()
      await store.database.transaction(
        "rw",
        store.database.commerceInboxDeliveries,
        async () => {
          assertCurrent()
          const current = await store.database.commerceInboxDeliveries.get(
            store.key(id)
          )
          if (current?.claim?.owner === owner)
            await store.database.commerceInboxDeliveries.update(current.id, {
              claim: undefined,
            })
        }
      )
    },
  }
}

/** Explicit retry uses only saved signed bytes and saved targets; never signs. */
export async function retryPrivateDeliveries(
  principal: string,
  publisher = publishWithPlanner,
  onlyId?: string,
  suppliedStore?: CommerceInboxStore,
  resolveDeclaration = resolveInboxDeclaration
): Promise<void> {
  const authorization = getProtectedReadAuthorization(principal)
  if (!authorization)
    throw new Error("Reconnect the intended account to retry delivery")
  const store = suppliedStore ?? new CommerceInboxStore(authorization)
  const rows = await store.database.commerceInboxDeliveries
    .where("accountPubkey")
    .equals(principal)
    .filter(
      (row) =>
        row.state !== "accepted" && (!onlyId || row.id === store.key(onlyId))
    )
    .toArray()
  for (const row of rows) {
    store.assertCurrent()
    const id = row.id.slice(principal.length + 1)
    const claimant = crypto.randomUUID()
    const claimed = await store.database.transaction(
      "rw",
      store.database.commerceInboxDeliveries,
      async () => {
        store.assertCurrent()
        const current = await store.database.commerceInboxDeliveries.get(row.id)
        if (!current || (current.claim && current.claim.expiresAt > Date.now()))
          return false
        await store.database.commerceInboxDeliveries.update(row.id, {
          claim: { owner: claimant, expiresAt: Date.now() + 60_000 },
        })
        return true
      }
    )
    if (!claimed) continue
    const heartbeat = setInterval(() => {
      void store.database
        .transaction("rw", store.database.commerceInboxDeliveries, async () => {
          store.assertCurrent()
          const current = await store.database.commerceInboxDeliveries.get(
            row.id
          )
          if (current?.claim?.owner === claimant)
            await store.database.commerceInboxDeliveries.update(row.id, {
              claim: { owner: claimant, expiresAt: Date.now() + 60_000 },
            })
        })
        .catch(() => {
          clearInterval(heartbeat)
        })
    }, 10_000)
    try {
      const job = await store.open<PrivateDeliveryJob>(row.value, id)
      for (const leg of job.legs) {
        const targets = leg.relayUrls.filter(
          (relay) => !leg.acknowledged.includes(relay)
        )
        if (!targets.length) continue
        const declaration = await resolveDeclaration(leg.recipientPubkey, {
          requestingAccountPubkey: principal,
          authenticatedPubkey: principal,
          shouldContinue: () => {
            store.assertCurrent()
            return true
          },
        })
        store.assertCurrent()
        // A stronger signed refusal cannot authorize replay of a former plan.
        if (
          ["signed_empty", "malformed", "distribution_pending"].includes(
            declaration.state
          )
        )
          continue
        if (
          !leg.compatibility &&
          declaration.state === "declared" &&
          targets.some((relay) => !declaration.relayUrls.includes(relay))
        )
          continue
        let delivery: PublishWithPlannerResult | null = null
        try {
          delivery = await publisher(leg.event, {
            intent: "recipient_event",
            authorPubkey: principal,
            accountPubkey: principal,
            authenticatedPubkey: principal,
            recipientPubkeys: [leg.recipientPubkey],
            exclusiveRelayUrls: targets,
            ownerSelectedRelayUrls: leg.ownerSelectedRelayUrls.filter((url) =>
              targets.includes(url)
            ),
            appRelayUrls: leg.compatibility ? targets : [],
            independentRelayUrls: leg.compatibility ? [] : targets,
            deliveryMode: "critical",
            shouldContinue: () => {
              store.assertCurrent()
              return true
            },
          })
        } catch (error) {
          if (error instanceof RelayPublishDiagnosticsError)
            delivery = error.diagnostics
          else throw error
        }
        await recordPrivateDelivery(store, id, leg.event.id, delivery, {
          holdClaim: true,
        })
      }
    } finally {
      clearInterval(heartbeat)
      store.assertCurrent()
      await store.database.transaction(
        "rw",
        store.database.commerceInboxDeliveries,
        async () => {
          store.assertCurrent()
          const current = await store.database.commerceInboxDeliveries.get(
            row.id
          )
          if (current?.claim?.owner === claimant)
            await store.database.commerceInboxDeliveries.update(row.id, {
              claim: undefined,
            })
        }
      )
    }
  }
}

export async function resumePrivateDelivery(
  store: CommerceInboxStore,
  rumorId: string,
  recipient: string,
  publisher = publishWithPlanner
) {
  const id = `delivery:${rumorId}`
  let row = await store.database.commerceInboxDeliveries.get(store.key(id))
  store.assertCurrent()
  if (!row) return null
  if (row.state !== "accepted") {
    await retryPrivateDeliveries(store.principal, publisher, id, store)
    row = await store.database.commerceInboxDeliveries.get(store.key(id))
    store.assertCurrent()
  }
  if (!row) throw new Error("Saved delivery is unavailable")
  const job = await store.open<PrivateDeliveryJob>(row.value, id)
  const leg = job.legs.find((l) => l.recipientPubkey === recipient)
  const self = job.legs.find(
    (l) => l.recipientPubkey === store.principal && l !== leg
  )
  if (!leg?.delivery || !leg.acknowledged.length)
    throw new Error(
      "Saved message is still waiting for recipient relay acceptance"
    )
  return {
    wrappedToRecipient: leg.event,
    wrappedToSelf: self?.event ?? null,
    recipientDelivery: leg.delivery,
    selfDelivery: self?.delivery ?? null,
    selfDeliveryStatus: self
      ? self.acknowledged.length === self.relayUrls.length
        ? ("full_success" as const)
        : self.acknowledged.length
          ? ("partial_success" as const)
          : ("zero_success" as const)
      : null,
    selfCopyError:
      self && self.acknowledged.length !== self.relayUrls.length
        ? "Saved self-copy still needs relay acceptance"
        : null,
    deliveryRoute: leg.compatibility
      ? ("compatibility_order" as const)
      : ("declared_inbox" as const),
    deliveryStatus:
      leg.acknowledged.length === leg.relayUrls.length
        ? ("full_success" as const)
        : ("partial_success" as const),
    deliveryRelaySources:
      leg.relaySources ??
      Object.fromEntries(
        leg.relayUrls.map((url) => [
          url,
          leg.compatibility
            ? ("compatibility_registry" as const)
            : ("declared" as const),
        ])
      ),
    deliveryPlanTruncated: leg.truncated ?? false,
  }
}
