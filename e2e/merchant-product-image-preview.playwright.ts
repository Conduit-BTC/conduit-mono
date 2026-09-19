import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  installTestSigner,
  publishTestRelayEvents,
  readTestRelayEvents,
  seedTestRelayIdentity,
} from "./helpers/auth"

const merchantUrl =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
const configuredServer = "https://media.conduit.market"
const fallbackServer = "https://blossom.nostr.build"
const image192 = join(
  process.cwd(),
  "apps/merchant/public/merchant-icon-192.png"
)
const image512 = join(
  process.cwd(),
  "apps/merchant/public/merchant-icon-512.png"
)
const metadataSentinel = "CONDUIT_PRIVATE_IMAGE_METADATA"

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngWithMetadataSentinel(): Buffer {
  const png = readFileSync(image192)
  const iendOffset = png.lastIndexOf(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68]))
  if (iendOffset < 0) throw new Error("PNG fixture is missing IEND")
  const type = Buffer.from("tEXt")
  const data = Buffer.from(`Comment\0${metadataSentinel}`, "utf8")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
  const chunk = Buffer.concat([length, type, data, checksum])
  return Buffer.concat([
    png.subarray(0, iendOffset),
    chunk,
    png.subarray(iendOffset),
  ])
}

interface InterceptedBlossomState {
  putCount: number
  peakInFlight: number
  originalBodyObserved: boolean
  metadataSentinelObserved: boolean
  redirectTargetRequests: number
  requestHashes: string[]
  resourceUrls: string[]
}

interface ObjectUrlAudit {
  created: Array<{
    url: string
    fileName: string | null
    size: number
    type: string
  }>
  revoked: string[]
}

interface RedirectServer {
  url: string
  readonly requestCount: number
  close: () => Promise<void>
}

async function startRedirectServer(location: string): Promise<RedirectServer> {
  const directory = mkdtempSync(join(tmpdir(), "conduit-image-redirect-"))
  const keyPath = join(directory, "key.pem")
  const certificatePath = join(directory, "certificate.pem")
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" }
  )

  let requestCount = 0
  const server = createServer(
    {
      key: readFileSync(keyPath),
      cert: readFileSync(certificatePath),
    },
    (_request, response) => {
      requestCount += 1
      response.writeHead(307, {
        "access-control-allow-origin": "*",
        location,
      })
      response.end()
    }
  )
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    rmSync(directory, { recursive: true, force: true })
    throw new Error("Redirect test server did not bind to a TCP port")
  }

  return {
    url: `https://127.0.0.1:${address.port}`,
    get requestCount() {
      return requestCount
    },
    close: async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error)
            else resolve()
          })
        })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

async function installObjectUrlAudit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const browserWindow = window as unknown as {
      __conduitObjectUrlAudit?: ObjectUrlAudit
    }
    const audit: ObjectUrlAudit = { created: [], revoked: [] }
    browserWindow.__conduitObjectUrlAudit = audit
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL)
    const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource): string => {
      const url = originalCreateObjectUrl(object)
      audit.created.push({
        url,
        fileName: object instanceof File ? object.name : null,
        size: object instanceof Blob ? object.size : 0,
        type: object instanceof Blob ? object.type : "",
      })
      return url
    }
    URL.revokeObjectURL = (url: string): void => {
      audit.revoked.push(url)
      originalRevokeObjectUrl(url)
    }
  })
}

async function readObjectUrlAudit(page: Page): Promise<ObjectUrlAudit> {
  return page.evaluate(() => {
    const browserWindow = window as unknown as {
      __conduitObjectUrlAudit?: ObjectUrlAudit
    }
    return structuredClone(
      browserWindow.__conduitObjectUrlAudit ?? { created: [], revoked: [] }
    )
  })
}

