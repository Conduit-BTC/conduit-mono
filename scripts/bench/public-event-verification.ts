/** Local deterministic browser benchmark. Outputs aggregate metrics only. */
import { chromium, webkit } from "@playwright/test"
import { finalizeEvent, generateSecretKey } from "nostr-tools"
import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"

const root = process.cwd()
const baseline = process.argv[2]
if (!baseline) throw new Error("Pass the frozen baseline source directory")
const output = process.argv[3] ?? "/tmp/conduit-verification-benchmark"
await mkdir(output, { recursive: true })
const secret = generateSecretKey()
const fixturePath = join(output, "fixtures.json")
if (!(await Bun.file(fixturePath).exists())) {
  const fixtures = Array.from({ length: 10_000 }, (_, index) =>
    finalizeEvent(
      {
        kind: 30402,
        created_at: 123 + index,
        tags: [
          ["d", `fixture-${index}`],
          ["title", "Benchmark listing"],
          ["price", "10", "SAT"],
        ],
        content: "Synthetic product",
      },
      secret
    )
  )
  await Bun.write(fixturePath, JSON.stringify(fixtures))
}
const sources = { baseline, candidate: root }
const instrument = {
  name: "aggregate-crypto-counts",
  setup(build: any) {
    build.onLoad(
      { filter: /(?:verified-public-event|relay-reader)\.ts$/ },
      async ({ path }: { path: string }) => {
        let contents = await Bun.file(path).text()
        const parsed = ts.createSourceFile(
          path,
          contents,
          ts.ScriptTarget.Latest,
          true
        )
        const edits: { position: number; text: string }[] = []
        for (const statement of parsed.statements) {
          if (!ts.isFunctionDeclaration(statement) || !statement.body) continue
          const metric =
            statement.name?.text === "sameSignedPublicEvent"
              ? "equalityMs"
              : statement.name?.text === "snapshotSignedPublicEvent"
                ? "snapshotMs"
                : null
          if (!metric) continue
          edits.push({
            position: statement.body.getStart(parsed) + 1,
            text: `const metricStarted = performance.now(); try {`,
          })
          edits.push({
            position: statement.body.end - 1,
            text: `} finally { globalThis.__${metric} = (globalThis.__${metric} ?? 0) + performance.now() - metricStarted; }`,
          })
        }
        for (const edit of edits.sort((a, b) => b.position - a.position))
          contents =
            contents.slice(0, edit.position) +
            edit.text +
            contents.slice(edit.position)
        contents = contents.replace(
          "pendingVerify.set(reqId, pending)",
          "pending.queuedAt = performance.now(); pendingVerify.set(reqId, pending)"
        )
        contents = contents.replace(
          "worker.postMessage({ reqId, items: work })",
          "globalThis.__queueMs = (globalThis.__queueMs ?? 0) + performance.now() - pending.queuedAt; worker.postMessage({ reqId, items: work })"
        )
        return { contents, loader: "ts" }
      }
    )
    build.onLoad(
      { filter: /signed-event\.ts$/ },
      async ({ path }: { path: string }) => {
        let contents = await Bun.file(path).text()
        contents = contents.replace(
          "function computeEventId(event: SignedPublicNostrEvent): string {",
          "function computeEventId(event: SignedPublicNostrEvent): string { globalThis.__hashCount = (globalThis.__hashCount ?? 0) + 1;"
        )
        contents = contents
          .replace(
            /(const valid =|return) schnorr\.verify\(/g,
            "$1 (globalThis.__schnorrCount = (globalThis.__schnorrCount ?? 0) + 1, schnorr.verify("
          )
          .replace(
            /hexToBytes\(event.pubkey\)\n    \)/g,
            "hexToBytes(event.pubkey)\n    ))"
          )
        return { contents, loader: "ts" }
      }
    )
    build.onLoad(
      { filter: /verify-worker\.ts$/ },
      async ({ path }: { path: string }) => {
        let contents = await Bun.file(path).text()
        contents = contents.replace(
          "const { reqId, items } = event.data",
          "const { reqId, items } = event.data; globalThis.__hashCount = 0; globalThis.__schnorrCount = 0; const start = performance.now()"
        )
        contents = contents.replace(
          "ctx.postMessage({ reqId, valid })",
          "ctx.postMessage({ reqId, valid, metrics: { hash: globalThis.__hashCount, schnorr: globalThis.__schnorrCount, workerMs: performance.now() - start } })"
        )
        return { contents, loader: "ts" }
      }
    )
  },
}
for (const [name, source] of Object.entries(sources)) {
  const directory = join(output, name)
  await mkdir(directory, { recursive: true })
  const entry = join(directory, "entry.ts")
  await Bun.write(
    entry,
    `
import { verifySignedEvents, __resetPublicReaderTestState } from ${JSON.stringify(join(source, "packages/core/src/protocol/relay-reader.ts"))};
import { parseProductEvent } from ${JSON.stringify(join(source, "packages/core/src/protocol/products.ts"))};
const OriginalWorker = Worker;
let metrics;
globalThis.Worker = class extends OriginalWorker {
  constructor(...args) { super(...args); this.addEventListener('message', e => { if(e.data.metrics) { metrics.hash += e.data.metrics.hash; metrics.schnorr += e.data.metrics.schnorr; metrics.workerMs += e.data.metrics.workerMs; } }); }
  postMessage(message) { const start=performance.now(); super.postMessage(message); metrics.cloneMs += performance.now()-start; metrics.posts++; }
};
const tasks=[];
if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list=>tasks.push(...list.getEntries().map(x=>({start:x.startTime,duration:x.duration})))).observe({type:'longtask'});
globalThis.run = async (count, duplicateHeavy, mode) => {
  __resetPublicReaderTestState();
  let events = (await (await fetch('/fixtures.json')).json()).slice(0,count);
  if(duplicateHeavy) events = events.map((_,i)=>events[i % Math.max(1,count/10)]);
  const batches = input => Array.from({length:Math.ceil(input.length/256)},(_,i)=>input.slice(i*256,(i+1)*256));
  const admit = async input => { const result = await verifySignedEvents(input,{maxEvents:512}); return result.events; };
  if(mode !== 'cold' && mode !== 'concurrent') for(const batch of batches(events)) await admit(batch);
  metrics={hash:0,schnorr:0,workerMs:0,cloneMs:0,posts:0,parseCount:0}; globalThis.__hashCount=0;globalThis.__schnorrCount=0;globalThis.__queueMs=0;globalThis.__snapshotMs=0;globalThis.__equalityMs=0;
  if(mode==='restore') events=JSON.parse(JSON.stringify(events));
  const start=performance.now(); let firstPaintMs=null; let accepted=0;
  const consume = async batch => { const admitted = await admit(batch); accepted+=admitted.length; for(const event of admitted){ parseProductEvent(event); metrics.parseCount++; } if(firstPaintMs===null){document.body.textContent=admitted.slice(0,24).map(e=>e.content).join(' | ');await new Promise(requestAnimationFrame);firstPaintMs=performance.now()-start;} };
  if(mode==='concurrent') { for(const group of batches(events)) await Promise.all([consume(group),consume(JSON.parse(JSON.stringify(group)))]); }
  else for(const batch of batches(events)) await consume(batch);
  const settlementMs=performance.now()-start;await new Promise(r=>setTimeout(r,60));
  return {count,duplicateHeavy,mode,accepted,firstPaintMs,settlementMs,...metrics,queueMs:globalThis.__queueMs,snapshotMs:globalThis.__snapshotMs,equalityMs:globalThis.__equalityMs,mainHash:globalThis.__hashCount,mainSchnorr:globalThis.__schnorrCount,longTasks:tasks.filter(t=>t.start>=start).map(t=>t.duration),heapBytes:performance.memory?.usedJSHeapSize??null};
};`
  )
  for (const [input, file] of [
    [entry, "entry.js"],
    [
      join(source, "packages/core/src/protocol/verify-worker.ts"),
      "verify-worker.ts",
    ],
  ]) {
    const result = await Bun.build({
      entrypoints: [input],
      target: "browser",
      minify: true,
      define: { "import.meta.env": "{}" },
      plugins: [instrument],
    })
    if (!result.success) throw new Error(String(result.logs))
    await Bun.write(join(directory, file), result.outputs[0])
  }
}
const assets = join(root, "apps/market/dist/assets")
const workerFiles = (await readdir(assets)).filter((file) =>
  /^verify-worker-.*\.js$/.test(file)
)
if (workerFiles.length !== 1)
  throw new Error("Build Market before running the benchmark")
