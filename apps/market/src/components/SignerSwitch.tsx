import { useMemo, useState } from "react"
import { formatPubkey, hasNip07, useAuth } from "@conduit/core"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@conduit/ui"

export function SignerSwitch() {
  const { pubkey, status, error, connect, disconnect } = useAuth()
  const [open, setOpen] = useState(false)
  const [isWorking, setIsWorking] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState(false)

  const triggerLabel = useMemo(() => {
    if (status === "connecting") return "Connecting..."
    if (status === "connected" && pubkey) return `Signer: ${formatPubkey(pubkey)}`
    return "Login"
  }, [pubkey, status])

  const canSwitch = status === "connected" && !isWorking

  async function handleConnect(): Promise<void> {
    if (status === "connecting") return
    setIsWorking(true)
    try {
      await connect()
      setPendingSwitch(false)
      setOpen(false)
    } catch {
      // keep dialog open so user can see error + retry
    } finally {
      setIsWorking(false)
    }
  }

  function handleSwitchSigner(): void {
    if (!canSwitch) return
    // NIP-07 extensions typically won't re-prompt on reconnect; best effort is to
    // disconnect and let the user change the active account in the extension.
    disconnect()
    setPendingSwitch(true)
  }

  function handleDisconnect(): void {
    disconnect()
    setPendingSwitch(false)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={status === "connected" ? "muted" : "primary"} size="sm">
          {triggerLabel}
        </Button>
      </DialogTrigger>

      <DialogContent className="border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]">
        <DialogHeader>
          <DialogTitle>Signer</DialogTitle>
          <DialogDescription className="text-[var(--text-secondary)]">
            Connect, switch, or disconnect your Nostr signer (NIP-07 extension).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {pubkey ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="border-[var(--border)]">
                {formatPubkey(pubkey, 12)}
              </Badge>
              <span className="text-xs text-[var(--text-secondary)]">
                Status: {status}
              </span>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-secondary)]">
              Status: {status}
            </div>
          )}

          {!hasNip07() && status !== "connected" && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-sm text-[var(--text-secondary)]">
              No signer extension detected. Install a NIP-07 compatible extension
              (for example Alby, nos2x, or similar), then refresh.
            </div>
          )}

          {pendingSwitch && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-sm text-[var(--text-secondary)]">
              Switched to disconnected. Change the active account in your signer
              extension, then click "Connect extension".
            </div>
          )}

          {error && (
            <div className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          {status === "connected" ? (
            <>
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={isWorking}
              >
                Disconnect
              </Button>
              <Button onClick={handleSwitchSigner} disabled={isWorking}>
                Switch account
              </Button>
            </>
          ) : (
            <Button
              onClick={handleConnect}
              disabled={isWorking || status === "connecting" || !hasNip07()}
            >
              Connect extension
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
