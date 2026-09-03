import { redirect } from "@tanstack/react-router"
import { readAuthSession } from "@conduit/core"
import { parseMerchantEventsSearch } from "./market-links"

export function getStoredPubkey(): string | null {
  return readAuthSession()?.userPubkey ?? null
}

export function requireAuth(options: { event?: string } = {}): void {
  const pk = getStoredPubkey()
  if (!pk) {
    const event = parseMerchantEventsSearch({ event: options.event }).event
    throw redirect({
      to: "/",
      search: {
        authRequired: true,
        ...(event ? { event } : {}),
      },
    })
  }
}
