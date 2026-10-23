import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, posix, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const MAX_CHUNKS = 512
const MAX_BYTES = 128 * 1024 * 1024
const parser = new Bun.Transpiler({ loader: "js" })

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1]
}

function localChunk(specifier: string, importer = "index.html"): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier) || specifier.startsWith("//"))
    throw new Error("Bundle census requires local emitted module references.")
  const path = posix.normalize(
    specifier.startsWith("/")
      ? specifier.slice(1)
      : posix.join(posix.dirname(importer), specifier)
  )
  if (path.startsWith("../") || path === "..")
    throw new Error("Bundle census module escapes its emitted application.")
  return path
}

/** Pure emitted-byte census: scans source but never imports/evaluates it. */
export function measureEmittedCheckoutStartupBundle(input: {
  indexHtml: string
  javascript: ReadonlyMap<string, Uint8Array>
}) {
  if (
    input.javascript.size > MAX_CHUNKS ||
    [...input.javascript.values()].reduce(
      (total, bytes) => total + bytes.byteLength,
      0
    ) > MAX_BYTES
  )
    throw new Error("Bundle census exceeds its bounded artifact budget.")
  const roots = new Set<string>()
  for (const tag of input.indexHtml.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const reference = /^<script\b/i.test(tag)
      ? attribute(tag, "type") === "module"
        ? attribute(tag, "src")
        : undefined
      : attribute(tag, "rel") === "modulepreload"
        ? attribute(tag, "href")
        : undefined
    if (reference) roots.add(localChunk(reference))
  }
  if (!roots.size)
    throw new Error("Bundle census found no emitted module entry.")
  const imports = new Map(
    [...input.javascript].map(([path, bytes]) => [
      path,
      parser
        .scan(new TextDecoder().decode(bytes))
        .imports.filter(
          (edge) =>
            edge.kind === "import-statement" || edge.kind === "dynamic-import"
        )
        .map((edge) => ({
          path: localChunk(edge.path, path),
          dynamic: edge.kind === "dynamic-import",
        })),
    ])
  )
  const walk = (includeDynamic: boolean) => {
    const visited = new Set<string>()
    const pending = [...roots]
    while (pending.length) {
      const path = pending.pop()!
      if (visited.has(path)) continue
      const edges = imports.get(path)
      if (!edges)
        throw new Error("Bundle census references a missing emitted module.")
      visited.add(path)
      for (const edge of edges) {
        if (!edge.dynamic || includeDynamic) pending.push(edge.path)
      }
    }
    return visited
  }
  const initial = walk(false)
  const reachable = walk(true)
  const sizes = new Map(
    [...input.javascript].map(([path, bytes]) => [
      path,
      {
        bytes: bytes.byteLength,
        gzip9Bytes: gzipSync(bytes, { level: 9 }).byteLength,
      },
    ])
  )
  const sum = (paths: Iterable<string>) => {
    const result = { chunks: 0, bytes: 0, gzip9Bytes: 0 }
    for (const path of paths) {
      const size = sizes.get(path)!
      result.chunks++
      result.bytes += size.bytes
      result.gzip9Bytes += size.gzip9Bytes
    }
    return result
  }
  return {
    moduleEntriesAndPreloads: roots.size,
    initialStaticJavaScript: sum(initial),
    deferredLiteralImportJavaScript: sum(
      [...reachable].filter((path) => !initial.has(path))
    ),
    otherEmittedJavaScript: sum(
      [...input.javascript.keys()].filter((path) => !reachable.has(path))
    ),
    allEmittedJavaScript: sum(input.javascript.keys()),
  }
}

function readJavaScript(
  directory: string,
  root = directory,
  files = new Map<string, Uint8Array>()
) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) readJavaScript(path, root, files)
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      if (files.size >= MAX_CHUNKS)
        throw new Error("Bundle census exceeds its chunk budget.")
      const recordedBytes = [...files.values()].reduce(
        (total, bytes) => total + bytes.byteLength,
        0
      )
      if (recordedBytes + statSync(path).size > MAX_BYTES)
        throw new Error("Bundle census exceeds its byte budget.")
      files.set(relative(root, path).replaceAll("\\", "/"), readFileSync(path))
    }
  }
  return files
}

if (import.meta.main) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const apps = ["market", "merchant"].map((app) => {
    const directory = resolve(repository, "apps", app, "dist")
    const manifest = JSON.parse(
      readFileSync(
        resolve(directory, ".well-known/conduit-deployment.json"),
        "utf8"
      )
    ) as { deploymentProfile?: unknown }
    if (
      !["local", "preview", "production"].includes(
        String(manifest.deploymentProfile)
      )
    )
      throw new Error(
        "Bundle census requires an identified deployment profile."
      )
    return {
      app,
      deploymentProfile: manifest.deploymentProfile,
      ...measureEmittedCheckoutStartupBundle({
        indexHtml: readFileSync(resolve(directory, "index.html"), "utf8"),
        javascript: readJavaScript(directory),
      }),
    }
  })
  console.log(
    JSON.stringify(
      {
        measurement: "emitted-javascript-byte-census",
        compression: "sum-of-per-file-gzip-level-9",
        runtimeEvaluation: "not-sampled",
        deviceStartup: "not-sampled",
        networkRequests: 0,
        apps,
      },
      null,
      2
    )
  )
}
