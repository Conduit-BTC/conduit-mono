import type { WalletAddressController } from "@conduit/core/hooks/useWalletAddress"
import { useState, type RefObject } from "react"
import {
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../index"

export function ProfileLightningAddressEditor({
  controller,
  returnFocusRef,
  reviewOpen = false,
  onReviewOpenChange,
  dialogOnly = false,
}: {
  controller: WalletAddressController
  returnFocusRef?: RefObject<HTMLElement | null>
  reviewOpen?: boolean
  onReviewOpenChange?(open: boolean): void
  dialogOnly?: boolean
}) {
  const { owner, existing, saved, setSaved, onDismiss } = controller
  const [editing, setEditing] = useState(false)
  const open = reviewOpen || editing
  return (
    <section
      aria-label="Nostr profile receiving address"
      className={
        dialogOnly
          ? undefined
          : "flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] py-5"
      }
    >
      {!dialogOnly && (
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Nostr receiving address</h2>
          <p
            data-wallet-address
            className="mt-1 break-all text-sm text-[var(--text-secondary)]"
          >
            {existing || "No address set"}
          </p>
          {saved && (
            <p role="status" className="mt-1 text-sm">
              Public address saved.
            </p>
          )}
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setEditing(next)
          if (next) setSaved(false)
          if (!next) {
            onReviewOpenChange?.(false)
            onDismiss()
          }
        }}
      >
        {!dialogOnly && (
          <DialogTrigger asChild>
            <Button
              variant="outline"
              disabled={!owner}
              onClick={(event) => {
                if (returnFocusRef) returnFocusRef.current = event.currentTarget
              }}
            >
              Edit
            </Button>
          </DialogTrigger>
        )}
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (returnFocusRef?.current?.isConnected) {
              event.preventDefault()
              returnFocusRef.current.focus({ preventScroll: true })
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Public Lightning address</DialogTitle>
            <DialogDescription>
              Choose where your Nostr profile receives sats. Changing this does
              not change your wallet’s own address.
            </DialogDescription>
          </DialogHeader>
          <ProfileLightningAddressForm
            controller={controller}
            onSaved={() => {
              setEditing(false)
              onReviewOpenChange?.(false)
            }}
            onKeep={() => {
              setEditing(false)
              onReviewOpenChange?.(false)
              onDismiss()
            }}
          />
        </DialogContent>
      </Dialog>
    </section>
  )
}

function ProfileLightningAddressForm({
  controller,
  onKeep,
  onSaved,
}: {
  controller: WalletAddressController
  onKeep(): void
  onSaved(): void
}) {
  const {
    owner,
    scopedSuggestion,
    confirmed,
    pending,
    signerReady,
    draft,
    setDraft,
    setSaved,
    existing,
    error,
    save,
  } = controller
  const saveAddress = async (address: string) => {
    if (await save(address)) onSaved()
  }
  return (
    <>
      {!owner ? (
        <p className="text-sm">
          Sign in with Nostr to manage your public address.
        </p>
      ) : (
        <>
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
                  onClick={() => void saveAddress(scopedSuggestion.address)}
                >
                  {scopedSuggestion.address.endsWith("@conduit.cash")
                    ? "Use the Conduit address"
                    : "Use this wallet’s address"}
                </Button>
                <Button variant="outline" disabled={pending} onClick={onKeep}>
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
            onClick={() => void saveAddress(draft)}
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
        </>
      )}
    </>
  )
}
