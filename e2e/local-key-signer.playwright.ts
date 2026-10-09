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

  test(`${app} installed local account uses shared authority, envelopes, restore and durable removal @${app}`, async ({
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

  test(`${app} failed deletion remains visible after restart and can be retried @${app}`, async ({
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
      const remove = IDBObjectStore.prototype.delete
      IDBObjectStore.prototype.delete = function (key) {
        if (this.transaction.db.name === "conduit-local-key")
          throw new DOMException("synthetic", "QuotaExceededError")
        return remove.call(this, key)
      }
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
        .getByText("The stored local signer could not be removed.", {
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
