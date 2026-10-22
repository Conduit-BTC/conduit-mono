// Selection is shared by discovery and execution; an invalid scope must never
// silently become a different set of tests.
export function readSmokeFiles(
  value: string | undefined
): string[] | undefined {
  if (!value || value === "[]") return undefined
  let files: unknown
  try {
    files = JSON.parse(value)
  } catch {
    throw new Error("Invalid Playwright smoke file selection.")
  }
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.some(
      (file) =>
        typeof file !== "string" || !/^e2e\/[\w-]+\.playwright\.ts$/.test(file)
    ) ||
    new Set(files).size !== files.length
  )
    throw new Error("Invalid Playwright smoke file selection.")
  return files as string[]
}

// These files use only the app named by their area tag. Other suites include
// cross-app wallet tests despite app tags, so retain both services by default.
export function smokeNeedsBothApps(
  files: readonly string[] | undefined
): boolean {
  const appLocalFiles = new Set([
    "e2e/checkout-recovery-storage.playwright.ts",
    "e2e/about-page.playwright.ts",
    "e2e/product-legal.playwright.ts",
    "e2e/not-found.playwright.ts",
    "e2e/shared-ui-surface-audit.playwright.ts",
  ])
  return !files || files.some((file) => !appLocalFiles.has(file))
}
