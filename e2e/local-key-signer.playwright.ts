import { expect, test, type Page } from "@playwright/test"

test.use({ trace: "off", screenshot: "off", video: "off" })

const protocol = `/@fs${process.cwd()}/packages/core/src/protocol`
const fixture = `/@fs${process.cwd()}/e2e/helpers/local-key-test-identity.ts`

async function installed(page: Page) {
  // Supporting emulation only; this is not physical-iPhone installation proof.
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window)
    window.matchMedia = (query) => {
      const result = matchMedia(query)
      if (query === "(display-mode: standalone)")
        Object.defineProperty(result, "matches", { value: true })
      return result
    }
  })
}

async function importAccount(page: Page) {
  const input = page.getByLabel("Existing Nostr secret key", { exact: true })
  await expect(input).toBeVisible()
  await input.evaluate(async (element, fixturePath) => {
    const helper = await import(fixturePath)
    helper.populateImportInput(element)
    element.form?.requestSubmit()
  }, fixture)
}

async function hasOwner(page: Page): Promise<boolean> {
  return page.evaluate(async (root) => {
    const auth = await import(`${root}/auth-session.ts`)
    const owner = await import(`${root}/session-signer.ts`)
    return (
      auth.readAuthSession()?.type === "local" && !!owner.getAccountSigner()
    )
  }, protocol)
}

