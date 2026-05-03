import { type ClassValue, clsx } from "clsx"
import { nip19 } from "@nostr-dev-kit/ndk"
import { twMerge } from "tailwind-merge"

/**
 * Merge Tailwind classes with clsx
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Format price with currency
 */
export function formatPrice(
  amount: number,
  currency = "USD",
  locale = "en-US"
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amount)
}

/**
 * Format satoshis to BTC or sats display
 */
export function formatSats(sats: number, showBtc = false): string {
  if (showBtc && sats >= 100_000_000) {
    return `${(sats / 100_000_000).toFixed(8)} BTC`
  }
  return `${sats.toLocaleString()} sats`
}

/**
 * Convert a hex pubkey to npub (bech32). Returns the input unchanged if
 * it is already an npub or encoding fails.
 */
export function pubkeyToNpub(hex: string): string {
  if (hex.startsWith("npub1")) return hex
  try {
    return nip19.npubEncode(hex)
  } catch {
    return hex
  }
}

/**
 * Normalize a hex, npub, or nprofile value into a hex pubkey.
 * Returns null when the value is not a valid public key reference.
 */
export function normalizePubkey(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase()

  try {
    const decoded = nip19.decode(trimmed)
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return decoded.data.toLowerCase()
    }
    if (
      decoded.type === "nprofile" &&
      decoded.data &&
      typeof decoded.data === "object" &&
      "pubkey" in decoded.data &&
      typeof decoded.data.pubkey === "string"
    ) {
      return decoded.data.pubkey.toLowerCase()
    }
  } catch {
    return null
  }

  return null
}

/**
 * Truncate a hex pubkey for display. Prefer `formatNpub` for user-facing
 * surfaces; this helper is kept for non-pubkey identifiers (order IDs, etc.).
 */
export function formatPubkey(pubkey: string, chars = 8): string {
  if (pubkey.length <= chars * 2) return pubkey
  return `${pubkey.slice(0, chars)}...${pubkey.slice(-chars)}`
}

/**
 * Display a pubkey as a shortened npub (e.g. `npub1abc…wxyz`).
 * Falls back to shortened hex if encoding fails.
 */
export function formatNpub(pubkey: string, chars = 8): string {
  const npub = pubkeyToNpub(pubkey)
  if (npub.length <= chars * 2 + 5) return npub
  return `${npub.slice(0, 5 + chars)}...${npub.slice(-chars)}`
}

/**
 * Format relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp * 1000 // Convert to ms if unix timestamp

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return "just now"
}

/**
 * Generate a unique identifier
 */
export function generateId(): string {
  return crypto.randomUUID()
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), ms)
  }
}
