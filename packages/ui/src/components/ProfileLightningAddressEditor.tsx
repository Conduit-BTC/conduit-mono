import type { WalletAddressController } from "@conduit/core/hooks/useWalletAddress"
import { Button, Input, Label } from "../index"

export function ProfileLightningAddressEditor({
  controller,
}: {
  controller: WalletAddressController
}) {
  const {
    owner,
    existing,
    scopedSuggestion,
    confirmed,
    pending,
    signerReady,
    draft,
    setDraft,
    saved,
    setSaved,
    error,
    save,
    onDismiss,
  } = controller
  return (
    <section className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
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
            <div className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--border)] p-3">
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
                  disabled={!confirmed || pending || !signerReady}
                  onClick={() => void save(scopedSuggestion.address)}
                >
                  {scopedSuggestion.address.endsWith("@conduit.cash")
                    ? "Use the Conduit address"
                    : "Use this wallet’s address"}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
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
            disabled={pending}
            onChange={(event) => {
              setDraft(event.target.value)
              setSaved(false)
            }}
          />
          <Button
            className="justify-self-start"
            variant="outline"
            disabled={
              !confirmed || pending || !signerReady || draft.trim() === existing
            }
            onClick={() => void save(draft)}
          >
            {pending ? "Saving…" : "Save public address"}
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