for (const app of ["market", "merchant"] as const) {
  const port =
    app === "market"
      ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
      : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
  const menu =
    app === "market" ? "Open account menu" : "Open merchant account menu"
  const home = `http://127.0.0.1:${port}/${app === "market" ? "products" : ""}`

  test(`${app} browser tab local account uses shared authority, envelopes, restore and durable removal @${app}`, async ({
    page,
  }) => {
    await page.goto(home)
    if (app === "market")
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
    await importAccount(page)
    await expect.poll(() => hasOwner(page)).toBe(true)
    await expect(page.getByLabel(menu, { exact: true })).toBeVisible()

    const checks = await page.evaluate(async (root) => {
      const auth = await import(`${root}/auth-session.ts`)
      const owners = await import(`${root}/session-signer.ts`)
      const protectedReads = await import(
        `${root}/protected-read-authorization.ts`
      )
      const signed = await import(`${root}/signed-event.ts`)
      const messages = await import(`${root}/private-message-primitives.ts`)
      const publication = await import(`${root}/relay-publish.ts`)
      const products = await import(`${root}/products.ts`)
      const session = auth.readAuthSession()
      const signer = owners.getAccountSigner()
      if (!session || !signer) throw new Error("LOCAL_TEST_OWNER_ABSENT")
      const grant = protectedReads.getProtectedReadAuthorization(
        session.userPubkey
      )
      const draft = {
        pubkey: session.userPubkey,
        kind: 1,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        content: "synthetic",
      }
      const event = await signer.signEvent(draft)
      const cipher = await signer.encryptNip44(signer.pubkey, "synthetic")
      const product = products.buildProductListingEventDraft({
        dTag: "local-signer-regression",
        product: {
          pubkey: signer.pubkey,
          title: "Synthetic test listing",
          price: 1,
          currency: "SAT",
          type: "simple",
          format: "digital",
          images: [],
          tags: [],
        },
      })
      let publicationVerified = true
      const relay = (await import(`${root}/../config.ts`)).config
        .corePublicFallbackRelayUrls[0]
      for (const template of [
        product,
        { kind: 10002, tags: [["r", relay]], content: "" },
      ]) {
        const signedEvent = await signer.signEvent({ ...draft, ...template })
        const outcome = await publication.publishSignedEventToRelay({
          signedEvent,
          relayUrl: relay,
          authorPubkey: signer.pubkey,
          authenticatedPubkey: signer.pubkey,
        })
        publicationVerified &&= outcome === "acked"
      }
      let envelopes = true
      for (const kind of [14, 16]) {
        const rumor = messages.createPrivateMessageRumor({
          ...draft,
          kind,
          tags: [["p", signer.pubkey]],
        })
        const wrap = await messages.wrapPrivateMessage(
          rumor,
          { pubkey: signer.pubkey },
          signer
        )
        const received = await messages.unwrapPrivateMessageEnvelope(
          wrap,
          signer
        )
        envelopes &&=
          received.kind === kind &&
          received.content === rumor.content &&
          !received.sig
      }
      return {
        localMethod: signer.authMethod === "local",
        sharedRevision: signer.revision === session.authClaim,
        sharedProtectedGrant: grant?.signer === signer,
        validSignature: signed.isValidSignedPublicNostrEvent(event),
        roundTrip:
          (await signer.decryptNip44(signer.pubkey, cipher)) === "synthetic",
        sharedEnvelopes: envelopes,
        sharedPublication: publicationVerified,
        publicMetadataOnly: !Object.keys(session).some((key) =>
          /secret|nsec|private/i.test(key)
        ),
      }
    }, protocol)
    expect(checks).toEqual({
      localMethod: true,
      sharedRevision: true,
      sharedProtectedGrant: true,
      validSignature: true,
      roundTrip: true,
      sharedEnvelopes: true,
      sharedPublication: true,
      publicMetadataOnly: true,
    })

    await page.reload()
    await expect.poll(() => hasOwner(page)).toBe(true)
    await page.getByLabel(menu, { exact: true }).click()
    await page
      .getByRole("menuitem", { name: "Sign out and remove key", exact: true })
      .click()
    await expect.poll(() => hasOwner(page)).toBe(false)
    // Live authority stops before deletion commits. Await the durable outcome.
    await expect
      .poll(() =>
        page.evaluate(async (root) => {
          const auth = await import(`${root}/auth-session.ts`)
          return (
            auth.readAuthSession() === null &&
            auth.readPendingLocalKeyRemoval() === null
          )
        }, protocol)
      )
      .toBe(true)
    await page.reload()
    await expect.poll(() => hasOwner(page)).toBe(false)
    if (app === "market")
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
    await importAccount(page)
    await expect.poll(() => hasOwner(page)).toBe(true)
  })

  for (const delay of ["lock", "storage"] as const) {
    test(`${app} dismissing local import during ${delay} leaves no saved account @${app}`, async ({
      page,
    }) => {
      // These signer-free routes expose each app's real header account dialog.
      await page.goto(
        `http://127.0.0.1:${port}/${app === "market" ? "products" : "wallet"}`,
        {
          waitUntil: "domcontentloaded",
        }
      )
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
      await page.evaluate(
        async ({ root, delay }) => {
          const state = { waiting: false, release: () => {}, restore: () => {} }
          Object.assign(window, { localImportDelay: state })
          const barrier = new Promise<void>((resolve) => {
            state.release = resolve
          })
          if (delay === "lock") {
            void navigator.locks.request("conduit-auth-operation", async () => {
              state.waiting = true
              await barrier
            })
          } else {
            const { LocalKeyStorage } = await import(
              `${root}/local-key/storage.ts`
            )
            const write = LocalKeyStorage.prototype.write
            LocalKeyStorage.prototype.write = async function (...args) {
              await write.apply(this, args)
              state.waiting = true
              await barrier
            }
            state.restore = () => {
              LocalKeyStorage.prototype.write = write
            }
          }
        },
        { root: protocol, delay }
      )
      if (delay === "lock")
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    localImportDelay: { waiting: boolean }
                  }
                ).localImportDelay.waiting
            )
          )
          .toBe(true)
      await importAccount(page)
      await expect(
        page.getByRole("button", { name: "Signing in…", exact: true })
      ).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { localImportDelay: { waiting: boolean } })
                .localImportDelay.waiting
          )
        )
        .toBe(true)
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Close", exact: true })
        .click()
      await expect(page.getByRole("dialog")).toBeHidden()
      await page.evaluate(() => {
        const state = (
          window as unknown as {
            localImportDelay: { release: () => void; restore: () => void }
          }
        ).localImportDelay
        state.restore()
        state.release()
      })
      // Drain the actual auth operation, including rollback, before inspecting.
      await page.evaluate(() =>
        navigator.locks.request("conduit-auth-operation", () => undefined)
      )
      const result = await page.evaluate(async (root) => {
        const auth = await import(`${root}/auth-session.ts`)
        const owner = await import(`${root}/session-signer.ts`)
        const exists = (await indexedDB.databases()).some(
          (database) => database.name === "conduit-local-key"
        )
        const empty =
          !exists ||
          (await new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open("conduit-local-key", 1)
            open.onerror = () => reject(new Error("LOCAL_TEST_STORAGE_FAILED"))
            open.onsuccess = () => {
              const db = open.result
              if (!db.objectStoreNames.contains("record")) {
                db.close()
                resolve(true)
                return
              }
              const tx = db.transaction("record", "readonly")
              const count = tx.objectStore("record").count()
              tx.oncomplete = () => {
                db.close()
                resolve(count.result === 0)
              }
              tx.onerror = () => {
                db.close()
                reject(new Error("LOCAL_TEST_STORAGE_FAILED"))
              }
            }
          }))
        return {
          empty,
          noSession: auth.readAuthSession() === null,
          noOwner: !owner.getAccountSigner(),
        }
      }, protocol)
      expect(result).toEqual({ empty: true, noSession: true, noOwner: true })
      await page.reload()
      await expect(
        page.getByRole("button", { name: "Connect", exact: true }).first()
      ).toBeVisible()
      expect(await hasOwner(page)).toBe(false)
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
      await importAccount(page)
      await expect.poll(() => hasOwner(page)).toBe(true)
    })
  }

  test(`${app} invalid nsec stays signed out and allows correction in a browser tab @${app}`, async ({
    page,
  }) => {
    await page.goto(home)
    if (app === "market")
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
    await page
      .getByLabel("Existing Nostr secret key", { exact: true })
      .fill("invalid input")
    await page
      .getByRole("button", { name: "Sign in with nsec", exact: true })
      .click()
    await expect(page.getByRole("alert").first()).toBeVisible()
    expect(await hasOwner(page)).toBe(false)
    await expect(
      page.getByLabel("Existing Nostr secret key", { exact: true })
    ).toHaveValue("")
    await importAccount(page)
    await expect.poll(() => hasOwner(page)).toBe(true)
  })

  test(`${app} storage loss retires the shared owner and permits reimport @${app}`, async ({
    page,
  }) => {
    await installed(page)
    await page.goto(home)
    if (app === "market")
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
    await importAccount(page)
    await expect.poll(() => hasOwner(page)).toBe(true)
    const lost = await page.evaluate(async (root) => {
      const owners = await import(`${root}/session-signer.ts`)
      const signer = owners.getAccountSigner()
      const identity = signer.pubkey
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("conduit-local-key")
        request.onsuccess = () => resolve()
        request.onerror = () => reject(new Error("LOCAL_TEST_STORAGE_FAILED"))
      })
      let rejected = false
      try {
        await signer.encryptNip44(identity, "synthetic")
      } catch {
        rejected = true
      }
      return rejected && !owners.getAccountSigner()
    }, protocol)
    expect(lost).toBe(true)
    if (app === "market")
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
    await expect(
      page
        .getByText("The saved local signer is unavailable.", { exact: false })
        .first()
    ).toBeVisible()
    await importAccount(page)
    await expect.poll(() => hasOwner(page)).toBe(true)
  })

  for (const partialStorage of [false, true]) {
    test(`${app} failed deletion${partialStorage ? " with partial storage failure" : ""} remains visible after restart and can be retried @${app}`, async ({
      page,
    }) => {
      await installed(page)
      await page.goto(home)
      if (app === "market")
        await page
          .getByRole("button", { name: "Connect", exact: true })
          .first()
          .click()
      await importAccount(page)
      await expect.poll(() => hasOwner(page)).toBe(true)
      await page.evaluate((partial) => {
        if (partial) {
          const set = Storage.prototype.setItem
          const remove = Storage.prototype.removeItem
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith("conduit:auth:") && key !== "conduit:auth")
              throw new DOMException("synthetic", "QuotaExceededError")
            return set.call(this, key, value)
          }
          Storage.prototype.removeItem = function (key) {
            if (key === "conduit:auth")
              throw new DOMException("synthetic", "QuotaExceededError")
            return remove.call(this, key)
          }
        }
        const remove = IDBObjectStore.prototype.delete
        IDBObjectStore.prototype.delete = function (key) {
          if (this.transaction.db.name === "conduit-local-key")
            throw new DOMException("synthetic", "QuotaExceededError")
          return remove.call(this, key)
        }
      }, partialStorage)
      await page.getByLabel(menu, { exact: true }).click()
      await page
        .getByRole("menuitem", { name: "Sign out and remove key", exact: true })
        .click()
      await expect.poll(() => hasOwner(page)).toBe(false)
      if (app === "market")
        await page
          .getByRole("button", { name: "Connect", exact: true })
          .first()
          .click()
      await expect(
        page
          .getByText("Local signer removal is incomplete.", {
            exact: false,
          })
          .first()
      ).toBeVisible()
      await page.reload()
      await expect.poll(() => hasOwner(page)).toBe(false)
      if (app === "market")
        await page
          .getByRole("button", { name: "Connect", exact: true })
          .first()
          .click()
      await expect(
        page
          .getByText("Local signer removal is incomplete.", { exact: false })
          .first()
      ).toBeVisible()
      await page
        .getByRole("button", { name: "Remove saved local signer", exact: true })
        .click()
      await expect
        .poll(() =>
          page.evaluate(async (root) => {
            const auth = await import(`${root}/auth-session.ts`)
            return (
              auth.readPendingLocalKeyRemoval() === null &&
              auth.readAuthSession() === null
            )
          }, protocol)
        )
        .toBe(true)
      await page.reload()
      await expect.poll(() => hasOwner(page)).toBe(false)
    })
  }

  test(`${app} reports unresolved restart safety when all removal persistence fails @${app}`, async ({
    page,
  }) => {
    await installed(page)
    await page.goto(home)
    if (app === "market")
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
    await importAccount(page)
    await expect.poll(() => hasOwner(page)).toBe(true)
    await page.evaluate(() => {
      const set = Storage.prototype.setItem
      const remove = Storage.prototype.removeItem
      const deletion = IDBObjectStore.prototype.delete
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("conduit:auth"))
          throw new DOMException("synthetic", "QuotaExceededError")
        return set.call(this, key, value)
      }
      Storage.prototype.removeItem = function (key) {
        if (key.startsWith("conduit:auth"))
          throw new DOMException("synthetic", "QuotaExceededError")
        return remove.call(this, key)
      }
      IDBObjectStore.prototype.delete = function (key) {
        if (this.transaction.db.name === "conduit-local-key")
          throw new DOMException("synthetic", "QuotaExceededError")
        return deletion.call(this, key)
      }
      Object.defineProperty(window, "__restoreLocalRemovalStorage", {
        configurable: true,
        value: () => {
          Storage.prototype.setItem = set
          Storage.prototype.removeItem = remove
          IDBObjectStore.prototype.delete = deletion
        },
      })
    })
    await page.getByLabel(menu, { exact: true }).click()
    await page
      .getByRole("menuitem", { name: "Sign out and remove key", exact: true })
      .click()
    await expect.poll(() => hasOwner(page)).toBe(false)
    if (app === "market")
      await page
        .getByRole("button", { name: "Connect", exact: true })
        .first()
        .click()
    await expect(
      page
        .getByText("restart safety could not be secured", { exact: false })
        .first()
    ).toBeVisible()
    await page.evaluate(() => {
      ;(
        window as unknown as { __restoreLocalRemovalStorage: () => void }
      ).__restoreLocalRemovalStorage()
      Reflect.deleteProperty(window, "__restoreLocalRemovalStorage")
    })
    await page
      .getByRole("button", { name: "Remove saved local signer", exact: true })
      .click()
    await expect
      .poll(() =>
        page.evaluate(async (root) => {
          const auth = await import(`${root}/auth-session.ts`)
          return (
            auth.readAuthSession() === null &&
            auth.readPendingLocalKeyRemoval() === null
          )
        }, protocol)
      )
      .toBe(true)
    await page.reload()
    await expect.poll(() => hasOwner(page)).toBe(false)
  })

  for (const failure of ["cancel", "metadata", "installation"] as const) {
    test(`${app} replacement ${failure} rolls back through the real auth owner and reloads the prior account @${app}`, async ({
      page,
    }) => {
      await installed(page)
      await page.goto(home)
      const result = await page.evaluate(
        async ({ root, fixturePath, failure }) => {
          const { mountLocalAuthFixture } = await import(
            fixturePath.replace(
              "local-key-test-identity.ts",
              "local-key-auth-fixture.tsx"
            )
          )
          const keys = await import(`${root}/local-key/index.ts`)
          const { LocalKeyStorage } = await import(
            `${root}/local-key/storage.ts`
          )
          const metadata = await import(`${root}/auth-session.ts`)
          const helper = await import(fixturePath)
          const mounted = await mountLocalAuthFixture()
          const input = document.createElement("input")
          input.type = "password"
          helper.populateImportInput(input)
          const previous = await keys
            .prepareLocalKeyImport(input)
            .persist(() => true)
          await previous.commit(() => true)
          const saved = {
            version: 1,
            type: "local",
            ...previous.reference,
            authClaim: metadata.claimAuthRevision().revision,
          }
          metadata.writeAuthSession(saved)
          previous.invalidate()
          const write = LocalKeyStorage.prototype.write
          const commit = LocalKeyStorage.prototype.commit
          const set = Storage.prototype.setItem
          if (failure === "cancel")
            LocalKeyStorage.prototype.write = async function (...args) {
              await write.apply(this, args)
              mounted.auth.cancelConnect()
            }
          if (failure === "metadata")
            Storage.prototype.setItem = function (key, value) {
              if (key === metadata.AUTH_STORAGE_KEY)
                throw new DOMException("synthetic", "QuotaExceededError")
              return set.call(this, key, value)
            }
          if (failure === "installation")
            LocalKeyStorage.prototype.commit = async () => {
              throw new Error("synthetic installation failure")
            }
          helper.populateImportInput(input)
          try {
            await Promise.race([
              mounted.auth
                .connect({ method: "local", localKeyInput: input })
                .catch(() => undefined),
              new Promise((_, reject) =>
                setTimeout(
                  () =>
                    reject(new Error("AUTH_FIXTURE_CONNECT_DID_NOT_SETTLE")),
                  10000
                )
              ),
            ])
          } finally {
            LocalKeyStorage.prototype.write = write
            LocalKeyStorage.prototype.commit = commit
            Storage.prototype.setItem = set
            mounted.dispose()
          }
          const retained = metadata.readAuthSession()
          const restored = await keys.restoreLocalKeySigner(saved)
          const sameAccount =
            (await restored.getPublicKey()) === saved.userPubkey
          restored.invalidate()
          const noCandidate = await new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open("conduit-local-key", 1)
            open.onerror = () => reject(new Error("synthetic read failed"))
            open.onsuccess = () => {
              const db = open.result
              const tx = db.transaction("record", "readonly")
              const read = tx.objectStore("record").getKey("candidate")
              tx.oncomplete = () => {
                resolve(read.result === undefined)
                db.close()
              }
            }
          })
          return {
            sameAccount,
            sameRevision: retained?.localKeyRevision === saved.localKeyRevision,
            noCandidate,
            clearedInput: input.value === "",
          }
        },
        { root: protocol, fixturePath: fixture, failure }
      )
      expect(result).toEqual({
        sameAccount: true,
        sameRevision: true,
        noCandidate: true,
        clearedInput: true,
      })
      await page.reload()
      await expect.poll(() => hasOwner(page)).toBe(true)
    })
  }
}
