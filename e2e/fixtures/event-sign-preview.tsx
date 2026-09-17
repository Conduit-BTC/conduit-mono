import { useState } from "react"
import { createRoot } from "react-dom/client"

import { EventQrPrintPreview } from "../../apps/merchant/src/components/EventQrPrintPreview"

const sheet = {
  id: "mobile-event-sign",
  kind: "merchant",
  qrValue:
    "https://shop.conduit.market/events/naddr1qqxnzdenx5cr2wfcxycrwwfcqgs9y6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6yzy6qpsgqqqw4rsf45khs?merchant=npub1qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqdt7a9h",
  eventTitle: "A complete printable event title at the narrowest viewport",
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
