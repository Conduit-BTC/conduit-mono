import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { formatEventGuestReceipt } from "@conduit/core/protocol/event-guest-checkout"
import {
  createEventPickupReceiptRepository,
  type SavedEventPickupReceipt,
} from "@conduit/core/protocol/event-pickup-receipt-storage"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Label,
  QRCodeSVG,
} from "@conduit/ui"
import {
  observeEventPickupReceiptForOrder,
  observeGuestPickupReceipts,
  type EventPickupReceiptAccess,
} from "../lib/order-pickup-receipt"

export function PickupReceiptContent({
  saved,
  organizerClaimCode,
  recoveryOnly = false,
  onExport,
  onDelete,
}: {
  saved: SavedEventPickupReceipt
  organizerClaimCode?: string
  recoveryOnly?: boolean
  onExport: () => void
  onDelete: () => void
}) {
  const code = organizerClaimCode ?? saved.receipt.claimSecret
  return (
    <section
      aria-label="Pickup receipt"
      className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-5"
    >
      <h3 className="font-semibold">Pickup receipt</h3>
      {recoveryOnly ? (
        <p role="status" className="text-sm text-[var(--warning-text)]">
          Payment status is unavailable. This is only your saved private
          receipt, not a restored order session. Ask the seller to verify
          payment and any handout. This view cannot resume or send a payment.
        </p>
      ) : (
        <p className="text-sm text-[var(--text-secondary)]">
          {organizerClaimCode
            ? "Show this pickup code to the organizer. They must still verify the exact payment and reserved stock before handout."
            : "Show this private code to the seller. They must still verify payment and any prior handout."}
        </p>
      )}
      {!recoveryOnly && (
        <QRCodeSVG
          value={code}
          size={160}
          marginSize={4}
          title="Private pickup code"
        />
      )}
      <Label htmlFor="saved-event-pickup-code">
        {organizerClaimCode ? "Pickup code" : "Private receipt code"}
      </Label>
      <Input
        id="saved-event-pickup-code"
        value={code}
        readOnly
        autoComplete="off"
      />
      <p className="text-sm text-[var(--text-secondary)]">
        Keep this private. The receipt is not proof of payment or a guaranteed
        refund. Saved on this device until{" "}
        {new Date(saved.expiresAt).toLocaleString()}.
      </p>
      {organizerClaimCode ? (
        <p className="text-sm text-[var(--text-secondary)]">
          The optional saved file is a private receipt for your seller. Show
          only the pickup code above to the organizer.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onExport}>
          Save event receipt
        </Button>
        <Button type="button" variant="outline" onClick={onDelete}>
          Delete from this device
        </Button>
      </div>
    </section>
  )
}

export function OrderPickupReceipt({
  access,
  sessionKey,
  isCurrent,
}: {
  access: EventPickupReceiptAccess
  sessionKey: number
  isCurrent: () => boolean
}) {
  return (
    <ReceiptPanel
      access={access}
      sessionKey={sessionKey}
      isCurrent={isCurrent}
    />
  )
}

/** No guest signer, inbox, lifecycle, payment action or paid claim is restored. */
export function GuestPickupReceiptRecovery({
  orderId,
  sessionKey,
  isCurrent,
}: {
  orderId?: string
  sessionKey: number
  isCurrent: () => boolean
}) {
  return (
    <ReceiptPanel
      recoveryOrderId={orderId}
      sessionKey={sessionKey}
      isCurrent={isCurrent}
    />
  )
}

function ReceiptPanel({
  access,
  recoveryOrderId,
  sessionKey,
  isCurrent,
}: {
  access?: EventPickupReceiptAccess
  recoveryOrderId?: string
  sessionKey: number
  isCurrent: () => boolean
}) {
  const scopeKey = JSON.stringify([
    sessionKey,
    access ?? recoveryOrderId ?? "guest-receipts",
  ])
  const sessionCurrent = isCurrent()
  const current = useRef({ scopeKey, access, isCurrent })
  useLayoutEffect(() => {
    current.current = { scopeKey, access, isCurrent }
  }, [scopeKey, access, isCurrent])
  const [state, setState] = useState<{
    scope: string
    rows: SavedEventPickupReceipt[]
    failed: boolean
  } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expiryEpoch, setExpiryEpoch] = useState(0)
  const [notice, setNotice] = useState<{
    scope: string
    message: string
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{
    scope: string
    saved: SavedEventPickupReceipt
  } | null>(null)
  const [deletingScope, setDeletingScope] = useState<string | null>(null)
  const deleting = deletingScope === scopeKey
  const currentDeleteTarget =
    deleteTarget?.scope === scopeKey ? deleteTarget.saved : null
  useEffect(() => {
    const snapshot = current.current
    let active = true
    const assertCurrent = () => {
      if (
        !active ||
        current.current.scopeKey !== scopeKey ||
        !snapshot.isCurrent()
      )
        throw new Error("The pickup receipt session changed.")
    }
    const receive = (rows: SavedEventPickupReceipt[]) => {
      try {
        assertCurrent()
        setState({ scope: scopeKey, rows, failed: false })
      } catch {
        /* Ignore an obsolete session's private result. */
      }
    }
    const fail = () => {
      if (
        active &&
        current.current.scopeKey === scopeKey &&
        snapshot.isCurrent()
      )
        setState({ scope: scopeKey, rows: [], failed: true })
    }
    const unsubscribe = snapshot.access
      ? observeEventPickupReceiptForOrder(
          snapshot.access,
          (row) => receive(row ? [row] : []),
          fail,
          { assertCurrent }
        )
      : observeGuestPickupReceipts(receive, fail, { assertCurrent })
    return () => {
      active = false
      unsubscribe()
    }
  }, [scopeKey, expiryEpoch, sessionCurrent])
  const visible = sessionCurrent && state?.scope === scopeKey ? state : null
  const rows = visible?.rows.filter((row) => row.expiresAt > Date.now()) ?? []
  const expiresAt = rows.length
    ? Math.min(...rows.map((row) => row.expiresAt))
    : null
  useEffect(() => {
    if (expiresAt === null) return
    const timer = window.setTimeout(
      () => setExpiryEpoch((value) => value + 1),
      Math.max(0, Math.min(expiresAt - Date.now(), 2_147_483_647))
    )
    return () => window.clearTimeout(timer)
  }, [expiresAt, expiryEpoch])
  const selected = rows.find(
    (row) => row.orderId === (access?.orderId ?? recoveryOrderId ?? selectedId)
  )
  function assertActionCurrent(saved: SavedEventPickupReceipt) {
    if (
      current.current.scopeKey !== scopeKey ||
      !isCurrent() ||
      saved.expiresAt <= Date.now() ||
      (access && access.orderId !== saved.orderId)
    )
      throw new Error("The pickup receipt session changed.")
  }
  function exportReceipt(saved: SavedEventPickupReceipt) {
    try {
      assertActionCurrent(saved)
      const url = URL.createObjectURL(
        new Blob([formatEventGuestReceipt(saved.receipt)], {
          type: "text/plain;charset=utf-8",
        })
      )
      const link = document.createElement("a")
      link.href = url
      link.download = "conduit-event-receipt.txt"
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
    } catch {
      if (current.current.scopeKey === scopeKey && isCurrent())
        setNotice({
          scope: scopeKey,
          message:
            "The private receipt download could not start. Your saved copy has not been deleted.",
        })
    }
  }
  async function removeReceipt() {
    const saved = currentDeleteTarget
    if (!saved || deleting) return
    setDeletingScope(scopeKey)
    try {
      assertActionCurrent(saved)
      await createEventPickupReceiptRepository({
        assertCurrent: () => assertActionCurrent(saved),
      }).remove(saved.orderId, access?.buyerScope ?? { kind: "guest" })
      if (current.current.scopeKey === scopeKey && isCurrent()) {
        setDeleteTarget(null)
        setNotice({
          scope: scopeKey,
          message:
            "Private receipt deleted from this device. Any exported copies remain; the order and payments are unchanged.",
        })
      }
    } catch {
      if (current.current.scopeKey === scopeKey && isCurrent())
        setNotice({
          scope: scopeKey,
          message:
            "The private receipt could not be deleted. It may still be saved on this device; try again before assuming it was removed.",
        })
    } finally {
      if (current.current.scopeKey === scopeKey) setDeletingScope(null)
    }
  }
  if (!sessionCurrent) return null
  return (
    <div className="space-y-3">
      {notice?.scope === scopeKey ? (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          {notice.message}
        </p>
      ) : null}
      {!visible ? (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          Checking saved pickup receipt…
        </p>
      ) : visible.failed ? (
        <p role="alert" className="text-sm text-[var(--error-text)]">
          Private receipt storage is unavailable. Try this same browser again or
          use your private exported copy; contact the seller for help. No
          payment or handout is authorized by this view.
        </p>
      ) : null}
      {visible &&
      !visible.failed &&
      !selected &&
      (access || recoveryOrderId) ? (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          No saved pickup receipt is available for this order on this device. It
          may have expired, been deleted or been cleared with browser storage.
        </p>
      ) : null}
      {!access && !recoveryOrderId && rows.length > 0 ? (
        <section aria-label="Saved pickup receipts" className="space-y-3">
          <h3 className="font-semibold">Saved pickup receipts</h3>
          <p className="text-sm text-[var(--text-secondary)]">
            These private copies do not restore an expired guest session or
            confirm payment.
          </p>
          {rows.map((row, index) => (
            <Button
              key={row.orderId}
              type="button"
              variant="outline"
              onClick={() => setSelectedId(row.orderId)}
            >
              Receipt {index + 1} · event ends{" "}
              {new Date(row.occurrenceEnd).toLocaleDateString()}
            </Button>
          ))}
        </section>
      ) : null}
      {selected ? (
        <PickupReceiptContent
          saved={selected}
          organizerClaimCode={access?.organizerClaimCode}
          recoveryOnly={!access}
          onExport={() => exportReceipt(selected)}
          onDelete={() => setDeleteTarget({ scope: scopeKey, saved: selected })}
        />
      ) : null}
      <AlertDialog
        open={!!currentDeleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this private receipt?</AlertDialogTitle>
            <AlertDialogDescription>
              Keep a private exported copy first if you still need it. This
              removes this device’s receipt code, not the order or its payments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => void removeReceipt()}
            >
              {deleting ? "Deleting…" : "Delete receipt"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
