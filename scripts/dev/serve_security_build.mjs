import { createServer } from "node:http"
import { URL } from "node:url"
import { readFileSync, existsSync, statSync } from "node:fs"
import { resolve, extname, sep } from "node:path"

// Test-only static serving of the actual build's Pages wildcard response headers.
// Cloudflare preview delivery is verified separately; this is not a Pages emulator.
for (const [app, port] of [
  ["market", 7100],
  ["merchant", 7101],
]) {
  const root = resolve(`apps/${app}/dist`)
  const lines = readFileSync(resolve(root, "_headers"), "utf8")
    .trim()
    .split("\n")
  if (lines.shift() !== "/*")
    throw new Error("Expected a wildcard build policy")
  const headers = Object.fromEntries(
    lines.map((line) => {
      const colon = line.indexOf(":")
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
    })
  )
  createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname
    let file = resolve(root, `.${pathname}`)
    if (!file.startsWith(root + sep) && file !== root) {
      response.writeHead(400).end()
      return
    }
    if (pathname === "/__security__/worker.js") {
      response
        .writeHead(200, { ...headers, "Content-Type": "text/javascript" })
        .end("postMessage(true)")
      return
    }
    if (pathname === "/__security__/capabilities.js") {
      response.writeHead(200, { ...headers, "Content-Type": "text/javascript" })
        .end(`
        window.__capabilities = { script: true, evalBlocked: false };
        try { new Function("return true")(); } catch { window.__capabilities.evalBlocked = true; }
        WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => window.__capabilities.wasm = true);
        const worker = new Worker("/__security__/worker.js");
        worker.onmessage = event => { window.__capabilities.worker = event.data; worker.terminate(); };
        import("/__security__/module.js").then(m => window.__capabilities.module = m.loaded);
      `)
      return
    }
    if (pathname === "/__security__/module.js") {
      response
        .writeHead(200, { ...headers, "Content-Type": "text/javascript" })
        .end("export const loaded = true")
      return
    }
    if (pathname === "/about" || pathname === "/about/")
      file = resolve(root, "about.html")
    if (!existsSync(file) || !statSync(file).isFile())
      file = resolve(root, "index.html")
    const type =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".png": "image/png",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
      }[extname(file)] || "application/octet-stream"
    response
      .writeHead(200, { ...headers, "Content-Type": type })
      .end(readFileSync(file))
  }).listen(port, "127.0.0.1")
}
