import { useState } from "react"
import {
  useAccountNetworkSettings,
  useAuth,
  useConduitSession,
  useInboxDeclaration,
} from "@conduit/core"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  RelaySettingsPanel,
} from "@conduit/ui"

function EventMessagesSetupDialog({ onClose }: { onClose: () => void }) {
  const { accountPubkey, authGeneration, signerReadiness } = useAuth()
  const controller = useAccountNetworkSettings({ telemetryApp: "merchant" })
  const [dirty, setDirty] = useState(false)
  const busy = !["idle", "complete", "error"].includes(
    controller.operation.phase
  )
  const cannotClose = dirty || busy
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cannotClose) onClose()
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
        onEscapeKeyDown={(event) => {
          if (cannotClose) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (cannotClose) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Set up event messages</DialogTitle>
          <DialogDescription>
            Choose a Private inbox for participation requests, invitations and
            replies. Review your current settings before signing. Your event
            stays here.
          </DialogDescription>
        </DialogHeader>
        <RelaySettingsPanel
          controller={controller}
          accountPubkey={accountPubkey}
          signerReady={signerReadiness === "ready"}
          signerReviewKey={`${accountPubkey ?? "none"}:${authGeneration}:${signerReadiness}`}
          onUnpublishedRelayChangesChange={setDirty}
        />
        {cannotClose ? (
          <p role="status" className="text-sm">
            {busy
              ? "Finish the current Network update before returning to your event."
              : "Publish or discard the relay edits before returning to your event."}
          </p>
        ) : null}
        <Button disabled={cannotClose} onClick={onClose}>
          Return to event
        </Button>
      </DialogContent>
    </Dialog>
  )
}

/** Network settings remains the only owner of inbox reconciliation and signing. */
export function EventMessagesSetup({
  role,
  onReturn,
}: {
  role: "host" | "merchant"
  onReturn?: () => void
}) {
  const { accountPubkey, pubkey, status } = useAuth()
  const session = useConduitSession()
  const [open, setOpen] = useState(false)
  const inbox = useInboxDeclaration(accountPubkey, {
    enabled:
      status === "connected" &&
      accountPubkey === pubkey &&
      session.relaySettingsReady,
    relayScope: session.relayScope,
  })
  if (status !== "connected" || !accountPubkey || accountPubkey !== pubkey)
    return null
  const ready = inbox.status === "ready"
  const checking = inbox.status === "loading"
  const incomplete =
    inbox.status === "lookup_partial" || inbox.status === "lookup_unavailable"
  function close() {
    setOpen(false)
    inbox.refetch()
    onReturn?.()
  }
  return (
    <div className="space-y-2 rounded-lg border border-[var(--border)] p-3">
      <p role="status" className="text-sm font-medium">
        {ready
          ? "Event messages ready"
          : checking
            ? "Checking event messages…"
            : incomplete
              ? "Event messages could not be confirmed"
              : "Set up event messages"}
      </p>
      {!ready ? (
        <p className="text-sm text-[var(--text-muted)]">
          {role === "host"
            ? "Hosts need a private-message inbox to receive participation requests and send invitations."
            : "You need a private-message inbox to send participation and receive the host’s replies."}
          {incomplete
            ? " Some relay checks did not finish; your existing inbox may still be configured. Review or refresh before changing it."
            : " Use the existing Network setup to review and enable your inbox."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          {ready ? "Review event messages" : "Set up event messages"}
        </Button>
        {!ready ? (
          <Button
            type="button"
            variant="ghost"
            disabled={inbox.isRefetching}
            onClick={() => inbox.refetch()}
          >
            Refresh inbox check
          </Button>
        ) : null}
      </div>
      {open ? (
        <EventMessagesSetupDialog
          key={`${accountPubkey}:${role}`}
          onClose={close}
        />
      ) : null}
    </div>
  )
}