const productionWorker = join(assets, workerFiles[0]!)
const workerSmoke: { browser: string; artifact: string; valid: boolean[] }[] =
  []
const server = Bun.serve({
  port: 7019,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/fixtures.json") return new Response(Bun.file(fixturePath))
    if (path === "/worker-smoke")
      return new Response("<body>Production worker smoke</body>", {
        headers: { "content-type": "text/html" },
      })
    if (path === "/production-worker.js")
      return new Response(Bun.file(productionWorker), {
        headers: { "content-type": "text/javascript" },
      })
    if (
      [
        "/baseline/entry.js",
        "/candidate/entry.js",
        "/baseline/verify-worker.ts",
        "/candidate/verify-worker.ts",
      ].includes(path)
    )
      return new Response(Bun.file(join(output, path)), {
        headers: { "content-type": "text/javascript" },
      })
    return new Response(
      '<body>Verification benchmark</body><script type="module" src="./entry.js"></script>',
      { headers: { "content-type": "text/html" } }
    )
  },
})
const rows = []
try {
  for (const [browserName, engine] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await engine.launch({ headless: true })
    try {
      const smokePage = await browser.newPage()
      await smokePage.goto("http://127.0.0.1:7019/worker-smoke")
      const valid = await smokePage.evaluate(async () => {
        const [event] = await (await fetch("/fixtures.json")).json()
        const worker = new Worker("/production-worker.js", { type: "module" })
        try {
          return await new Promise<boolean[]>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("production worker timeout")),
              8000
            )
            worker.onmessage = ({ data }) => {
              clearTimeout(timer)
              if (data.reqId !== 73)
                reject(new Error("production worker correlation failure"))
              else resolve(data.valid)
            }
            worker.onerror = () => {
              clearTimeout(timer)
              reject(new Error("production worker failed"))
            }
            worker.postMessage({
              reqId: 73,
              items: [
                event,
                { ...event, content: "tampered" },
                { ...event, id: "0".repeat(64) },
                { ...event, sig: "0".repeat(128) },
              ],
            })
          })
        } finally {
          worker.terminate()
        }
      })
      if (JSON.stringify(valid) !== "[true,false,false,false]")
        throw new Error("production worker accepted invalid bytes")
      workerSmoke.push({
        browser: browserName,
        artifact: workerFiles[0]!,
        valid,
      })
      await Bun.write(
        join(output, "production-worker-smoke.json"),
        JSON.stringify(workerSmoke, null, 2)
      )
      await smokePage.close()
      for (const name of Object.keys(sources)) {
        const page = await browser.newPage()
        const heapSession =
          browserName === "chromium"
            ? await page.context().newCDPSession(page)
            : null
        page.on("pageerror", (error) => console.error(error.message))
        await page.goto(`http://127.0.0.1:7019/${name}/`)
        await page.waitForFunction(
          () => typeof (globalThis as any).run === "function"
        )
        const sizes = [1000, 5000, 10000]
        for (const count of sizes)
          for (const duplicateHeavy of [false, true])
            for (const mode of ["cold", "warm", "concurrent", "restore"]) {
              const row = await page.evaluate(
                async ({ count, duplicateHeavy, mode }) =>
                  (globalThis as any).run(count, duplicateHeavy, mode),
                { count, duplicateHeavy, mode }
              )
              const usedHeap = heapSession
                ? await heapSession.send("Runtime.getHeapUsage")
                : null
              if (heapSession)
                await heapSession.send("HeapProfiler.collectGarbage")
              const retainedHeap = heapSession
                ? await heapSession.send("Runtime.getHeapUsage")
                : null
              row.preciseHeapUsedBytes = usedHeap?.usedSize ?? null
              row.retainedHeapBytes = retainedHeap?.usedSize ?? null
              const expectedCrypto =
                mode === "warm" || mode === "restore"
                  ? 0
                  : count / (duplicateHeavy ? 10 : 1)
              if (
                row.hash !== expectedCrypto ||
                row.schnorr !== expectedCrypto ||
                row.mainHash !== 0 ||
                row.mainSchnorr !== 0
              )
                throw new Error("Unexpected cryptographic work count")
              if (
                row.accepted !== count * (mode === "concurrent" ? 2 : 1) ||
                row.parseCount !== row.accepted
              )
                throw new Error("Unequal benchmark workload")
              rows.push({ browser: browserName, source: name, ...row })
              await Bun.write(
                join(output, "results.json"),
                JSON.stringify(rows, null, 2)
              )
              console.log(
                JSON.stringify({
                  browser: browserName,
                  source: name,
                  count,
                  duplicateHeavy,
                  mode,
                  settlementMs: Math.round(row.settlementMs),
                  hash: row.hash,
                  schnorr: row.schnorr,
                })
              )
            }
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }
} finally {
  server.stop()
}
