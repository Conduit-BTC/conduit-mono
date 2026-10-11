import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useAuth, useProfile, useUpdateProfile } from "@conduit/core"
import { isValidLud16Address } from "../protocol/lightning"

export interface WalletAddressSuggestion {
  address: string
  ownerPubkey: string
  authGeneration: number
  firstWallet: boolean
  imported: boolean
}

/** Wallet address ownership and the account's public address are independent. */
export function useWalletAddress({
  suggestion,
  onDismiss,
  appId,
}: {
  suggestion: WalletAddressSuggestion | null
  onDismiss(): void
  appId: "market" | "merchant"
}) {
  const auth = useAuth()
  const owner = auth.accountPubkey
  const generation = auth.authGeneration
  const current = () =>
    auth.isAuthGenerationCurrent(generation) &&
    auth.isAccountIdentityCurrent(owner ?? "")
  const profile = useProfile(owner, {
    accountPubkey: owner,
    authenticatedPubkey: auth.signerReadiness === "ready" ? owner : null,
    requireCompleteEvidence: true,
    evidenceScope: "profile_edit",
    shouldContinue: current,
  })
  const raw = profile.profileContext?.frontier?.rawContent
  let existing = profile.evidenceData?.lud16 ?? ""
  try {
    if (!existing && raw) {
      const value = JSON.parse(raw)
      if (typeof value.lud06 === "string") existing = value.lud06
    }
  } catch {
    /* Malformed evidence cannot authorize an address update. */
  }
  const publisher = useUpdateProfile(appId, {
    authenticatedPubkey: owner,
    authGeneration: generation,
    shouldContinue: current,
    expectedLightningAddress: existing,
  })
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const autoAttempt = useRef<string | null>(null)
  const scopedSuggestion =
    suggestion?.ownerPubkey === owner &&
    suggestion.authGeneration === generation
      ? suggestion
      : null
  const scope = `${owner}:${generation}`
  const viewScope = useRef(scope)
  useLayoutEffect(() => {
    viewScope.current = scope
  }, [scope])
  const context = profile.profileContext
  const confirmed =
    !!context &&
    ((context.frontier?.validity === "valid" &&
      context.freshness === "observed") ||
      (!context.frontier &&
        context.readComplete &&
        context.freshness === "unobserved" &&
        context.persistence !== "unavailable"))
  useEffect(() => {
    setDraft(existing)
    setError(null)
    setSaved(false)
  }, [existing, owner, generation])
  const save = async (address: string) => {
    if (!owner || !current() || publisher.isPending) return
    address = address.trim().toLowerCase()
    setSaved(false)
    if (address && !isValidLud16Address(address)) {
      setError("Enter a Lightning address, such as name@conduit.cash.")
      return
    }
    const expectedScope = scope
    setError(null)
    setSaved(false)
    try {
      await publisher.mutateAsync({ lud16: address })
      if (viewScope.current !== expectedScope || !current()) return
      setDraft(address)
      setSaved(true)
      onDismiss()
      await profile.refetch()
    } catch (caught) {
      if (viewScope.current !== expectedScope || !current()) return
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update your public address."
      )
      await profile.refetch()
    }
  }
  // Only the first newly created wallet may supply the disclosed empty-profile
  // default. Imports/additional wallets always leave the public address alone.
  useEffect(() => {
    if (
      !scopedSuggestion ||
      !scopedSuggestion.firstWallet ||
      scopedSuggestion.imported ||
      existing ||
      !confirmed ||
      auth.signerReadiness !== "ready"
    )
      return
    const address = scopedSuggestion.address.trim().toLowerCase()
    const key = `${scope}:${address}`
    if (autoAttempt.current === key) return
    autoAttempt.current = key
    setSaved(false)
    if (!isValidLud16Address(address)) {
      setError("Enter a Lightning address, such as name@conduit.cash.")
      return
    }
    publisher.mutate(
      { lud16: address },
      {
        onSuccess() {
          if (current()) onDismiss()
        },
        onError(caught) {
          if (!current()) return
          setError(caught.message)
          void profile.refetch()
        },
      }
    )
  })
  return {
    owner,
    existing,
    scopedSuggestion,
    confirmed,
    pending: publisher.isPending,
    signerReady: auth.signerReadiness === "ready",
    draft,
    setDraft,
    saved,
    setSaved,
    error,
    save,
    onDismiss,
  }
}
export type WalletAddressController = ReturnType<typeof useWalletAddress>
