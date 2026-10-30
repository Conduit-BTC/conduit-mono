import { expect, test } from "bun:test"

// Static copy contract only: this reads the route source without rendering
// Orders or exercising guest sessions, storage, messaging, or payment behavior.
test("guest pickup help does not assume contact details were submitted", async () => {
  const source = await Bun.file("apps/market/src/routes/orders.tsx").text()
  const help = source.match(
    /\{guestIdentity\s*\?\s*vm\.requiresPickup\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"\s*:\s*"([^"]+)"\}/
  )
  const subtitle = source.match(
    /\{signerConnected\s*\?\s*"([^"]+)"\s*:\s*"(Review this guest order[^"]+)"\}/
  )

  expect({
    guestPickupHelp: help?.[1],
    guestShippingHelp: help?.[2],
    signedInHelp: help?.[3],
    signedInSubtitle: subtitle?.[1],
    guestSubtitle: subtitle?.[2],
  }).toEqual({
    guestPickupHelp:
      "For pickup help, speak with the seller or organizer. If you shared contact details at checkout, the merchant can also use them for recovery.",
    guestShippingHelp:
      "The merchant will use the phone and email contact details submitted at checkout for questions and fulfillment updates.",
    signedInHelp: "Message the merchant for any questions or issues.",
    signedInSubtitle:
      "Track your purchases, payment status, and shipping progress.",
    guestSubtitle:
      "Review this guest order and its locally saved checkout status. Keep your private receipt, if provided, for pickup or support.",
  })
})