async function interceptBlossom(
  page: Page,
  serverUrl: string,
  options: {
    abortFirstOnce?: boolean
    failSecondOnce?: boolean
    rejectFirstStatus?: number
    originalHashes?: ReadonlySet<string>
    metadataSentinel?: string
    resourceRedirectUrl?: string
    resourceRedirectProxyUrl?: string
  } = {}
): Promise<InterceptedBlossomState> {
  const state: InterceptedBlossomState = {
    putCount: 0,
    peakInFlight: 0,
    originalBodyObserved: false,
    metadataSentinelObserved: false,
    redirectTargetRequests: 0,
    requestHashes: [],
    resourceUrls: [],
  }
  const resources = new Map<string, { body: Buffer; type: string }>()
  let inFlight = 0

  await page.addInitScript((targetServer) => {
    const browserWindow = window as unknown as {
      __conduitPreparedUploadBodies?: Record<string, number[]>
    }
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (
        url.startsWith(`${targetServer}/`) &&
        init?.method === "PUT" &&
        init.body instanceof Blob
      ) {
        const hash = new Headers(init.headers).get("x-sha-256")
        if (hash) {
          const bytes = new Uint8Array(await init.body.arrayBuffer())
          browserWindow.__conduitPreparedUploadBodies ??= {}
          browserWindow.__conduitPreparedUploadBodies[hash] = Array.from(bytes)
        }
      }
      return originalFetch(input, init)
    }
  }, serverUrl)

  if (options.resourceRedirectUrl) {
    await page.route(options.resourceRedirectUrl, async (route) => {
      state.redirectTargetRequests += 1
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: { "access-control-allow-origin": "*" },
        body: Buffer.from([1, 2, 3, 4]),
      })
    })
  }

  await page.route(`${serverUrl}/**`, async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "PUT, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, x-sha-256",
        },
      })
      return
    }
    if (request.method() !== "PUT") {
      await route.fulfill({ status: 405 })
      return
    }
    state.putCount += 1
    const requestedHash = request.headers()["x-sha-256"]
    if (requestedHash) state.requestHashes.push(requestedHash)
    inFlight += 1
    state.peakInFlight = Math.max(state.peakInFlight, inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (options.rejectFirstStatus && state.putCount === 1) {
        await route.fulfill({
          status: options.rejectFirstStatus,
          headers: { "access-control-allow-origin": "*" },
        })
        return
      }
      if (options.abortFirstOnce && state.putCount === 1) {
        await route.abort("timedout")
        return
      }
      if (options.failSecondOnce && state.putCount === 2) {
        await route.fulfill({
          status: 429,
          headers: { "access-control-allow-origin": "*" },
        })
        return
      }
      let body = request.postDataBuffer()
      if (!body) {
        const expectedHash = request.headers()["x-sha-256"]
        const captured = expectedHash
          ? await page.evaluate((hash) => {
              const browserWindow = window as unknown as {
                __conduitPreparedUploadBodies?: Record<string, number[]>
              }
              return browserWindow.__conduitPreparedUploadBodies?.[hash]
            }, expectedHash)
          : undefined
        if (captured) body = Buffer.from(captured)
      }
      if (!body) throw new Error("Expected prepared upload bytes")
      const hash = createHash("sha256").update(body).digest("hex")
      if (options.originalHashes?.has(hash)) state.originalBodyObserved = true
      if (
        options.metadataSentinel &&
        body.includes(Buffer.from(options.metadataSentinel, "utf8"))
      ) {
        state.metadataSentinelObserved = true
      }
      const type = request.headers()["content-type"] ?? "image/png"
      const resourceUrl = `https://cdn.conduit.market/${hash}.png`
      resources.set(resourceUrl, { body, type })
      state.resourceUrls.push(resourceUrl)
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          url: resourceUrl,
          sha256: hash,
          size: body.byteLength,
          type,
          uploaded: Math.floor(Date.now() / 1_000),
        }),
      })
    } finally {
      inFlight -= 1
    }
  })

  await page.route("https://cdn.conduit.market/**", async (route) => {
    const resource = resources.get(route.request().url())
    if (!resource) {
      await route.fulfill({ status: 404 })
      return
    }
    if (options.resourceRedirectUrl) {
      if (!options.resourceRedirectProxyUrl) {
        throw new Error("Redirect interception requires a proxy URL")
      }
      const sourceUrl = new URL(route.request().url())
      const proxyUrl = new URL(
        `${sourceUrl.pathname}${sourceUrl.search}`,
        options.resourceRedirectProxyUrl
      )
      await route.continue({
        url: proxyUrl.href,
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: resource.type,
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(resource.body.byteLength),
      },
      body: resource.body,
    })
  })
  return state
}

