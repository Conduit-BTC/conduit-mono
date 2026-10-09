import { posix } from "node:path"

/** Match Vite's filesystem import URL for a test-owned absolute file path. */
export function viteFileModuleUrl(absolutePath: string): string {
  return posix.join("/@fs/", absolutePath.replaceAll("\\", "/"))
}
