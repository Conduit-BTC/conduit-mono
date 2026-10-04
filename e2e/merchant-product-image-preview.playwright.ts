import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
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
import { interceptBlossom } from "./helpers/blossom"

const merchantUrl =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
const configuredServer = "https://media.conduit.market"
const fallbackServer = "https://blossom.ditto.pub"
const fallbackDisclosureText = "You’re using shared public media hosting."
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

interface ObjectUrlAudit {
  created: Array<{
    url: string
    fileName: string | null
    size: number
    type: string
  }>
  revoked: string[]
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

async function openProductDialogWithSigner(
  page: Page,
  options: {
    configuredServerUrl?: string
    configuredServerUrls?: string[]
  } = {}
) {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  const configuredCreatedAt = Math.floor(Date.now() / 1_000) + 1
  await seedTestRelayIdentity(secretKey)
  await installTestSigner(page, pubkey, { secretKey })
  if (options.configuredServerUrl || options.configuredServerUrls) {
    await publishTestRelayEvents([
      finalizeEvent(
        {
          kind: 10_063,
          created_at: configuredCreatedAt,
          tags: (
            options.configuredServerUrls ?? [options.configuredServerUrl!]
          ).map((url) => ["server", url]),
          content: "",
        },
        secretKey
      ),
    ])
  }
  await page.goto(`${merchantUrl}/products`)
  // Each fixture owns a fresh empty catalog. Let its initial reads settle
  // before opening the dialog so mobile layout changes cannot race the click.
  await expect(page.getByText("No listings yet", { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  const addProduct = page.getByRole("button", { name: "Add product" }).first()
  await expect(addProduct).toBeEnabled({ timeout: 20_000 })
  await addProduct.click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
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
  return { configuredCreatedAt, dialog, pubkey, secretKey }
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
    dialog.getByText("your configured media servers", { exact: false })
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
  await page.route(pastedImageUrl, (route) =>
    route.fulfill({
      contentType: "image/png",
      body: readFileSync(image192),
    })
  )
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog.getByLabel("Image 3 URL").fill(pastedImageUrl)
  const baseResourceUrls = [...state.resourceUrls]
  await dialog
    .getByRole("button", { name: "Move image 3 up", exact: true })
    .click()
  await dialog
    .getByRole("button", { name: "Move image 2 up", exact: true })
    .click()
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    pastedImageUrl
  )
  await expect(dialog.getByLabel("Image 2 URL")).toHaveValue(
    baseResourceUrls[0]!
  )
  await expect(dialog.getByLabel("Image 3 URL")).toHaveValue(
    baseResourceUrls[1]!
  )
  await expect(dialog.locator(`img[src="${pastedImageUrl}"]`)).toBeVisible()
  await dialog.getByLabel("Title").fill("Verified Blossom pair")
  await dialog.getByLabel("Price").fill("42")
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital" }).click()
  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["blossom", "verified", "images"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
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
    .toEqual([pastedImageUrl, ...baseResourceUrls])
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

test("a late successful retry preserves the established cover order @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const state = await interceptBlossom(page, configuredServer, {
    rejectFirstStatus: 429,
  })
  const pastedImageUrl =
    "https://cdn.jsdelivr.net/conduit-test/established-cover.png"
  await page.route(pastedImageUrl, (route) =>
    route.fulfill({
      contentType: "image/png",
      body: readFileSync(image192),
    })
  )
  const { dialog } = await openProductDialogWithSigner(page, {
    configuredServerUrl: configuredServer,
  })

  await expect(
    dialog.getByRole("button", { name: "Add image", exact: true })
  ).toBeEnabled()
  await dialog.locator("#product-image-file").setInputFiles(image192)
  await expect(
    dialog.getByText("This media server is rate limiting uploads.", {
      exact: false,
    })
  ).toBeVisible()
  await expect(
    dialog.getByRole("button", { name: "Add image", exact: true })
  ).toBeEnabled()
  await expect(
    dialog.getByRole("button", { name: "Move unfinished image 1 up" })
  ).toHaveCount(0)

  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog.getByLabel("Primary image URL").fill(pastedImageUrl)
  await expect(
    dialog.getByRole("button", { name: "Add another image", exact: true })
  ).toBeEnabled()
  await dialog
    .getByRole("button", { name: "Retry image 1 upload", exact: true })
    .click()

  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    pastedImageUrl
  )
  await expect(dialog.getByLabel("Image 2 URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  await expect(dialog.locator(`img[src="${pastedImageUrl}"]`)).toBeVisible()
  expect(await dialog.getByLabel("Image 2 URL").inputValue()).toBe(
    state.resourceUrls[0]
  )
  expect(state.putCount).toBe(2)
})

test("a newer signed media-server revision stops a pending upload before PUT @merchant", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const replacementServer = "https://media-next.conduit.market"
  const originalState = await interceptBlossom(page, configuredServer)
  const replacementState = await interceptBlossom(page, replacementServer)
  const { configuredCreatedAt, dialog, pubkey, secretKey } =
    await openProductDialogWithSigner(page, {
      configuredServerUrl: configuredServer,
    })
  await expect(
    dialog.getByText("your configured media servers", { exact: false })
  ).toBeVisible()

  let markSignerStarted!: () => void
  const signerStarted = new Promise<void>((resolve) => {
    markSignerStarted = resolve
  })
  let releaseSigner!: () => void
  const signerRelease = new Promise<void>((resolve) => {
    releaseSigner = resolve
  })
  await page.exposeFunction(
    "__conduitHoldProductImageSigner",
    async (): Promise<void> => {
      markSignerStarted()
      await signerRelease
    }
  )
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      nostr: {
        signEvent: (
          event: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      }
      __conduitHoldProductImageSigner: () => Promise<void>
    }
    const original = browserWindow.nostr.signEvent.bind(browserWindow.nostr)
    browserWindow.nostr.signEvent = async (event) => {
      if (Number(event.kind) === 24_242) {
        await browserWindow.__conduitHoldProductImageSigner()
      }
      return original(event)
    }
  })

  await dialog.locator("#product-image-file").setInputFiles(image192)
  await expect(
    dialog.getByText("Waiting for upload authorization", { exact: true })
  ).toBeVisible()
  await signerStarted

  const replacement = finalizeEvent(
    {
      kind: 10_063,
      created_at: configuredCreatedAt + 1,
      tags: [["server", replacementServer]],
      content: "",
    },
    secretKey
  )
  try {
    await publishTestRelayEvents([replacement])
    const mediaServerStorageKey = `conduit:media-server-preferences:v1:${pubkey}`
    await expect
      .poll(
        () =>
          page.evaluate((storageKey) => {
            const raw = localStorage.getItem(storageKey)
            if (!raw) return null
            try {
              const record = JSON.parse(raw) as {
                published?: { signedEvent?: { id?: string } }
              }
              return record.published?.signedEvent?.id ?? null
            } catch {
              return null
            }
          }, mediaServerStorageKey),
        { timeout: 45_000 }
      )
      .toBe(replacement.id)
    await page.waitForTimeout(100)
  } finally {
    releaseSigner()
  }

  await expect(
    dialog.getByText("The signer or media server authority changed.", {
      exact: false,
    })
  ).toBeVisible()
  expect(originalState.putCount).toBe(0)
  expect(replacementState.putCount).toBe(0)
  await expect(dialog.getByLabel("Primary image URL")).toHaveCount(0)
})

