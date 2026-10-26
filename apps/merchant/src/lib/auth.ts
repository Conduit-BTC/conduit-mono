import { redirect } from "@tanstack/react-router"
import { readAuthSession, parseSignInReturnTo } from "@conduit/core"
import { parseMerchantEventsSearch } from "./market-links"

export function getStoredPubkey(): string | null {
  return readAuthSession()?.userPubkey ?? null
}

export function requireAuth(
  options: { event?: string; returnTo?: string } = {}
): void {
  const pk = getStoredPubkey()
  if (!pk) {
    const event = parseMerchantEventsSearch({ event: options.event }).event
    throw redirect({
      to: "/",
      search: {
        authRequired: true,
        returnTo: parseSignInReturnTo(options.returnTo, "merchant"),
        ...(event ? { event } : {}),
      },
    })
  }
}
