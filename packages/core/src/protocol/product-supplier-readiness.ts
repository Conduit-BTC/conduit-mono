import { getProfiles } from "./commerce"
import { resolveCheckoutSparkRecipientPayoutAddress } from "./checkout-spark-recipient-profile"
import { assertCheckoutSparkLnurlPayoutMetadata } from "./checkout-spark-lnurl-readiness"
import { resolveInboxDeclaration } from "./private-message-routing"
import type { ProductSupplierAllocation } from "../schemas"

export interface ProductSupplierRecipientReadiness {
  pubkey: string
  role: "merchant" | "supplier"
  state: "ready" | "unavailable" | "invalid"
  reason?:
    | "profile_unavailable"
    | "payment_address_missing"
    | "profile_invalid"
    | "payment_endpoint_unavailable"
    | "inbox_unavailable"
  displayName?: string
}

export interface ProductSupplierReadiness {
  state: "ready" | "unavailable" | "invalid"
  recipients: ProductSupplierRecipientReadiness[]
}

/** Public, signer-free authoring preflight. Ready is observed setup, never payment proof. */
export async function readProductSupplierReadiness(
  input: {
    allocation: ProductSupplierAllocation
    accountPubkey: string
    authenticatedPubkey?: string | null
    shouldContinue: () => boolean
    signal?: AbortSignal
  },
  dependencies: {
    readProfiles?: typeof getProfiles
    readInbox?: typeof resolveInboxDeclaration
    assertMetadata?: typeof assertCheckoutSparkLnurlPayoutMetadata
  } = {}
): Promise<ProductSupplierReadiness> {
  const assertCurrent = () => {
    if (!input.shouldContinue() || input.signal?.aborted)
      throw new Error("Supplier setup verification was cancelled.")
  }
  assertCurrent()
  if (input.allocation.state !== "valid")
    return { state: "invalid", recipients: [] }
  let profiles: Awaited<ReturnType<typeof getProfiles>>
  try {
    profiles = await (dependencies.readProfiles ?? getProfiles)({
      pubkeys: input.allocation.recipients.map((recipient) => recipient.pubkey),
      accountPubkey: input.accountPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "payment",
      authorRelayPaymentPolicy: true,
      priority: "visible",
      relayHintsByPubkey: Object.fromEntries(
        input.allocation.recipients.map((recipient) => [
          recipient.pubkey,
          [recipient.relayHint],
        ])
      ),
    })
  } catch {
    assertCurrent()
    return {
      state: "unavailable",
      recipients: input.allocation.recipients.map(({ pubkey, role }) => ({
        pubkey,
        role,
        state: "unavailable",
        reason: "profile_unavailable",
      })),
    }
  }
  assertCurrent()
  const recipients: ProductSupplierRecipientReadiness[] = []
  // Bounded sequential recipients prevent an authoring form from starting an unbounded relay/provider fanout.
  for (const recipient of input.allocation.recipients) {
    assertCurrent()
    const context = profiles.profileContexts[recipient.pubkey]
    const payout = resolveCheckoutSparkRecipientPayoutAddress({
      recipientPubkey: recipient.pubkey,
      context,
      readMeta: profiles.meta,
    })
    const base = { pubkey: recipient.pubkey, role: recipient.role }
    if (payout.state !== "ready") {
      recipients.push({
        ...base,
        state: payout.state,
        reason:
          payout.state === "invalid"
            ? "profile_invalid"
            : payout.reason === "payment_address_missing"
              ? "payment_address_missing"
              : "profile_unavailable",
      })
      continue
    }
    const displayName =
      context?.profile.displayName?.trim() || context?.profile.name?.trim()
    try {
      const inbox = await (dependencies.readInbox ?? resolveInboxDeclaration)(
        recipient.pubkey,
        {
          requestingAccountPubkey: input.accountPubkey,
          authenticatedPubkey: input.authenticatedPubkey,
          shouldContinue: input.shouldContinue,
          signal: input.signal,
        }
      )
      assertCurrent()
      if (
        inbox.pubkey !== recipient.pubkey ||
        inbox.state !== "declared" ||
        inbox.stale ||
        inbox.relayUrls.length === 0
      ) {
        recipients.push({
          ...base,
          displayName,
          state: "unavailable",
          reason: "inbox_unavailable",
        })
        continue
      }
    } catch {
      assertCurrent()
      recipients.push({
        ...base,
        displayName,
        state: "unavailable",
        reason: "inbox_unavailable",
      })
      continue
    }
    try {
      // Authoring does not request an invoice or promise network, amount, fees, or future availability.
      // Checkout later checks the actual allocation and exact invoice network before funding.
      await (
        dependencies.assertMetadata ?? assertCheckoutSparkLnurlPayoutMetadata
      )({
        lud16: payout.lud16,
        maximumAllocationSats: Number.MAX_SAFE_INTEGER,
        shouldContinue: () => input.shouldContinue() && !input.signal?.aborted,
      })
      assertCurrent()
      recipients.push({ ...base, displayName, state: "ready" })
    } catch {
      assertCurrent()
      recipients.push({
        ...base,
        displayName,
        state: "unavailable",
        reason: "payment_endpoint_unavailable",
      })
    }
  }
  return {
    state: recipients.some((recipient) => recipient.state === "invalid")
      ? "invalid"
      : recipients.some((recipient) => recipient.state !== "ready")
        ? "unavailable"
        : "ready",
    recipients,
  }
}
