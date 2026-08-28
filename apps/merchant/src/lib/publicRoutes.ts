export function isMerchantPublicAboutPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  return normalized === "/about"
}
