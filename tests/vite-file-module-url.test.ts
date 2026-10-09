import { describe, expect, it } from "bun:test"
import { posix } from "node:path"
import { viteFileModuleUrl } from "../e2e/helpers/vite-file-module-url"

describe("isolated Vite filesystem module URL", () => {
  it("matches the canonical served POSIX URL without a second module alias", () => {
    const absolutePath = "/workspace/packages/core/src/config.ts"
    expect(viteFileModuleUrl(absolutePath)).toBe(
      "/@fs/workspace/packages/core/src/config.ts"
    )
    expect(viteFileModuleUrl(absolutePath)).toBe(
      posix.join("/@fs/", absolutePath)
    )
  })

  it("preserves the canonical Windows drive URL after separator normalization", () => {
    const absolutePath = "C:\\workspace\\packages\\core\\src\\config.ts"
    expect(viteFileModuleUrl(absolutePath)).toBe(
      "/@fs/C:/workspace/packages/core/src/config.ts"
    )
    expect(viteFileModuleUrl(absolutePath)).toBe(
      posix.join("/@fs/", absolutePath.replaceAll("\\", "/"))
    )
  })
})
