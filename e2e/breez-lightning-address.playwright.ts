import path from "node:path"
import { generateSecretKey } from "nostr-tools/pure"
import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const source = (file: string) => `/@fs${path.resolve(process.cwd(), file)}`
test.use({ trace: "off", screenshot: "off", video: "off" })

test("Breez address controls preserve the invoice fallback when unconfigured @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/wallet`)
  await page.evaluate(
    async ({ componentUrl, reactUrl, domUrl }) => {
      const React = (await import(reactUrl)).default
      const ReactDOM = (await import(domUrl)).default
      const { SparkLightningAddress } = await import(componentUrl)
      const host = document.createElement("div")
      host.id = "address-control-fixture"
      // Isolate the mounted control from the application's fixed footer.
      host.style.cssText =
        "position:fixed;inset:80px 24px;z-index:1000;overflow:auto;background:var(--background)"
      document.body.append(host)
      ReactDOM.createRoot(host).render(
        React.createElement(SparkLightningAddress, {
          walletId: "public-test-wallet",
          resolve: async () => ({
            status: "unavailable",
            reason: "unconfigured",
          }),
        })
      )
    },
    {
      componentUrl: source(
        "apps/market/src/components/SparkLightningAddress.tsx"
      ),
      reactUrl: "/@id/react",
      domUrl: "/@id/react-dom/client",
    }
  )
  const control = page.locator("#address-control-fixture")
  await expect(control.getByRole("status")).toHaveText(
    "Lightning addresses are currently unavailable."
  )
  await expect(control).toContainText(
    "You can create a Lightning invoice below"
  )
  await expect(control.getByRole("button")).toHaveCount(0)
})

test("Breez registration serializes across clients and restores after a reload @market", async ({
  page,
  context,
}) => {
  // Real browser signatures/storage/Web Locks; controlled provider responses.
  // No Spark network wallet, live domain registration, payment or zap occurs.
  const signingFixture = Array.from(generateSecretKey())
  let identity: string | null = null
  let username: string | null = null
  let registrations = 0
  await context.route("https://conduit.cash/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    }
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers })
      return
    }
    if (request.method() === "POST") {
      const owner = url.pathname.split("/")[2]
      identity ??= owner
      expect(owner).toBe(identity)
    }
    const reply = async (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      })
    if (url.pathname.includes(".well-known")) {
      await reply({
        tag: "payRequest",
        minSendable: 1000,
        maxSendable: 1000000,
        metadata: JSON.stringify([
          ["text/identifier", `${username}@conduit.cash`],
        ]),
        callback: `https://conduit.cash/lnurlp/${username}/invoice`,
        allowsNostr: true,
        nostrPubkey: "ab".repeat(32),
      })
    } else if (url.pathname.endsWith("/recover")) {
      await reply(
        username
          ? {
              username,
              lightning_address: `${username}@conduit.cash`,
              description: "fixture",
              lnurl: `lnurlp://conduit.cash/lnurlp/${username}`,
            }
          : "user not found",
        username ? 200 : 404
      )
    } else if (url.pathname.endsWith("/available")) {
      await reply({ available: true })
    } else {
      registrations++
      username = request.postDataJSON().username
      // Simulate a provider commit whose response is lost.
      await route.abort("failed")
    }
  })
  await page.goto(`${marketUrl}/wallet`)
  const urls = {
    signingFixture,
    client: source("packages/core/src/wallets/breez-lightning-address.ts"),
    curves: source("packages/core/node_modules/@noble/curves/secp256k1.js"),
    bytes: source("packages/core/node_modules/@noble/hashes/utils.js"),
  }
  const run = async () =>
    page.evaluate(async (urls) => {
      const { BreezLightningAddressClient } = await import(urls.client)
      const { secp256k1 } = await import(urls.curves)
      const { bytesToHex } = await import(urls.bytes)
      const secret = new Uint8Array(urls.signingFixture) // Fresh, non-funded test signer.
      const identity = bytesToHex(secp256k1.getPublicKey(secret))
      const create = () =>
        new BreezLightningAddressClient({
          domain: "conduit.cash",
          apiKey: "public-test-api-key",
          signer: {
            assertActive() {},
            getIdentityPublicKey: async () => identity,
            signDigest: async (digest: Uint8Array) =>
              secp256k1.sign(digest, secret, { prehash: false, format: "der" }),
          },
          runExclusive: (scope: string, operation: () => Promise<unknown>) =>
            navigator.locks.request(`fixture:breez:${scope}`, operation),
          store: {
            async read(scope: string) {
              const value = localStorage.getItem(`fixture:breez:${scope}`)
              return value ? JSON.parse(value) : null
            },
            async write(scope: string, value: unknown) {
              localStorage.setItem(
                `fixture:breez:${scope}`,
                JSON.stringify(value)
              )
            },
          },
        })
      const [first, second] = await Promise.all([
        create().ensure(),
        create().ensure(),
      ])
      return {
        sameAddress: first.address === second.address,
        registered:
          first.status === "registered" && second.status === "registered",
        publicVerified: first.publicLookup === "verified",
        receiveUnverified: first.receiveEvidence === "unverified",
      }
    }, urls)
  expect(await run()).toEqual({
    sameAddress: true,
    registered: true,
    publicVerified: true,
    receiveUnverified: true,
  })
  expect(registrations).toBe(1)
  await page.reload()
  expect(await run()).toMatchObject({ sameAddress: true, registered: true })
  expect(registrations).toBe(1)
})

test("Breez receive setup exposes an address and QR after verified public lookup @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/wallet`)
  await page.evaluate(
    async ({ componentUrl, reactUrl, domUrl }) => {
      const React = (await import(reactUrl)).default
      const ReactDOM = (await import(domUrl)).default
      const { SparkLightningAddress } = await import(componentUrl)
      const host = document.createElement("div")
      host.id = "address-control-fixture"
      // Isolate the mounted control from the application's fixed footer.
      host.style.cssText =
        "position:fixed;inset:80px 24px;z-index:1000;overflow:auto;background:var(--background)"
      document.body.append(host)
      ReactDOM.createRoot(host).render(
        React.createElement(SparkLightningAddress, {
          walletId: "test-existing-wallet",
          resolve: async (walletId: string, register: boolean) => {
            if (walletId !== "test-existing-wallet")
              throw new Error("Wrong selected wallet")
            return register
              ? {
                  status: "registered",
                  username: "wallet-fixture",
                  address: "wallet-fixture@conduit.cash",
                  lnurl:
                    "https://conduit.cash/.well-known/lnurlp/wallet-fixture",
                  publicLookup: "verified",
                  zapAdvertised: false,
                  receiveEvidence: "unverified",
                }
              : { status: "absent" }
          },
        })
      )
    },
    {
      componentUrl: source(
        "apps/market/src/components/SparkLightningAddress.tsx"
      ),
      reactUrl: "/@id/react",
      domUrl: "/@id/react-dom/client",
    }
  )
  const control = page.locator("#address-control-fixture")
  await control
    .getByRole("button", { name: "Set up Lightning address" })
    .click()
  await expect(control.getByRole("status")).toHaveText(
    "wallet-fixture@conduit.cash"
  )
  await expect(
    control.getByRole("img", { name: "Reusable Lightning address QR code" })
  ).toBeVisible()
  await expect(
    control.getByRole("button", { name: "Copy Lightning address" })
  ).toBeVisible()
})
