import { test, expect, type Page, type WebSocketRoute } from "@playwright/test"
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  type Event,
} from "nostr-tools/pure"
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44"
const root = `/@fs${process.cwd()}/packages/core/src/protocol`
const fixture = `/@fs${process.cwd()}/tests/browser/auth-containment-identity.ts`
async function openLogin(page: Page, app: string) {
  if (app === "market")
    await page
      .getByRole("button", { name: "Sign In", exact: true })
      .first()
      .click()
}
async function owner(page: Page) {
  return page.evaluate(
    async (root) =>
      (await import(`${root}/session-signer.ts`)).getAccountSigner()
        ?.authMethod ?? null,
    root
  )
}
for (const [i, app] of ["market", "merchant"].entries()) {
  const url = `http://localhost:${7000 + i}/${app === "market" ? "products" : ""}`
  test.beforeEach(async ({ page }) => {
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "localhost"
        ? route.continue()
        : route.abort()
    )
    await page.routeWebSocket(/.*/, (socket) => {
      socket.onMessage((raw) => {
        const m = JSON.parse(String(raw))
        if (m[0] === "REQ") socket.send(JSON.stringify(["EOSE", m[1]]))
        if (m[0] === "EVENT")
          socket.send(JSON.stringify(["OK", m[1].id, true, ""]))
      })
    })
  })
  for (const staged of [false, true])
    test(`${app} rejects restore and removes ${staged ? "staged and active" : "active"} saved keys`, async ({
      page,
    }) => {
      await page.goto(url)
      await page.evaluate(
        async ({ fixture, staged }) => (await import(fixture)).seed(staged),
        { fixture, staged }
      )
      await page.reload()
      await openLogin(page, app)
      await expect(
        page.getByText("Local key sign-in is not enabled in this build.", {
          exact: true,
        })
      ).toBeVisible()
      expect(await owner(page)).toBeNull()
      await expect(page.getByLabel("Secret Key", { exact: true })).toHaveCount(
        0
      )
      expect(
        await page.evaluate(async (f) => (await import(f)).count(), fixture)
      ).toBe(staged ? 2 : 1)
      if (staged) {
        await page.evaluate(() => {
          const remove = IDBObjectStore.prototype.delete
          IDBObjectStore.prototype.delete = function (key) {
            if (this.name === "record")
              throw new Error("Synthetic deletion failure")
            return remove.call(this, key)
          }
        })
        await page
          .getByRole("button", {
            name: "Remove saved local signer",
            exact: true,
          })
          .click()
        await expect(
          page.getByText(/Local signer removal is incomplete/)
        ).toBeVisible()
        expect(
          await page.evaluate(async (f) => (await import(f)).count(), fixture)
        ).toBe(2)
        await page.reload()
        await openLogin(page, app)
      }
      await page
        .getByRole("button", { name: "Remove saved local signer", exact: true })
        .click()
      await expect
        .poll(() =>
          page.evaluate(async (f) => (await import(f)).count(), fixture)
        )
        .toBe(0)
      await page.reload()
      await openLogin(page, app)
      await expect(
        page.getByRole("button", {
          name: "Sign in with Extension",
          exact: true,
        })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Remote Sign In", exact: true })
      ).toBeVisible()
      expect(await owner(page)).toBeNull()
    })
  test(`${app} extension sign-in`, async ({ page }) => {
    await page.goto(url)
    await openLogin(page, app)
    await expect(page.getByLabel("Secret Key", { exact: true })).toHaveCount(0)
    await page.evaluate(
      async (f) => (await import(f)).installExtension(),
      fixture
    )
    await page
      .getByRole("button", { name: "Sign in with Extension", exact: true })
      .click()
    await expect.poll(() => owner(page)).toBe("nip07")
    expect(
      await page.evaluate(
        async (f) => (await import(f)).verifyCurrentSigner(),
        fixture
      )
    ).toBe(true)
  })
  test(`${app} remote sign-in with encrypted NIP-46 exchange`, async ({
    page,
  }) => {
    const secret = generateSecretKey(),
      pubkey = getPublicKey(secret)
    const subscriptions = new Map<WebSocketRoute, Set<string>>()
    const pending: Event[] = []
    await page.routeWebSocket(/^wss:\/\/signer\.test(?:\/|$)/, (socket) => {
      const ids = new Set<string>()
      subscriptions.set(socket, ids)
      socket.onMessage((raw) => {
        const m = JSON.parse(String(raw))
        if (m[0] === "REQ") {
          const subscription = m[1]
          ids.add(subscription)
          socket.send(JSON.stringify(["EOSE", subscription]))
          for (const e of pending)
            socket.send(JSON.stringify(["EVENT", subscription, e]))
          return
        }
        if (m[0] === "CLOSE") {
          ids.delete(m[1])
          return
        }
        if (m[0] !== "EVENT") return
        const e = m[1]
        socket.send(JSON.stringify(["OK", e.id, true, ""]))
        const key = getConversationKey(secret, e.pubkey),
          request = JSON.parse(decrypt(e.content, key))
        const results: Record<string, string> = {
          connect: "ack",
          ping: "pong",
          get_public_key: pubkey,
          get_relays: "{}",
          switch_relays: JSON.stringify(["wss://signer.test"]),
        }
        let result = results[request.method]
        if (request.method === "sign_event")
          result = JSON.stringify(
            finalizeEvent(JSON.parse(request.params[0]), secret)
          )
        const response = finalizeEvent(
          {
            kind: 24133,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["p", e.pubkey]],
            content: encrypt(JSON.stringify({ id: request.id, result }), key),
          },
          secret
        )
        pending.push(response)
        for (const [client, subscriptionsForClient] of subscriptions)
          for (const id of subscriptionsForClient)
            client.send(JSON.stringify(["EVENT", id, response]))
      })
    })
    await page.goto(url)
    await openLogin(page, app)
    await page
      .getByRole("button", { name: "Remote Sign In", exact: true })
      .click()
    await page.getByRole("tab", { name: "Paste bunker", exact: true }).click()
    await page
      .getByRole("textbox", { name: "Remote signer bunker URL" })
      .fill(`bunker://${pubkey}?relay=wss%3A%2F%2Fsigner.test`)
    await page.getByRole("button", { name: "Connect with bunker link" }).click()
    await expect.poll(() => owner(page), { timeout: 20000 }).toBe("nip46")
    expect(
      await page.evaluate(
        async (f) => (await import(f)).verifyCurrentSigner(),
        fixture
      )
    ).toBe(true)
    secret.fill(0)
  })
}
