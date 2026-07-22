import { redirect } from "@tanstack/react-router"
import { readAuthSession } from "@conduit/core"

export function getStoredPubkey(): string | null {
  return readAuthSession()?.userPubkey ?? null
}

export function requireAuth(): void {
  const pk = getStoredPubkey()
  if (!pk) {
    throw redirect({
      to: "/",
      search: { authRequired: true },
    })
  }
}
