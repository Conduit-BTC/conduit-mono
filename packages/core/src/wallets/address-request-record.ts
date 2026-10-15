import { z } from "zod"
import {
  ADDRESS_REQUEST_PATH,
  verifyAddressRequestAuthority,
  type SignedAddressNameRequest,
} from "./address-name-request"
import { SparkRecoveryError } from "./spark-recovery-contract"

/** Private extension of the existing encrypted wallet registry, never approval authority. */
export const addressRequestRecordSchema = z
  .strictObject({
    payload: z.string().max(8192),
    accountProof: z.string().max(4096),
    phase: z.enum([
      "pending",
      "received",
      "approved",
      "declined",
      "activating",
      "registered",
      "complete",
    ]),
    profileEventId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine((record, context) => {
    try {
      const request = JSON.parse(record.payload) as SignedAddressNameRequest
      const proof = JSON.parse(record.accountProof)
      if (
        !verifyAddressRequestAuthority(
          request,
          proof,
          ADDRESS_REQUEST_PATH,
          request.timestamp,
          undefined,
          record.payload
        ) ||
        (record.phase === "complete") !== !!record.profileEventId
      )
        throw new Error()
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid saved request evidence",
      })
    }
  })
export type AddressRequestRecord = z.infer<typeof addressRequestRecordSchema>
export function requestEvidence(
  record: AddressRequestRecord
): SignedAddressNameRequest {
  return JSON.parse(record.payload) as SignedAddressNameRequest
}
const rank: Record<AddressRequestRecord["phase"], number> = {
  pending: 0,
  received: 1,
  approved: 2,
  declined: 2,
  activating: 3,
  registered: 4,
  complete: 5,
}
/** Omission or a stale device cannot erase immutable evidence or completed work. */
export function mergeAddressRequestRecord(
  previous: AddressRequestRecord | undefined,
  next: AddressRequestRecord
): AddressRequestRecord {
  if (!previous) return next
  if (
    previous.payload !== next.payload ||
    previous.accountProof !== next.accountProof ||
    (previous.phase === "declined" &&
      rank[next.phase] >= 2 &&
      next.phase !== "declined") ||
    (next.phase === "declined" &&
      rank[previous.phase] >= 2 &&
      previous.phase !== "declined") ||
    (previous.profileEventId &&
      next.profileEventId &&
      previous.profileEventId !== next.profileEventId)
  )
    throw new SparkRecoveryError("conflict")
  return rank[previous.phase] >= rank[next.phase] ? previous : next
}
