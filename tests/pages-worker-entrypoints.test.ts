import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"

const ENTRYPOINTS = {
  "anon-zap-authorize.ts": ["onRequest", "onRequestOptions", "onRequestPost"],
  "anon-zap-config.ts": ["onRequest", "onRequestGet"],
  "anon-zap-sign.ts": ["onRequest", "onRequestOptions", "onRequestPost"],
  "zapout-authority.ts": ["onRequest", "onRequestOptions", "onRequestPost"],
} as const

describe("Cloudflare Pages worker entrypoints", () => {
  const repositoryRoot = join(import.meta.dir, "..")
  let outputDirectory = ""

  beforeAll(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), "conduit-pages-workers-"))
  })

  afterAll(async () => {
    if (outputDirectory) {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  })

  for (const [entrypoint, expectedExports] of Object.entries(ENTRYPOINTS)) {
    it(`${entrypoint} loads without Vite or browser globals`, async () => {
      const entrypointPath = join("functions", "api", entrypoint)
      const outputPath = join(
        outputDirectory,
        `${basename(entrypoint, ".ts")}.mjs`
      )
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          entrypointPath,
          "--target=browser",
          "--format=esm",
          "--minify",
          "--reject-unresolved",
          `--outfile=${outputPath}`,
        ],
        {
          cwd: repositoryRoot,
          stdout: "pipe",
          stderr: "pipe",
        }
      )
      const [buildExit, , buildStderr] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ])
      expect(buildExit, buildStderr).toBe(0)

      const load = Bun.spawn(
        [
          "node",
          "--input-type=module",
          "--eval",
          [
            "const module = await import(process.argv[1]);",
            "const expected = JSON.parse(process.argv[2]);",
            "for (const name of expected) {",
            "  if (typeof module[name] !== 'function') {",
            "    throw new Error(`Missing Pages handler export: ${name}`);",
            "  }",
            "}",
          ].join("\n"),
          pathToFileURL(outputPath).href,
          JSON.stringify(expectedExports),
        ],
        {
          cwd: repositoryRoot,
          stdout: "pipe",
          stderr: "pipe",
        }
      )
      const [loadExit, , loadStderr] = await Promise.all([
        load.exited,
        new Response(load.stdout).text(),
        new Response(load.stderr).text(),
      ])
      expect(loadExit, loadStderr).toBe(0)
    })
  }
})
