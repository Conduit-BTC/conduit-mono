import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useAuth, useProfile, useUpdateProfile } from "@conduit/core"
import { Button, Input, Label } from "@conduit/ui"

export interface WalletAddressSuggestion {
  address: string
  ownerPubkey: string
  authGeneration: number
  firstWallet: boolean
  imported: boolean
}

/** Wallet address ownership and the account's public address are independent. */
export function ProfileLightningAddressEditor({
  suggestion,
  onDismiss,
}: {
  suggestion: WalletAddressSuggestion | null
  onDismiss(): void
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
  const publisher = useUpdateProfile("market", {
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
    address = address.trim()
    if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
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
    const key = `${scope}:${scopedSuggestion.address}`
    if (autoAttempt.current === key) return
    autoAttempt.current = key
    publisher.mutate(
      { lud16: scopedSuggestion.address },
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
  return (
    <section className="grid gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
      <h2 className="text-balance text-lg font-semibold">
        Public Lightning address
      </h2>
      <p className="text-pretty text-sm text-[var(--text-secondary)]">
        This is the single receiving address shown on your Nostr profile.
        Changing your spending wallet leaves it unchanged.
      </p>
      {!owner ? (
        <p className="text-sm">
          Sign in with Nostr to manage your public address.
        </p>
      ) : (
        <>
          <p className="break-all text-sm">
            Current address: {existing || "None"}
          </p>
          {scopedSuggestion && (
            <div className="grid gap-3 rounded-xl border border-[var(--border)] p-3">
              <p className="break-all text-sm">
                This wallet receives at {scopedSuggestion.address}.
              </p>
              {scopedSuggestion.imported && (
                <p className="text-pretty text-sm">
                  Payments to its existing address continue reaching the
                  recovered wallet. Changing your public address is optional.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    !confirmed ||
                    publisher.isPending ||
                    auth.signerReadiness !== "ready"
                  }
                  onClick={() => void save(scopedSuggestion.address)}
                >
                  {scopedSuggestion.address.endsWith("@conduit.cash")
                    ? "Use the Conduit address"
                    : "Use this wallet’s address"}
                </Button>
                <Button
                  variant="outline"
                  disabled={publisher.isPending}
                  onClick={onDismiss}
                >
                  Keep the current address
                </Button>
              </div>
            </div>
          )}
          <Label htmlFor="public-lightning-address">Lightning address</Label>
          <Input
            id="public-lightning-address"
            value={draft}
            placeholder="name@conduit.cash"
            disabled={publisher.isPending}
            onChange={(event) => {
              setDraft(event.target.value)
              setSaved(false)
            }}
          />
          <Button
            className="justify-self-start"
            variant="outline"
            disabled={
              !confirmed ||
              publisher.isPending ||
              auth.signerReadiness !== "ready" ||
              draft.trim() === existing
            }
            onClick={() => void save(draft)}
          >
            {publisher.isPending ? "Saving…" : "Save public address"}
          </Button>
          {!confirmed && (
            <p role="status" className="text-sm">
              Confirming your latest profile before changes. Your wallet is
              still usable.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm">
              Public address saved.
            </p>
          )}
        </>
      )}
    </section>
  )
}
