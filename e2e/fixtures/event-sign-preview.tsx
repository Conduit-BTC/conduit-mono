import { useState } from "react"
import { createRoot } from "react-dom/client"

import { EventQrPrintPreview } from "../../apps/merchant/src/components/EventQrPrintPreview"

const sheet = {
  id: "mobile-event-sign",
  kind: "merchant",
  qrValue:
    "https://shop.conduit.market/events/naddr1qqxnzdenx5cr2wfcxycrwwfcqgs9y6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6qpsgqqqw4rsf45khs?merchant=npub1qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqdt7a9h",
  eventTitle: "A complete printable event title at the narrowest viewport",
  bannerUrl:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1800' height='600'%3E%3Crect width='1800' height='600' fill='%23211e31'/%3E%3Crect x='18' y='18' width='1764' height='564' fill='none' stroke='%23bb00ff' stroke-width='18'/%3E%3C/svg%3E",
  schedule: "Sep 17, 2026, 9:00 AM - Sep 17, 2026, 5:00 PM",
  location: "A complete public event location",
  merchant: {
    pubkey: "0202020202020202020202020202020202020202020202020202020202020202",
    name: "A complete merchant display name",
    fallback: "AC",
  },
} as const

function EventSignPreviewFixture() {
  const [open, setOpen] = useState(true)
  return (
    <EventQrPrintPreview
      open={open}
      onOpenChange={setOpen}
      title="Print merchant sign"
      sheets={[sheet]}
      eventState="active"
      refreshing={false}
      onRefresh={() => undefined}
    />
  )
}

const root = document.getElementById("event-sign-mobile-test-root")
if (!root) throw new Error("Event sign mobile fixture root is missing.")
createRoot(root).render(<EventSignPreviewFixture />)
