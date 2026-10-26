const destinations = {
  market: new Set([
    "/messages",
    "/orders",
    "/network",
    "/preferences",
    "/profile",
  ]),
  merchant: new Set([
    "/messages",
    "/orders",
    "/network",
    "/profile",
    "/products",
    "/shipping",
  ]),
}

/** Only navigation intent may cross sign-in. Never accepts external URLs or actions. */
export function parseSignInReturnTo(
  value: unknown,
  app: keyof typeof destinations
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return undefined
  try {
    const url = new URL(value, "https://conduit.invalid")
    if (
      url.origin !== "https://conduit.invalid" ||
      !destinations[app].has(url.pathname)
    )
      return undefined
    return `${url.pathname}${url.search}`
  } catch {
    return undefined
  }
}
