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
  bannerUrl:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1800' height='600'%3E%3Crect width='1800' height='600' fill='%2315072b'/%3E%3Ccircle cx='330' cy='300' r='180' fill='%23a100ff'/%3E%3Cpath d='M700 170h820v260H700z' fill='%23f4eef8'/%3E%3C/svg%3E",
  merchant: {
    pubkey: "0202020202020202020202020202020202020202020202020202020202020202",
    name: "A complete merchant display name",
    imageUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='600'%3E%3Crect width='600' height='600' fill='%23ffffff'/%3E%3Ccircle cx='300' cy='300' r='230' fill='%23171717'/%3E%3C/svg%3E",
    bannerUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1800' height='600'%3E%3Crect width='1800' height='600' fill='%230d3b3e'/%3E%3Ccircle cx='250' cy='120' r='90' fill='%23d6b85a'/%3E%3Ccircle cx='1450' cy='390' r='150' fill='%2379b8b4'/%3E%3C/svg%3E",
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