async function openProductDialogWithSigner(
  page: Page,
  options: { configuredServerUrl?: string } = {}
) {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  await installTestSigner(page, pubkey, { secretKey })
  if (options.configuredServerUrl) {
    await publishTestRelayEvents([
      finalizeEvent(
        {
          kind: 10_063,
          created_at: Math.floor(Date.now() / 1_000) + 1,
          tags: [["server", options.configuredServerUrl]],
          content: "",
        },
        secretKey
      ),
    ])
  }
  await page.goto(`${merchantUrl}/products`)
  await page.getByRole("button", { name: "Add product" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(dialog).toBeVisible()
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      nostr: {
        signEvent: (
          event: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      }
      __conduitSignedKinds?: number[]
    }
    browserWindow.__conduitSignedKinds = []
    const original = browserWindow.nostr.signEvent.bind(browserWindow.nostr)
    browserWindow.nostr.signEvent = async (event) => {
      browserWindow.__conduitSignedKinds!.push(Number(event.kind))
      return original(event)
    }
  })
  return { dialog, pubkey }
}

test("loaded product preview stays visible while its title changes @merchant", async ({
  page,
}) => {
  const pubkey = getPublicKey(generateSecretKey())
  const imageUrl = "https://cdn.jsdelivr.net/cover.svg"
  await installTestSigner(page, pubkey)
  await page.route(imageUrl, (route) =>
    route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#8b5cf6"/></svg>',
      contentType: "image/svg+xml",
    })
  )
  await page.goto(`${merchantUrl}/products`)

  await page.getByRole("button", { name: "Add product" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await dialog.getByLabel("Title").fill("Original title")
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog.getByLabel("Primary image URL").fill(`  ${imageUrl}  `)

  const previewImage = dialog.locator(`img[src="${imageUrl}"]`)
  await expect(previewImage).toHaveClass(/opacity-100/)
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await expect(dialog.getByLabel("Image 2 URL")).toBeFocused()
  await dialog.getByLabel("Title").fill("Updated title")

  await expect(previewImage).toHaveAttribute("alt", "Updated title")
  await expect(previewImage).toHaveClass(/opacity-100/)
})

