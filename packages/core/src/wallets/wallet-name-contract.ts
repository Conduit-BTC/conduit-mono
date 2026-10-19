import { z } from "zod"
import { validateAccountStorageRelayTransition } from "../protocol/account-storage-relay-policy"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { getConfiguredIsolatedE2eRelayUrl } from "../protocol/relay-settings"
import type { SignedNostrEvent } from "../protocol/nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "../protocol/signed-event"
import {
  sparkRecoveryNetworkSchema,
  walletNamesDTag,
} from "./spark-recovery-address"
import {
  SparkRecoveryError,
  validateSparkCiphertext,
} from "./spark-recovery-contract"

export const walletNameSchema = z.string().trim().min(1).max(80)
const names = z
  .record(z.uuid(), walletNameSchema)
  .refine((value) => Object.keys(value).length <= 128)
const snapshotSchema = z.object({
  format: z.literal("conduit.wallet-names"),
  version: z.literal(1),
  ownerPubkey: z.string().regex(/^[0-9a-f]{64}$/),
  network: sparkRecoveryNetworkSchema,
  parentEventId: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  names,
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export type WalletNameSnapshot = z.infer<typeof snapshotSchema>
export type WalletNameNetwork = WalletNameSnapshot["network"]
export interface WalletNameState {
  pending: Record<string, { name: string; token: string }>
  observed?: SignedNostrEvent
  operation?: {
    event: SignedNostrEvent
    targets: string[]
    relayPolicyTargets?: string[]
    intents: Record<string, string>
  }
}
export type WalletNameStates = Partial<
  Record<WalletNameNetwork, WalletNameState>
>

export { walletNamesDTag } from "./spark-recovery-address"
export function validateWalletNameEvent(
  event: SignedNostrEvent,
  owner: string,
  network: WalletNameNetwork
): SignedNostrEvent {
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.pubkey !== owner ||
    event.kind !== 30078 ||
    event.tags.filter((tag) => tag[0] === "d").length !== 1 ||
    event.tags.find((tag) => tag[0] === "d")?.[1] !== walletNamesDTag(network)
  )
    throw new SparkRecoveryError("invalid_record")
  validateSparkCiphertext(event.content)
  return structuredClone(event)
}
export function parseWalletNames(
  plaintext: string,
  event: SignedNostrEvent,
  network: WalletNameNetwork
): WalletNameSnapshot {
  if (new TextEncoder().encode(plaintext).length > 16384)
    throw new SparkRecoveryError("invalid_record")
  const snapshot = snapshotSchema.parse(JSON.parse(plaintext))
  if (
    snapshot.ownerPubkey !== event.pubkey ||
    snapshot.network !== network ||
    snapshot.createdAt !== event.created_at
  )
    throw new SparkRecoveryError("invalid_record")
  return snapshot
}
export function validateWalletNameStates(
  states: WalletNameStates | undefined,
  owner: string
): WalletNameStates | undefined {
  if (!states) return undefined
  const result: WalletNameStates = {}
  for (const [key, state] of Object.entries(states)) {
    const network = sparkRecoveryNetworkSchema.parse(key)
    const pending = z
      .record(z.uuid(), z.object({ name: walletNameSchema, token: z.uuid() }))
      .parse(state.pending)
    if (Object.keys(pending).length > 128)
      throw new SparkRecoveryError("invalid_record")
    result[network] = { pending }
    if (state.observed)
      result[network]!.observed = validateWalletNameEvent(
        state.observed,
        owner,
        network
      )
    if (state.operation) {
      const { event, targets, intents } = state.operation
      result[network]!.operation = {
        event: validateWalletNameEvent(event, owner, network),
        targets: z
          .array(
            z
              .string()
              .refine(
                (url) =>
                  url === getConfiguredIsolatedE2eRelayUrl() ||
                  !!normalizePublicWebSocketUrl(url)
              )
          )
          .min(1)
          .max(8)
          .refine((urls) => new Set(urls).size === urls.length)
          .parse(targets),
        intents: z
          .record(z.uuid(), z.uuid())
          .refine((value) => Object.keys(value).length <= 128)
          .parse(intents),
      }
      const relayPolicyTargets = validateAccountStorageRelayTransition(
        targets,
        state.operation.relayPolicyTargets
      )
      if (relayPolicyTargets)
        result[network]!.operation!.relayPolicyTargets = relayPolicyTargets
    }
  }
  return result
}
