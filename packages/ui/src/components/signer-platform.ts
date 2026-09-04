export interface SignerEnvironmentInput {
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
}

export type SignerPlatform = "ios" | "android" | "desktop" | "unknown-mobile"
export type AndroidSigner = "amber" | "primal"

export const CLAVE_APP_STORE_URL = "https://apps.apple.com/app/id6762104155"
export const CLAVE_TESTFLIGHT_URL = "https://testflight.apple.com/join/5Mx5AZx7"
export const AMBER_INSTALL_URL =
  "https://f-droid.org/en/packages/com.greenart7c3.nostrsigner/"
export const PRIMAL_INSTALL_URL =
  "https://play.google.com/store/apps/details?id=net.primal.android"

export function getSignerPlatform(
  input?: SignerEnvironmentInput
): SignerPlatform {
  const environment =
    input ?? (typeof navigator === "undefined" ? undefined : navigator)
  const userAgent = environment?.userAgent ?? ""

  if (
    /iphone|ipad|ipod/i.test(userAgent) ||
    (environment?.platform === "MacIntel" &&
      (environment.maxTouchPoints ?? 0) > 1)
  ) {
    return "ios"
  }
  if (/android/i.test(userAgent)) return "android"
  if (/mobile|mobi|tablet/i.test(userAgent)) return "unknown-mobile"
  return "desktop"
}

/** Keep the NIP-46 request intact while targeting the selected Android app. */
export function androidSignerConnectUrl(
  signer: AndroidSigner,
  nostrConnectUri: string
): string {
  const packageName =
    signer === "amber"
      ? "com.greenart7c3.nostrsigner"
      : signer === "primal"
        ? "net.primal.android"
        : null
  if (!packageName) throw new TypeError("Unsupported Android signer.")

  const hasControlCharacter = Array.from(nostrConnectUri).some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
  if (
    !nostrConnectUri.startsWith("nostrconnect://") ||
    /[#\s]/.test(nostrConnectUri) ||
    hasControlCharacter
  ) {
    throw new TypeError("A Nostr Connect URI without a fragment is required.")
  }

  // Do not parse or re-encode the query, or include it in an install fallback.
  const connection = nostrConnectUri.slice("nostrconnect:".length)
  return `intent:${connection}#Intent;scheme=nostrconnect;package=${packageName};end`
}