test("configured Blossom uploads stay sequential and retry only unfinished images @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const metadataImage = pngWithMetadataSentinel()
  const state = await interceptBlossom(page, configuredServer, {
    failSecondOnce: true,
    metadataSentinel,
    originalHashes: new Set(
      [metadataImage, readFileSync(image512)].map((bytes) =>
        createHash("sha256").update(bytes).digest("hex")
      )
    ),
  })
  let fallbackRequests = 0
  await page.route(`${fallbackServer}/**`, async (route) => {
    fallbackRequests += 1
    await route.abort()
  })
  const { dialog, pubkey } = await openProductDialogWithSigner(page, {
    configuredServerUrl: configuredServer,
  })
  await expect(
    dialog.getByText("your first configured media server", { exact: false })
  ).toBeVisible()

  await dialog.locator("#product-image-file").setInputFiles([
    {
      name: "merchant-icon-with-private-metadata.png",
      mimeType: "image/png",
      buffer: metadataImage,
    },
    {
      name: "merchant-icon-512.png",
      mimeType: "image/png",
      buffer: readFileSync(image512),
    },
  ])

  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  await expect(
    dialog.getByText("This media server is rate limiting uploads.", {
      exact: false,
    })
  ).toBeVisible()
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    state.resourceUrls[0]!
  )
  expect(state.putCount).toBe(2)
  expect(state.peakInFlight).toBe(1)
  expect(state.originalBodyObserved).toBe(false)
  expect(state.metadataSentinelObserved).toBe(false)
  expect(fallbackRequests).toBe(0)

  await dialog
    .getByRole("button", { name: "Retry image 2 upload", exact: true })
    .click()
  await expect(dialog.getByLabel("Image 2 URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  expect(state.putCount).toBe(3)
  expect(state.peakInFlight).toBe(1)
  expect(fallbackRequests).toBe(0)
  const pastedImageUrl =
    "https://cdn.jsdelivr.net/conduit-test/pasted-third-image.png"
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog.getByLabel("Image 3 URL").fill(pastedImageUrl)
  await dialog.getByLabel("Title").fill("Verified Blossom pair")
  await dialog.getByLabel("Price").fill("42")
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital" }).click()
  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["blossom", "verified", "images"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  const baseResourceUrls = [...state.resourceUrls]
  await dialog
    .getByRole("checkbox", { name: /This product has options/ })
    .check()
  await dialog.getByLabel("Option name", { exact: true }).fill("Color")
  await dialog.getByLabel("Values", { exact: true }).fill("Red")
  await dialog.getByRole("button", { name: "Make all available" }).click()
  const variationImagesHeading = dialog.getByText("Variation images", {
    exact: true,
  })
  await variationImagesHeading
    .locator("xpath=following-sibling::label")
    .getByRole("checkbox", { name: "Base" })
    .uncheck()
  await dialog
    .locator("#product-variation-images-0-file")
    .setInputFiles(image192)
  await expect(dialog.locator("#product-variation-images-0-0")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  expect(state.putCount).toBe(4)
  const variationResourceUrl = state.resourceUrls.at(-1)!
  const publish = dialog.getByRole("button", { name: "Publish product" })
  await expect(publish).toBeEnabled()
  await publish.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __conduitSignedKinds?: number[] })
          .__conduitSignedKinds
    )
  ).toEqual([24242, 24242, 24242, 24242, 30402, 30402])
  await expect
    .poll(async () => {
      const events = await readTestRelayEvents({
        kinds: [30_402],
        authors: [pubkey],
      })
      return events
        .find((event) =>
          event.tags.some(
            ([name, value]) =>
              name === "title" && value === "Verified Blossom pair"
          )
        )
        ?.tags.filter(([name]) => name === "image")
        .map(([, value]) => value)
    })
    .toEqual([...baseResourceUrls, pastedImageUrl])
  await expect
    .poll(async () => {
      const events = await readTestRelayEvents({
        kinds: [30_402],
        authors: [pubkey],
      })
      return events
        .find((event) =>
          event.tags.some(
            ([name, value]) => name === "type" && value === "variation"
          )
        )
        ?.tags.filter(([name]) => name === "image")
        .map(([, value]) => value)
    })
    .toEqual([variationResourceUrl])
})

test.describe("resource redirect verification", () => {
  test.use({ ignoreHTTPSErrors: true })

  test("verification redirects never reach private destinations @merchant", async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const privateUrl = "https://127.0.0.1/private-product-image.png"
    const redirectServer = await startRedirectServer(privateUrl)
    try {
      const state = await interceptBlossom(page, configuredServer, {
        resourceRedirectUrl: privateUrl,
        resourceRedirectProxyUrl: redirectServer.url,
      })
      const { dialog } = await openProductDialogWithSigner(page, {
        configuredServerUrl: configuredServer,
      })
      await expect(
        dialog.getByText("your first configured media server", { exact: false })
      ).toBeVisible()

      await dialog.locator("#product-image-file").setInputFiles(image192)

      await expect(
        dialog.getByText("The uploaded image could not be retrieved", {
          exact: false,
        })
      ).toBeVisible()
      expect(state.putCount).toBe(1)
      expect(redirectServer.requestCount).toBe(1)
      expect(state.redirectTargetRequests).toBe(0)
      await expect(dialog.getByLabel("Primary image URL")).toHaveCount(0)
    } finally {
      await redirectServer.close()
    }
  })
})

