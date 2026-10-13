import { z } from "zod"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { getConfiguredIsolatedE2eRelayUrl } from "../protocol/relay-settings"
import type { SignedNostrEvent } from "../protocol/nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "../protocol/signed-event"
import {
  addressRequestRecordSchema,
  requestEvidence,
} from "./address-request-record"
import {
  addressRequestsDTag,
  sparkRecoveryNetworkSchema,
} from "./spark-recovery-address"
import {
  SparkRecoveryError,
  validateSparkCiphertext,
} from "./spark-recovery-contract"

const id = z.uuid()
const snapshotSchema = z
  .strictObject({
    format: z.literal("conduit.address-requests"),
    version: z.literal(1),
    ownerPubkey: z.string().regex(/^[0-9a-f]{64}$/),
    network: sparkRecoveryNetworkSchema,
    parentEventId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    requests: z
      .record(id, addressRequestRecordSchema)
      .refine((records) => Object.keys(records).length <= 128),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (value) =>
      value.network === "mainnet" &&
      Object.values(value.requests).every(
        (record) => requestEvidence(record).ownerPubkey === value.ownerPubkey
      )
  )

export type AddressRequestSnapshot = z.infer<typeof snapshotSchema>
export type AddressRequestNetwork = AddressRequestSnapshot["network"]
export interface AddressRequestState {
  observed?: SignedNostrEvent
  operation?: { event: SignedNostrEvent; targets: string[] }
}
export type AddressRequestStates = Partial<
  Record<AddressRequestNetwork, AddressRequestState>
>

export function validateAddressRequestEvent(
  event: SignedNostrEvent,
  owner: string,
  network: AddressRequestNetwork
): SignedNostrEvent {
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.pubkey !== owner ||
    event.kind !== 30078 ||
    event.tags.filter((tag) => tag[0] === "d").length !== 1 ||
    event.tags.find((tag) => tag[0] === "d")?.[1] !==
      addressRequestsDTag(network)
  )
    throw new SparkRecoveryError("invalid_record")
  validateSparkCiphertext(event.content)
  return structuredClone(event)
}

export function parseAddressRequests(
  plaintext: string,
  event: SignedNostrEvent,
  network: AddressRequestNetwork
): AddressRequestSnapshot {
  if (new TextEncoder().encode(plaintext).length > 16384)
    throw new SparkRecoveryError("invalid_record")
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new SparkRecoveryError("invalid_record")
  }
  const result = snapshotSchema.safeParse(parsed)
  if (
    !result.success ||
    result.data.ownerPubkey !== event.pubkey ||
    result.data.network !== network ||
    result.data.createdAt !== event.created_at
  )
    throw new SparkRecoveryError("invalid_record")
  return result.data
}

export function validateAddressRequestStates(
  states: AddressRequestStates | undefined,
  owner: string
): AddressRequestStates | undefined {
  if (!states) return undefined
  const result: AddressRequestStates = {}
  for (const [key, state] of Object.entries(states)) {
    const network = sparkRecoveryNetworkSchema.parse(key)
    const checked: AddressRequestState = {}
    if (state.observed)
      checked.observed = validateAddressRequestEvent(
        state.observed,
        owner,
        network
      )
    if (state.operation) {
      checked.operation = {
        event: validateAddressRequestEvent(
          state.operation.event,
          owner,
          network
        ),
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
          .parse(state.operation.targets),
      }
    }
    result[network] = checked
  }
  return result
}