test("legacy Blossom auth retries once with the same signed event @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const state = await interceptBlossom(page, configuredServer, {
    authorizationMode: "legacy-required",
  })
  let fallbackRequests = 0
  await page.route(`${fallbackServer}/**`, async (route) => {
    fallbackRequests += 1
    await route.abort()
  })
  const { dialog } = await openProductDialogWithSigner(page, {
    configuredServerUrl: configuredServer,
  })
  await expect(
    dialog.getByText("your configured media servers", { exact: false })
  ).toBeVisible()
  await expect(
    dialog.getByRole("button", { name: "Add image", exact: true })
  ).toBeEnabled()

  await dialog.locator("#product-image-file").setInputFiles(image192)

  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  expect(await dialog.getByLabel("Primary image URL").inputValue()).toBe(
    state.resourceUrls[0]
  )
  await expect(
    dialog.getByRole("button", {
      name: "Add another image",
      exact: true,
    })
  ).toBeEnabled()
  expect(state.putCount).toBe(2)
  expect(state.putAuthorizationEncodings).toEqual(["bud11", "legacy"])
  expect(state.capabilityProbeCount).toBe(2)
  expect(state.canonicalAuthorizationCount).toBe(2)
  expect(state.legacyAuthorizationCount).toBe(2)
  expect(new Set(state.authorizationEventIds).size).toBe(1)
  expect(state.resourceRequestCount).toBeGreaterThanOrEqual(1)
  expect(fallbackRequests).toBe(0)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __conduitSignedKinds?: number[] })
          .__conduitSignedKinds
    )
  ).toEqual([24242])
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
    dialog.getByText(fallbackDisclosureText, { exact: false })
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    dialog.getByRole("link", { name: "Compare nostr.build plans" })
  ).toHaveAttribute("href", "https://account.nostr.build/plans")
  await expect(
    dialog.getByRole("link", { name: "Manage media servers" })
  ).toHaveAttribute("href", "/network")
  await expect(dialog.locator("#product-image-file")).toHaveAttribute(
    "multiple",
    ""
  )

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
    dialog.getByRole("button", { name: "Add image", exact: true })
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
  ).toBeEnabled()

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
  ).toBeEnabled()

  page.once("dialog", (confirmation) => confirmation.accept())
  await resumedDialog.getByRole("button", { name: "Discard changes" }).click()
  await expect(resumedDialog).toBeHidden()
  await page.getByRole("button", { name: "Add product" }).first().click()
  const freshDialog = page.getByRole("dialog", { name: "Add product" })
  await expect(
    freshDialog.getByRole("button", {
      name: "Add image",
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
  ).toBeEnabled()
  expect(state.putCount).toBe(2)
})