test("fallback upload is disclosed, intercepted, and mobile responsive @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await installObjectUrlAudit(page)
  const state = await interceptBlossom(page, fallbackServer, {
    originalHashes: new Set([
      createHash("sha256").update(readFileSync(image192)).digest("hex"),
    ]),
  })
  const { dialog } = await openProductDialogWithSigner(page)
  await expect(
    dialog.getByText("No safe media server is configured.", { exact: false })
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    dialog.getByRole("link", { name: "Blossom service" })
  ).toHaveAttribute("href", "https://blossom.nostr.build/")
  await expect(dialog.getByRole("link", { name: "plans" })).toHaveAttribute(
    "href",
    "https://account.nostr.build/plans"
  )
  await expect(
    dialog.getByRole("link", { name: "Terms of Service" })
  ).toHaveAttribute("href", "https://account.nostr.build/tos")
  await expect(
    dialog.getByRole("link", { name: "Privacy Policy" })
  ).toHaveAttribute("href", "https://account.nostr.build/privacy")

  await dialog.locator("#product-image-file").setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a valid image"),
  })
  await expect(
    dialog.getByText("Conduit could not read that image on this device.", {
      exact: true,
    })
  ).toBeVisible()
  expect((await readObjectUrlAudit(page)).created).toHaveLength(0)
  expect(state.putCount).toBe(0)
  await dialog
    .getByRole("button", { name: "Remove unfinished image 1", exact: true })
    .click()
  await expect(
    dialog.getByRole("button", { name: "Add another image", exact: true })
  ).toBeEnabled()

  await dialog.locator("#product-image-file").setInputFiles(image192)
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  const objectUrlAudit = await readObjectUrlAudit(page)
  expect(objectUrlAudit.created).toHaveLength(1)
  expect(objectUrlAudit.created[0]?.fileName).toBeNull()
  expect(objectUrlAudit.created[0]?.size).toBeGreaterThan(0)
  expect(objectUrlAudit.revoked).toEqual([objectUrlAudit.created[0]?.url])
  expect(state.putCount).toBe(1)
  expect(state.originalBodyObserved).toBe(false)
  await expect(
    dialog.getByRole("button", { name: "Add another image", exact: true })
  ).toBeDisabled()

  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog
    .getByLabel("Image 2 URL")
    .fill("https://cdn.jsdelivr.net/second-product-image.png")
  expect(state.putCount).toBe(1)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    )
  ).toBe(true)
  const dialogBox = await dialog.boundingBox()
  expect(dialogBox?.x ?? -1).toBeGreaterThanOrEqual(0)
  expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(390)
  const addByUrlBox = await dialog
    .getByRole("button", { name: "Add by URL" })
    .boundingBox()
  expect(addByUrlBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __conduitSignedKinds?: number[] })
          .__conduitSignedKinds
    )
  ).toEqual([24242])

  await dialog.locator("form").getByRole("button", { name: "Close" }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "Add product" }).first().click()
  const resumedDialog = page.getByRole("dialog", { name: "Add product" })
  await expect(
    resumedDialog.getByRole("button", {
      name: "Add another image",
      exact: true,
    })
  ).toBeDisabled()

  page.once("dialog", (confirmation) => confirmation.accept())
  await resumedDialog.getByRole("button", { name: "Discard changes" }).click()
  await expect(resumedDialog).toBeHidden()
  await page.getByRole("button", { name: "Add product" }).first().click()
  const freshDialog = page.getByRole("dialog", { name: "Add product" })
  await expect(
    freshDialog.getByRole("button", {
      name: "Add another image",
      exact: true,
    })
  ).toBeEnabled()
  await freshDialog.locator("#product-image-file").setInputFiles(image512)
  await expect(freshDialog.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  await freshDialog.getByLabel("Title").fill("Fallback image listing")
  await freshDialog.getByLabel("Price").fill("7")
  await freshDialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital" }).click()
  const tags = freshDialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["fallback", "storage", "guardrail"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  await freshDialog
    .getByRole("button", { name: "Publish product", exact: true })
    .click()
  await expect(freshDialog).toBeHidden({ timeout: 15_000 })
  await expect(
    page.getByText("Fallback image listing", { exact: true }).first()
  ).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Edit", exact: true }).first().click()
  const editDialog = page.getByRole("dialog", { name: "Edit listing" })
  await expect(editDialog).toBeVisible()
  await expect(
    editDialog.getByRole("button", {
      name: "Add another image",
      exact: true,
    })
  ).toBeDisabled()
  expect(state.putCount).toBe(2)
})

