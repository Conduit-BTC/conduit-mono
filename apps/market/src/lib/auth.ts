import { redirect } from "@tanstack/react-router"
import { readAuthSession, parseSignInReturnTo } from "@conduit/core"

export function getStoredPubkey(): string | null {
  return readAuthSession()?.userPubkey ?? null
}

export function requireAuth(options: { returnTo?: string } = {}): void {
  const pk = getStoredPubkey()
  if (!pk) {
    throw redirect({
      to: "/",
      search: {
        authRequired: true,
        returnTo: parseSignInReturnTo(options.returnTo, "market"),
      },
    })
  }
}
