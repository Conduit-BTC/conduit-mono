import { z } from "zod"
import type { SignedNostrEvent } from "../protocol/nostr-event-signer"
import { SparkRecoveryError } from "./spark-recovery-contract"
import {
  sparkRecoveryNetworkSchema,
  sparkWalletRegistryDTag,
} from "./spark-recovery-address"
export {
  isSparkWalletRegistryDTag,
  sparkWalletRegistryDTag,
} from "./spark-recovery-address"

const id = z.uuid()
const eventId = z.string().regex(/^[0-9a-f]{64}$/)
const owner = eventId
const ids = z
  .array(id)
  .max(128)
  .refine((values) => new Set(values).size === values.length)
const snapshotSchema = z
  .strictObject({
    format: z.literal("conduit.spark.registry"),
    version: z.literal(1),
    ownerPubkey: owner,
    network: sparkRecoveryNetworkSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    parentEventId: eventId.nullable(),
    activeWalletIds: ids,
    removedWalletIds: ids,
    payInvoiceWalletId: id.nullable(),
    receiveWalletId: id.nullable(),
    createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (value) =>
      value.activeWalletIds.every(
        (id) => !value.removedWalletIds.includes(id)
      ) &&
      [value.payInvoiceWalletId, value.receiveWalletId].every(
        (id) => id === null || value.activeWalletIds.includes(id)
      )
  )

export type SparkWalletRegistrySnapshot = z.infer<typeof snapshotSchema>
export function parseSparkWalletRegistrySnapshot(
  plaintext: string,
  event: SignedNostrEvent
): SparkWalletRegistrySnapshot {
  if (new TextEncoder().encode(plaintext).length > 16384)
    throw new SparkRecoveryError("invalid_record")
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    throw new SparkRecoveryError("invalid_record")
  }
  const result = snapshotSchema.safeParse(value)
  if (
    !result.success ||
    result.data.ownerPubkey !== event.pubkey ||
    result.data.createdAt !== event.created_at ||
    event.tags.find((tag) => tag[0] === "d")?.[1] !==
      sparkWalletRegistryDTag(result.data.network)
  )
    throw new SparkRecoveryError("invalid_record")
  return result.data
}

/** A signed removal is monotonic even when replaceable snapshots diverge. */
export function resolveSparkWalletRegistry(
  observed: readonly {
    event: SignedNostrEvent
    snapshot: SparkWalletRegistrySnapshot
  }[]
):
  | {
      snapshot: SparkWalletRegistrySnapshot
      eventId: string
      conflict: boolean
    }
  | undefined {
  if (!observed.length) return undefined
  const ordered = [...observed].sort(
    (a, b) =>
      b.event.created_at - a.event.created_at ||
      a.event.id.localeCompare(b.event.id)
  )
  const latest = ordered[0]
  const removed = new Set(
    ordered.flatMap((item) => item.snapshot.removedWalletIds)
  )
  const activeWalletIds = latest.snapshot.activeWalletIds.filter(
    (id) => !removed.has(id)
  )
  const byId = new Map(ordered.map((item) => [item.event.id, item]))
  let ancestor = latest
  const lineage = new Set([latest.event.id])
  while (ancestor.snapshot.parentEventId) {
    const parent = byId.get(ancestor.snapshot.parentEventId)
    if (!parent) break
    if (
      parent.snapshot.revision + 1 !== ancestor.snapshot.revision ||
      lineage.has(parent.event.id)
    )
      throw new SparkRecoveryError("conflict")
    lineage.add(parent.event.id)
    ancestor = parent
  }
  return {
    eventId: latest.event.id,
    conflict: ordered.some(
      (item) =>
        item.event.id !== latest.event.id &&
        item.snapshot.revision >= latest.snapshot.revision &&
        !lineage.has(item.event.id)
    ),
    snapshot: {
      ...latest.snapshot,
      activeWalletIds,
      removedWalletIds: [...removed],
      payInvoiceWalletId: activeWalletIds.includes(
        latest.snapshot.payInvoiceWalletId ?? ""
      )
        ? latest.snapshot.payInvoiceWalletId
        : null,
      receiveWalletId: activeWalletIds.includes(
        latest.snapshot.receiveWalletId ?? ""
      )
        ? latest.snapshot.receiveWalletId
        : null,
    },
  }
}
