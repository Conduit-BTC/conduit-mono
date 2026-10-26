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
  const input = page.getByLabel("Secret Key", { exact: true })
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

  test(`${app} denied clipboard access keeps direct paste usable @${app}`, async ({
    page,
  }) => {
    await page.goto(home)
    if (app === "market")
      await page
        .getByRole("button", { name: "Sign In", exact: true })
        .first()
        .click()
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: async () => {
            throw new Error("Denied")
          },
        },
      })
    )
    await page
      .getByRole("button", { name: "Paste secret key from clipboard" })
      .click()
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Paste directly into the field instead." })
    ).toBeVisible()
    expect(await hasOwner(page)).toBe(false)
    await importAccount(page)
    await expect.poll(() => hasOwner(page)).toBe(true)
  })

  for (const interruption of ["dismiss", "edit"] as const) {
    test(`${app} ${interruption} discards an outstanding clipboard paste @${app}`, async ({
      page,
    }) => {
      await page.goto(
        `http://127.0.0.1:${port}/${app === "market" ? "products" : "wallet"}`
      )
      await page
        .getByRole("button", { name: "Sign In", exact: true })
        .first()
        .click()
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            readText: () =>
              new Promise<string>((resolve) => {
                Object.assign(window, {
                  releaseClipboard: () => resolve("late clipboard test text"),
                })
              }),
          },
        })
      })
      await page
        .getByRole("button", { name: "Paste secret key from clipboard" })
        .click()
      if (interruption === "dismiss") {
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Close", exact: true })
          .click()
        await expect(page.getByRole("dialog")).toBeHidden()
      } else {
        await page
          .getByLabel("Secret Key", { exact: true })
          .fill("edited input")
      }
      await page.evaluate(async () => {
        ;(
          window as unknown as { releaseClipboard: () => void }
        ).releaseClipboard()
        // Drain the clipboard promise and the component continuation.
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      if (interruption === "dismiss")
        await page
          .getByRole("button", { name: "Sign In", exact: true })
          .first()
          .click()
      await expect(page.getByLabel("Secret Key", { exact: true })).toHaveValue(
        interruption === "edit" ? "edited input" : ""
      )
      expect(await hasOwner(page)).toBe(false)
    })
  }

  test(`${app} browser tab local account uses shared authority, envelopes, restore and durable removal @${app}`, async ({
    page,
  }) => {
    await page.goto(home)
    if (app === "market")
      await page
        .getByRole("button", { name: "Sign In", exact: true })
        .first()
        .click()
    await expect(
      page.getByText(
        "Your key is saved in this browser so you stay signed in. We don’t send it to our servers. Use a trusted device and keep a backup.",
        { exact: true }
      )
    ).toBeVisible()
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
    const restoredSignatureValid = await page.evaluate(async (root) => {
      const owners = await import(`${root}/session-signer.ts`)
      const signed = await import(`${root}/signed-event.ts`)
      const signer = owners.getAccountSigner()
      if (!signer) return false
      const event = await signer.signEvent({
        pubkey: signer.pubkey,
        kind: 1,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        content: "synthetic restored signature",
      })
      return signed.isValidSignedPublicNostrEvent(event)
    }, protocol)
    expect(restoredSignatureValid).toBe(true)
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
        .getByRole("button", { name: "Sign In", exact: true })
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
        .getByRole("button", { name: "Sign In", exact: true })
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
        page.getByRole("button", { name: "Sign In", exact: true }).first()
      ).toBeVisible()
      expect(await hasOwner(page)).toBe(false)
      await page
        .getByRole("button", { name: "Sign In", exact: true })
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
        .getByRole("button", { name: "Sign In", exact: true })
        .first()
        .click()
    await page.getByLabel("Secret Key", { exact: true }).fill("invalid input")
    await page.getByRole("button", { name: "Sign In", exact: true }).click()
    await expect(page.getByRole("alert").first()).toBeVisible()
    expect(await hasOwner(page)).toBe(false)
    await expect(page.getByLabel("Secret Key", { exact: true })).toHaveValue("")
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
        .getByRole("button", { name: "Sign In", exact: true })
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
        .getByRole("button", { name: "Sign In", exact: true })
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
          .getByRole("button", { name: "Sign In", exact: true })
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
          .getByRole("button", { name: "Sign In", exact: true })
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
          .getByRole("button", { name: "Sign In", exact: true })
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
        .getByRole("button", { name: "Sign In", exact: true })
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
        .getByRole("button", { name: "Sign In", exact: true })
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

  for (const kind of ["rollback", "unreadable", "orphan"] as const) {
    test(`${app} coordinated local lifecycle ${kind} survives storage faults @${app}`, async ({
      page,
    }) => {
      await page.goto(home)
      const result = await page.evaluate(
        async ({ kind, protocolRoot, fixturePath }) => {
          const root = protocolRoot
          const keys = await import(root + "/local-key/index.ts")
          const { LocalKeyStorage } = await import(
            root + "/local-key/storage.ts"
          )
          const metadata = await import(root + "/auth-session.ts")
          const helper = await import(fixturePath)
          const { mountLocalAuthFixture } = await import(
            fixturePath.replace(
              "local-key-test-identity.ts",
              "local-key-auth-fixture.tsx"
            )
          )
          const mounted = await mountLocalAuthFixture()
          const input = document.createElement("input")
          input.type = "password"
          async function fresh(commit: boolean) {
            helper.populateImportInput(input)
            const local = await keys
              .prepareLocalKeyImport(input)
              .persist(() => true)
            if (commit) await local.commit(() => true)
            return local
          }
          function saved(local: {
            reference: { userPubkey: string; localKeyRevision: string }
          }) {
            return {
              version: 1,
              type: "local",
              ...local.reference,
              authClaim: metadata.claimAuthRevision().revision,
            }
          }
          async function count() {
            return new Promise<number>((resolve, reject) => {
              const r = indexedDB.open("conduit-local-key", 1)
              r.onerror = () => reject(Error("DIAG_DB"))
              r.onsuccess = () => {
                const db = r.result
                const tx = db.transaction("record", "readonly")
                const q = tx.objectStore("record").count()
                tx.oncomplete = () => {
                  db.close()
                  resolve(q.result)
                }
              }
            })
          }
          if (kind === "rollback") {
            const originalCommit = LocalKeyStorage.prototype.commit
            const remove = Storage.prototype.removeItem
            let entered = false
            LocalKeyStorage.prototype.commit = async function () {
              entered = true
              Storage.prototype.removeItem = function (k) {
                if (k === metadata.AUTH_STORAGE_KEY)
                  throw Error("synthetic metadata rollback failure")
                return remove.call(this, k)
              }
              mounted.auth.cancelConnect()
              throw Error("synthetic cancelled promotion")
            }
            helper.populateImportInput(input)
            try {
              await mounted.auth.connect({
                method: "local",
                localKeyInput: input,
              })
            } catch {
              // The injected storage fault must reject this connection.
            } finally {
              LocalKeyStorage.prototype.commit = originalCommit
              Storage.prototype.removeItem = remove
              mounted.dispose()
            }
            const retained = metadata.readAuthSession()
            let restorable = false
            if (retained?.type === "local") {
              try {
                const signer = await keys.restoreLocalKeySigner(retained)
                restorable = !!(await signer.getPublicKey())
                signer.invalidate()
              } catch {}
            }
            return {
              entered,
              metadataRetained: retained?.type === "local",
              records: await count(),
              cancelledCandidateRestorable: restorable,
              pendingRemoval: metadata.readPendingLocalKeyRemoval() !== null,
            }
          }
          if (kind === "unreadable") {
            const a = await fresh(true)
            const b = await fresh(false)
            const session = saved(b)
            metadata.writeAuthSession(session)
            a.invalidate()
            b.invalidate()
            const before = await count()
            const get = Storage.prototype.getItem
            const set = Storage.prototype.setItem
            Storage.prototype.setItem = function (k, v) {
              if (k === metadata.AUTH_REVISION_STORAGE_KEY)
                throw Error("synthetic unavailable authority claim")
              return set.call(this, k, v)
            }
            Storage.prototype.getItem = function (k) {
              if (k === metadata.AUTH_STORAGE_KEY)
                throw Error("synthetic unavailable metadata")
              return get.call(this, k)
            }
            helper.populateImportInput(input)
            try {
              await mounted.auth.connect({
                method: "local",
                localKeyInput: input,
              })
            } catch {
              // The injected storage fault must reject this connection.
            } finally {
              Storage.prototype.getItem = get
              Storage.prototype.setItem = set
              mounted.dispose()
            }
            let restorable = false
            try {
              const signer = await keys.restoreLocalKeySigner(session)
              restorable = !!(await signer.getPublicKey())
              signer.invalidate()
            } catch {}
            return {
              before,
              metadataStillSelectsCandidate:
                metadata.readAuthSession()?.localKeyRevision ===
                session.localKeyRevision,
              candidateRestorableAfterReadRecovery: restorable,
              after: await count(),
            }
          }
          if (kind === "orphan") {
            const a = await fresh(true)
            const b = await fresh(false)
            const session = saved(b)
            metadata.writeAuthSession(session)
            a.invalidate()
            b.invalidate()
            const commit = LocalKeyStorage.prototype.commit
            LocalKeyStorage.prototype.commit = async () => {
              throw Error("synthetic restore promotion failure")
            }
            let restoreFailed = false
            try {
              await mounted.auth.connect({ method: "local", mode: "restore" })
            } catch {
              restoreFailed = true
            } finally {
              LocalKeyStorage.prototype.commit = commit
            }
            await mounted.auth.disconnect()
            mounted.dispose()
            return {
              restoreFailed,
              metadataCleared: metadata.readAuthSession() === null,
              removalJournalCleared:
                metadata.readPendingLocalKeyRemoval() === null,
              remainingRecords: await count(),
            }
          }
        },
        { kind, protocolRoot: protocol, fixturePath: fixture }
      )
      if (kind === "rollback") {
        expect(result).toEqual({
          entered: true,
          metadataRetained: false,
          records: 0,
          cancelledCandidateRestorable: false,
          pendingRemoval: true,
        })
        await page.reload()
        await expect.poll(() => hasOwner(page)).toBe(false)
        if (app === "market")
          await page
            .getByRole("button", { name: "Sign In", exact: true })
            .first()
            .click()
        await page
          .getByRole("button", {
            name: "Remove saved local signer",
            exact: true,
          })
          .click()
        await expect
          .poll(() =>
            page.evaluate(async (root) => {
              const metadata = await import(`${root}/auth-session.ts`)
              return metadata.readPendingLocalKeyRemoval() === null
            }, protocol)
          )
          .toBe(true)
      } else if (kind === "unreadable") {
        expect(result).toEqual({
          before: 2,
          metadataStillSelectsCandidate: true,
          candidateRestorableAfterReadRecovery: true,
          after: 2,
        })
        await page.reload()
        await expect.poll(() => hasOwner(page)).toBe(true)
      } else {
        expect(result).toEqual({
          restoreFailed: true,
          metadataCleared: true,
          removalJournalCleared: true,
          remainingRecords: 0,
        })
        await page.reload()
        await expect.poll(() => hasOwner(page)).toBe(false)
      }
    })
  }

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