for (const scenario of [
  "consumed",
  "corrupt",
  "unreadable",
  "unwritable",
  "ambiguous",
  "destination-rejected",
] as const) {
  test(`legacy one-image claim ${scenario} cannot block batch uploads or draft recovery @merchant`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.addInitScript((scenario) => {
      const prefix = "conduit:merchant:product_image_fallback:v1"
      const get = Storage.prototype.getItem
      const set = Storage.prototype.setItem
      Storage.prototype.getItem = function (key) {
        if (!key.startsWith(prefix)) return get.call(this, key)
        if (scenario === "unreadable")
          throw new DOMException("Synthetic storage denial", "SecurityError")
        if (scenario === "consumed") return "1"
        if (scenario === "ambiguous")
          return JSON.stringify({
            version: 1,
            state: "retry_same_hash",
            sha256: "f".repeat(64),
          })
        if (scenario === "corrupt") return "{corrupt"
        return null
      }
      Storage.prototype.setItem = function (key, value) {
        if (
          key.startsWith(prefix) &&
          ["unwritable", "destination-rejected"].includes(scenario)
        )
          throw new DOMException(
            "Synthetic storage denial",
            "QuotaExceededError"
          )
        return set.call(this, key, value)
      }
    }, scenario)
    const state = await interceptBlossom(page, fallbackServer)
    const { dialog } = await openProductDialogWithSigner(page)
    await expect(
      dialog.getByText(fallbackDisclosureText, { exact: false })
    ).toBeVisible()
    await dialog.getByLabel("Title").fill(`Legacy claim ${scenario}`)
    await dialog
      .locator("#product-image-file")
      .setInputFiles([image192, image512])
    await expect(dialog.getByLabel("Image 2 URL")).toHaveValue(
      /^https:\/\/cdn\.conduit\.market\//
    )
    const urls = [
      await dialog.getByLabel("Primary image URL").inputValue(),
      await dialog.getByLabel("Image 2 URL").inputValue(),
    ]
    expect(state.putCount).toBe(2)
    await dialog.locator("form").getByRole("button", { name: "Close" }).click()
    await expect(dialog).toBeHidden()
    await page.reload()
    await page.getByRole("button", { name: "Resume product draft" }).click()
    const resumed = page.getByRole("dialog", { name: "Add product" })
    await expect(resumed.getByLabel("Primary image URL")).toHaveValue(urls[0])
    await expect(resumed.getByLabel("Image 2 URL")).toHaveValue(urls[1])
    await expect(
      resumed.getByRole("button", { name: "Add another image", exact: true })
    ).toBeEnabled()
    expect(state.putCount).toBe(2)
  })
}

test("default batch keeps a verified image when another fails and retries only the failure @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const state = await interceptBlossom(page, fallbackServer, {
    failSecondOnce: true,
  })
  const { dialog } = await openProductDialogWithSigner(page)
  await expect(
    dialog.getByText(fallbackDisclosureText, { exact: false })
  ).toBeVisible()
  await dialog
    .locator("#product-image-file")
    .setInputFiles([image192, image512])
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  await expect(
    dialog.getByRole("button", { name: "Retry image 2 upload" })
  ).toBeVisible()
  expect(state.putCount).toBe(2)
  await dialog.getByRole("button", { name: "Retry image 2 upload" }).click()
  await expect(dialog.getByLabel("Image 2 URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\//
  )
  expect(state.putCount).toBe(3)
  const cover = await dialog.getByLabel("Primary image URL").inputValue()
  const second = await dialog.getByLabel("Image 2 URL").inputValue()
  await dialog.getByRole("button", { name: "Make cover", exact: true }).click()
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(second)
  await expect(dialog.getByLabel("Image 2 URL")).toHaveValue(cover)
})