test("fallback destination persistence fails before signing and survives draft recovery @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.addInitScript(
    ({ allowKey, claimPrefix }) => {
      const originalSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (
          key.startsWith(claimPrefix) &&
          key.includes("product%3A30402%3A") &&
          this.getItem(allowKey) !== "1"
        ) {
          throw new DOMException(
            "Synthetic destination storage rejection",
            "QuotaExceededError"
          )
        }
        return originalSetItem.call(this, key, value)
      }
    },
    {
      allowKey: "conduit:test:allow-fallback-destination",
      claimPrefix: "conduit:merchant:product_image_fallback:v1",
    }
  )
  const state = await interceptBlossom(page, fallbackServer)
  const { dialog } = await openProductDialogWithSigner(page)
  await expect(
    dialog.getByText("No safe media server is configured.", { exact: false })
  ).toBeVisible()
  await dialog.locator("#product-image-file").setInputFiles(image192)
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  await dialog.getByLabel("Title").fill("Destination-guarded fallback")
  await dialog.getByLabel("Price").fill("7")
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital" }).click()
  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["fallback", "destination", "guardrail"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }

  await dialog
    .getByRole("button", { name: "Publish product", exact: true })
    .click()
  await expect(
    dialog.getByText(
      "The public fallback could not preserve retry safety on this device.",
      { exact: false }
    )
  ).toBeVisible()
  await expect(dialog).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __conduitSignedKinds?: number[] })
          .__conduitSignedKinds
    )
  ).toEqual([24242])
  expect(state.putCount).toBe(1)

  await page.reload()
  const resumeButton = page.getByRole("button", {
    name: "Resume product draft",
  })
  await expect(resumeButton).toBeVisible()
  await resumeButton.click()
  const resumed = page.getByRole("dialog", { name: "Add product" })
  await expect(resumed.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  await expect(
    resumed.getByRole("button", { name: "Add another image", exact: true })
  ).toBeDisabled()
  await resumed.getByLabel("Title").fill("Recovered destination guard")
  await page.evaluate(
    (allowKey) => localStorage.setItem(allowKey, "1"),
    "conduit:test:allow-fallback-destination"
  )
  await resumed
    .getByRole("button", { name: "Publish product", exact: true })
    .click()
  const inboxReady = page.getByRole("heading", {
    name: "Private inbox ready",
    exact: true,
  })
  const publishedListing = page
    .getByText("Recovered destination guard", { exact: true })
    .first()
  await expect(inboxReady.or(publishedListing)).toBeVisible({
    timeout: 15_000,
  })
  if (await inboxReady.isVisible()) {
    await page
      .getByRole("button", { name: "Publish product", exact: true })
      .last()
      .click()
  }
  await expect(resumed).toBeHidden({ timeout: 15_000 })
  await expect(publishedListing).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Edit", exact: true }).first().click()
  const editDialog = page.getByRole("dialog", { name: "Edit listing" })
  await expect(editDialog).toBeVisible()
  await expect(
    editDialog.getByRole("button", {
      name: "Add another image",
      exact: true,
    })
  ).toBeDisabled()
  expect(state.putCount).toBe(1)
})

