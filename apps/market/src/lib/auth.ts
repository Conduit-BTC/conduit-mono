import { redirect } from "@tanstack/react-router"

const AUTH_STORAGE_KEY = "conduit:auth"

export function getStoredPubkey(): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY)
  } catch {
    return null
  }
}

export function requireAuth(): void {
  const pk = getStoredPubkey()
  const isValidHex64 = typeof pk === "string" && /^[0-9a-f]{64}$/i.test(pk)
  if (!isValidHex64) {
    throw redirect({
      to: "/",
      search: { authRequired: true },
    })
  }
}
