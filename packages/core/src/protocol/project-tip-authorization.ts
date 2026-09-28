import type { AnonZapRequestDraft } from "./anon-zap"
import { EVENT_KINDS } from "./kinds"

export const PROJECT_TIP_RECIPIENT_PUBKEY =
  "9d92077c5e35af76f7b1cd84738000b7bafb43d20b0a26c18fe29fa838d27146"
export const PROJECT_TIP_LIGHTNING_ADDRESS = "conduithodlings@strike.me"
export const PROJECT_TIP_MIN_SATS = 100
export const PROJECT_TIP_AMOUNTS_SATS = [111, 1_111, 11_111] as const
export const PROJECT_TIP_MESSAGE = "Supporting Conduit's open market mission."
export const PROJECT_TIP_PAY_REQUEST_URL =
  "https://strike.me/.well-known/lnurlp/conduithodlings"
// Fixed address LNURL, checked against the shared encoder in project-tip.test.ts.
export const PROJECT_TIP_LNURL =
  "lnurl1dp68gurn8ghj7um5wf5kkefwd4jj7tnhv4kxctttdehhwm30d3h82unvwqhkxmmwv36kjargdajxc6twvaesmwsj5r"

export type ProjectTipSigningAuthorization = {
  scope: "project_tip"
  requestId: string
  recipientPubkey: string
  amountMsats: number
  lnurl: string
}

export function validateProjectTipAmount(amountSats: number): number {
  if (
    !Number.isSafeInteger(amountSats) ||
    amountSats < PROJECT_TIP_MIN_SATS ||
    amountSats > Number.MAX_SAFE_INTEGER / 1_000
  ) {
    throw new Error("Enter a whole number of at least 100 sats.")
  }
  return amountSats * 1_000
}

/** The service signer independently enforces this fixed-purpose authorization. */
export function isAuthorizedProjectTipDraft(
  draft: AnonZapRequestDraft,
  value: unknown
): value is ProjectTipSigningAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const authorization = value as Record<string, unknown>
  if (
    Object.keys(authorization).sort().join(",") !==
      "amountMsats,lnurl,recipientPubkey,requestId,scope" ||
    authorization.scope !== "project_tip" ||
    typeof authorization.requestId !== "string" ||
    !/^[0-9a-f]{64}$/.test(authorization.requestId) ||
    authorization.recipientPubkey !== PROJECT_TIP_RECIPIENT_PUBKEY ||
    typeof authorization.amountMsats !== "number" ||
    authorization.lnurl !== PROJECT_TIP_LNURL
  ) {
    return false
  }
  try {
    validateProjectTipAmount(authorization.amountMsats / 1_000)
  } catch {
    return false
  }
  return (
    draft.kind === EVENT_KINDS.ZAP_REQUEST &&
    draft.content === PROJECT_TIP_MESSAGE &&
    draft.tags.length === 4 &&
    JSON.stringify(draft.tags.slice(0, 3)) ===
      JSON.stringify([
        ["p", PROJECT_TIP_RECIPIENT_PUBKEY],
        ["amount", String(authorization.amountMsats)],
        ["lnurl", authorization.lnurl],
      ]) &&
    draft.tags[3]?.[0] === "relays" &&
    draft.tags[3].length >= 2 &&
    draft.tags[3].length <= 9
  )
}