test("fallback rejection clears the durable claim across reload @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const state = await interceptBlossom(page, fallbackServer, {
    rejectFirstStatus: 429,
  })
  const { dialog } = await openProductDialogWithSigner(page)
  await expect(
    dialog.getByText("No safe media server is configured.", { exact: false })
  ).toBeVisible()
  await dialog.getByLabel("Title").fill("Rejected fallback draft")
  await dialog.locator("#product-image-file").setInputFiles(image192)
  await expect(
    dialog.getByText("This media server is rate limiting uploads.", {
      exact: false,
    })
  ).toBeVisible()
  expect(state.putCount).toBe(1)

  await dialog.locator("form").getByRole("button", { name: "Close" }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  await page.getByRole("button", { name: "Add product" }).first().click()
  const resumed = page.getByRole("dialog", { name: "Add product" })
  await expect(
    resumed.getByRole("button", { name: "Add another image", exact: true })
  ).toBeEnabled()
  await resumed.locator("#product-image-file").setInputFiles(image512)
  await expect(resumed.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  expect(state.putCount).toBe(2)
})

test("ambiguous fallback retries only the same prepared hash after reload @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const state = await interceptBlossom(page, fallbackServer, {
    abortFirstOnce: true,
  })
  const { dialog } = await openProductDialogWithSigner(page)
  await expect(
    dialog.getByText("No safe media server is configured.", { exact: false })
  ).toBeVisible()
  await dialog.getByLabel("Title").fill("Ambiguous fallback draft")
  await dialog.locator("#product-image-file").setInputFiles(image192)
  await expect(
    dialog.getByText("The upload did not finish. Retry this image.", {
      exact: true,
    })
  ).toBeVisible()
  expect(state.putCount).toBe(1)

  await dialog.locator("form").getByRole("button", { name: "Close" }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  await page.getByRole("button", { name: "Add product" }).first().click()
  const resumed = page.getByRole("dialog", { name: "Add product" })
  await expect(
    resumed.getByText("Choose the same image to retry", { exact: false })
  ).toBeVisible()
  await expect(
    resumed.getByRole("button", { name: "Add another image", exact: true })
  ).toBeEnabled()

  await resumed.locator("#product-image-file").setInputFiles(image512)
  await expect(
    resumed.getByText("Choose the same image you previously tried to upload.", {
      exact: false,
    })
  ).toBeVisible()
  expect(state.putCount).toBe(1)
  await resumed
    .getByRole("button", { name: "Remove unfinished image 1", exact: true })
    .click()
  await expect(
    resumed.getByRole("button", { name: "Add another image", exact: true })
  ).toBeEnabled()

  await resumed.locator("#product-image-file").setInputFiles(image192)
  await expect(resumed.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  expect(state.putCount).toBe(2)
  expect(state.requestHashes[1]).toBe(state.requestHashes[0])
})

test("fallback refuses PUT when its durable guard cannot be confirmed @merchant", async ({
  page,
}) => {
  await page.addInitScript((claimPrefix) => {
    const originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(claimPrefix)) {
        throw new DOMException(
          "Synthetic storage rejection",
          "QuotaExceededError"
        )
      }
      return originalSetItem.call(this, key, value)
    }
  }, "conduit:merchant:product_image_fallback:v1")
  const state = await interceptBlossom(page, fallbackServer)
  const { dialog } = await openProductDialogWithSigner(page)
  await expect(
    dialog.getByText("No safe media server is configured.", { exact: false })
  ).toBeVisible()
  await dialog.locator("#product-image-file").setInputFiles(image192)
  await expect(
    dialog.getByText(
      "The public fallback could not preserve retry safety on this device.",
      { exact: false }
    )
  ).toBeVisible()
  expect(state.putCount).toBe(0)
})

test("a corrupt fallback claim fails closed without sending a file @merchant", async ({
  page,
}) => {
  await page.addInitScript((claimPrefix) => {
    const originalGetItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) {
      if (key.startsWith(claimPrefix)) return ""
      return originalGetItem.call(this, key)
    }
  }, "conduit:merchant:product_image_fallback:v1")
  const state = await interceptBlossom(page, fallbackServer)
  const { dialog } = await openProductDialogWithSigner(page)
  await expect(
    dialog.getByText("No safe media server is configured.", { exact: false })
  ).toBeVisible()
  await expect(
    dialog.getByRole("button", { name: "Add another image", exact: true })
  ).toBeDisabled()
  expect(state.putCount).toBe(0)
})
