import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const vaultModuleUrl = `/@fs${process.cwd()}/packages/core/src/protocol/remote-signer-vault.ts`
const remoteSignerModuleUrl = `/@fs${process.cwd()}/packages/core/src/protocol/remote-signer.ts`

test("remote signer reconnect key is encrypted and restorable in browser storage @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)

  const result = await page.evaluate(async (moduleUrl) => {
    const { createBrowserRemoteSignerKeyVault } = (await import(moduleUrl)) as {
      createBrowserRemoteSignerKeyVault: () => {
        store(id: string, value: string): Promise<void>
        load(id: string): Promise<string | null>
        remove(id: string): Promise<void>
      }
    }
    const vault = createBrowserRemoteSignerKeyVault()
    const id = crypto.randomUUID()
    const privateKey = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("")

    await vault.store(id, privateKey)
    const restored = await vault.load(id)

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("conduit-remote-signer", 1)
      request.addEventListener("success", () => resolve(request.result), {
        once: true,
      })
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      })
    })
    const stored = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("session-keys", "readonly")
      const request = transaction.objectStore("session-keys").get(id)
      request.addEventListener("success", () => resolve(request.result), {
        once: true,
      })
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      })
    })
    database.close()

    const restoredMatches = restored === privateKey
    const plaintextAbsent = !JSON.stringify(stored).includes(privateKey)
    await vault.remove(id)
    return {
      restoredMatches,
      removed: (await vault.load(id)) === null,
      plaintextAbsent,
    }
  }, vaultModuleUrl)

  expect(result.restoredMatches).toBe(true)
  expect(result.removed).toBe(true)
  expect(result.plaintextAbsent).toBe(true)
})

test("concurrent tabs share one atomic vault wrapping key @market", async ({
  context,
}) => {
  const firstPage = await context.newPage()
  const secondPage = await context.newPage()
  await Promise.all([
    firstPage.goto(`${marketUrl}/products`),
    secondPage.goto(`${marketUrl}/products`),
  ])
  await firstPage.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("conduit-remote-signer")
        request.addEventListener("success", () => resolve(), { once: true })
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        })
      })
  )

  const storeAndVerify = (
    page: typeof firstPage,
    id: string,
    otherId: string
  ) =>
    page.evaluate(
      async ({ moduleUrl, id: keyId, otherId: otherKeyId }) => {
        const { createBrowserRemoteSignerKeyVault } = (await import(
          moduleUrl
        )) as {
          createBrowserRemoteSignerKeyVault: () => {
            store(id: string, value: string): Promise<void>
            load(id: string): Promise<string | null>
          }
        }
        const vault = createBrowserRemoteSignerKeyVault()
        const privateKey = Array.from(
          crypto.getRandomValues(new Uint8Array(32)),
          (byte) => byte.toString(16).padStart(2, "0")
        ).join("")
        await vault.store(keyId, privateKey)

        let other: string | null = null
        for (let attempt = 0; attempt < 100 && other === null; attempt += 1) {
          other = await vault.load(otherKeyId)
          if (other === null) {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }

        return {
          ownMatches: (await vault.load(keyId)) === privateKey,
          otherLoaded: other !== null,
          valuesDiffer: other !== privateKey,
        }
      },
      { moduleUrl: vaultModuleUrl, id, otherId }
    )

  const [firstResult, secondResult] = await Promise.all([
    storeAndVerify(firstPage, "first", "second"),
    storeAndVerify(secondPage, "second", "first"),
  ])

  expect(firstResult).toEqual({
    ownMatches: true,
    otherLoaded: true,
    valuesDiffer: true,
  })
  expect(secondResult).toEqual({
    ownMatches: true,
    otherLoaded: true,
    valuesDiffer: true,
  })
})

test("auth operations serialize across tabs without Web Locks @market", async ({
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    })
  })
  const firstPage = await context.newPage()
  const secondPage = await context.newPage()
  await Promise.all([
    firstPage.goto(`${marketUrl}/products`),
    secondPage.goto(`${marketUrl}/products`),
  ])
  await firstPage.evaluate(() => localStorage.removeItem("auth-lock-counter"))

  const increment = (page: typeof firstPage) =>
    page.evaluate(
      async ({ moduleUrl }) => {
        const { withBrowserAuthOperationLock } = (await import(moduleUrl)) as {
          withBrowserAuthOperationLock: <T>(
            task: () => Promise<T>
          ) => Promise<T>
        }
        return withBrowserAuthOperationLock(async () => {
          const current = Number(
            localStorage.getItem("auth-lock-counter") ?? "0"
          )
          await new Promise((resolve) => setTimeout(resolve, 100))
          localStorage.setItem("auth-lock-counter", String(current + 1))
          return current
        })
      },
      { moduleUrl: vaultModuleUrl }
    )

  const starts = await Promise.all([
    increment(firstPage),
    increment(secondPage),
  ])
  expect(starts.sort()).toEqual([0, 1])
  await expect
    .poll(() =>
      firstPage.evaluate(() => localStorage.getItem("auth-lock-counter"))
    )
    .toBe("2")
})

test("remote signer storage works without crypto.randomUUID @market", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    })
  })
  await page.goto(`${marketUrl}/products`)

  const result = await page.evaluate(
    async ({ signerModuleUrl, vaultUrl }) => {
      const [{ bumpAuthRevision }, { withBrowserAuthOperationLock }] =
        await Promise.all([import(signerModuleUrl), import(vaultUrl)])
      const revision = bumpAuthRevision()
      const lockResult = await withBrowserAuthOperationLock(async () => "ready")
      return { revision, lockResult }
    },
    { signerModuleUrl: remoteSignerModuleUrl, vaultUrl: vaultModuleUrl }
  )

  expect(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      result.revision
    )
  ).toBe(true)
  expect(result.lockResult).toBe("ready")
})

test("remote signer storage fails before pairing on an insecure page context @market", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "isSecureContext", {
      configurable: true,
      value: false,
    })
  })
  await page.goto(`${marketUrl}/products`)

  const message = await page.evaluate(async (moduleUrl) => {
    const { createBrowserRemoteSignerKeyVault } = (await import(moduleUrl)) as {
      createBrowserRemoteSignerKeyVault: () => {
        prepare(): Promise<void>
      }
    }
    try {
      await createBrowserRemoteSignerKeyVault().prepare()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, vaultModuleUrl)

  expect(message?.includes("HTTPS")).toBe(true)
  expect(message?.includes("crypto.subtle")).toBe(false)
})
