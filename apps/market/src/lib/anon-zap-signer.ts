import { config, validateAnonZapRequestDraft } from "@conduit/core"
import type { CheckoutZapRequestDraft } from "./checkout-payment"

type AnonZapSignerOptions = {
  signerUrl?: string | null
  expectedPubkey?: string | null
  authorization?: AnonZapSigningAuthorization
  fetchImpl?: typeof fetch
}

export type AnonZapSigningAuthorization = {
  checkoutSessionId: string
  merchantPubkey: string
  amountMsats: number
  lnurl: string
  publicZapPolicy: "anonymous_public_zap_allowed"
}

function normalizeAnonZapSignerDraft(
  draft: CheckoutZapRequestDraft
): CheckoutZapRequestDraft {
  return {
    ...draft,
    tags: [
      ...draft.tags.filter((tag) => tag[0] !== "client"),
      ["client", "conduit-market"],
    ],
  }
}

export function isAnonZapSignerConfigured(
  cfg: Pick<typeof config, "anonZapSignerUrl" | "anonZapSignerPubkey"> = config
): boolean {
  void cfg
  return false
}

export const validateAnonZapSignerDraft = validateAnonZapRequestDraft

export async function signCheckoutZapRequestWithAnonSigner(
  draft: CheckoutZapRequestDraft,
  options: AnonZapSignerOptions = {}
): Promise<never> {
  void options
  const signerDraft = normalizeAnonZapSignerDraft(draft)
  const validation = validateAnonZapSignerDraft(signerDraft)
  if (!validation.ok) throw new Error(validation.reason)
  throw new Error("Anon zap signer requires trusted checkout authorization.")
}
