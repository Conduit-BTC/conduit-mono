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
  if (!pk) {
    throw redirect({
      to: "/",
      search: { authRequired: true },
    })
  }
}