test("configured backup failure retains primary, retries the backup, and recovers display @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const backupServer = "https://backup-media.conduit.market"
  const primary = await interceptBlossom(page, configuredServer, {
    resourcePathPrefix: "primary",
  })
  const backup = await interceptBlossom(page, backupServer, {
    rejectFirstStatus: 429,
    resourcePathPrefix: "backup",
  })
  const { dialog, pubkey } = await openProductDialogWithSigner(page, {
    configuredServerUrls: [configuredServer, backupServer],
  })
  await expect(
    dialog.getByText("your configured media servers", { exact: false })
  ).toBeVisible()
  // Fetch verification succeeds, while image loading simulates a host outage.
  await page.route("https://cdn.conduit.market/primary/**", (route) =>
    route.request().resourceType() === "image"
      ? route.abort()
      : route.fallback()
  )
  await dialog.locator("#product-image-file").setInputFiles(image192)
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(
    /^https:\/\/cdn\.conduit\.market\/primary\//
  )
  await expect(
    dialog.getByText("Image is usable.", { exact: false })
  ).toBeVisible()
  expect(primary.putCount).toBe(1)
  expect(backup.putCount).toBe(1)
  await dialog.getByRole("button", { name: "Retry image 1 upload" }).click()
  await expect(
    dialog.getByRole("button", { name: "Retry image 1 upload" })
  ).toHaveCount(0)
  await expect(
    dialog.getByRole("button", { name: "Add another image" })
  ).toBeEnabled()
  expect(primary.putCount).toBe(1)
  expect(backup.putCount).toBe(2)
  expect(primary.requestHashes[0]).toBe(backup.requestHashes[1])
  const preview = dialog.getByRole("img", {
    name: "Product image",
    exact: true,
  })
  await expect(preview).toHaveAttribute("src", backup.resourceUrls[0])
  await dialog.getByLabel("Title").fill("Redundant image listing")
  await dialog.getByLabel("Price").fill("7")
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital" }).click()
  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["redundant", "image", "copy"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  await dialog
    .getByRole("button", { name: "Publish product", exact: true })
    .click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  let event: Awaited<ReturnType<typeof readTestRelayEvents>>[number] | undefined
  await expect
    .poll(
      async () => {
        const events = await readTestRelayEvents({
          kinds: [30402],
          authors: [pubkey],
        })
        event = events.find((candidate) =>
          candidate.tags.some(
            (tag) => tag[0] === "title" && tag[1] === "Redundant image listing"
          )
        )
        return event?.tags.filter((tag) => tag[0] === "image")
      },
      { timeout: 15_000 }
    )
    .toEqual([["image", primary.resourceUrls[0]]])
  if (!event)
    throw new Error("Expected the published signed listing on the test relay")
  expect(event.tags).toContainEqual(["image", primary.resourceUrls[0]])
  expect(event.tags.find((t) => t[0] === "imeta")).toContain(
    `fallback ${backup.resourceUrls[0]}`
  )
  await page.getByRole("button", { name: "Edit", exact: true }).first().click()
  const edit = page.getByRole("dialog", { name: "Edit listing" })
  await expect(edit.getByLabel("Primary image URL")).toHaveValue(
    primary.resourceUrls[0]
  )
  const editPreview = edit.getByRole("img", {
    name: "Redundant image listing",
    exact: true,
  })
  // WebKit starts lazy image requests only after the preview enters view.
  await editPreview.scrollIntoViewIfNeeded()
  await expect(editPreview).toHaveAttribute("src", backup.resourceUrls[0])
  await expect
    .poll(() =>
      editPreview.evaluate((image: HTMLImageElement) => image.naturalWidth)
    )
    .toBeGreaterThan(0)
  await edit.screenshot({ path: "/private/tmp/conduit-media-backup-edit.png" })
  const dTag = event.tags.find((tag) => tag[0] === "d")![1]
  const marketUrl =
    "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
  await page.goto(
    `${marketUrl}/products/${encodeURIComponent(`30402:${pubkey}:${dTag}`)}`
  )
  await expect(
    page.getByRole("heading", { name: "Redundant image listing", exact: true })
  ).toBeVisible({ timeout: 20_000 })
  const marketImage = page
    .getByRole("img", { name: "Redundant image listing", exact: true })
    .first()
  await marketImage.scrollIntoViewIfNeeded()
  await expect(marketImage).toHaveAttribute("src", backup.resourceUrls[0])
  await expect
    .poll(() =>
      marketImage.evaluate((image: HTMLImageElement) => image.naturalWidth)
    )
    .toBeGreaterThan(0)
  await page.screenshot({
    path: "/private/tmp/conduit-media-backup-market.png",
  })
})
