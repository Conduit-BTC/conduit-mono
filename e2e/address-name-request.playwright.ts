import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { expect, test, type Page } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { secp256k1 } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { sha256 } from "../packages/core/node_modules/@noble/hashes/sha2.js"
import { bytesToHex } from "../packages/core/node_modules/@noble/hashes/utils.js"
import type { UnsignedNostrEvent } from "../packages/core/src/protocol/nostr-event-signer"
import type {
  AddressNameRequest,
  SignedAddressNameRequest,
} from "../packages/core/src/wallets/address-name-request"
import type { AddressRequestRecord } from "../packages/core/src/wallets/address-request-record"
import type {
  AddressRequestView,
  AddressRequestWorkflowDependencies,
} from "../packages/core/src/wallets/address-request-workflow"
import { addressNameRequestMessage } from "../packages/core/src/wallets/address-name-request"
const market = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const source = (file: string) => `/@fs${path.resolve(process.cwd(), file)}`
test.use({ trace: "off", screenshot: "off", video: "off" })
async function fixture(page: Page, challengeFailsOnce = false) {
  const child: ChildProcess = spawn(
    "bun",
    ["e2e/fixtures/address-name-gateway.ts"],
    {
      env: { ...process.env, ADDRESS_TEST_ORIGIN: market },
      stdio: ["ignore", "pipe", "ignore"],
    }
  )
  page.on("close", () => child.kill())
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Controlled gateway did not become ready")),
      10_000
    )
    let buffered = ""
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("Controlled gateway exited"))
    })
    child.stdout!.on("data", (chunk) => {
      // Dependencies can emit startup notices. Consume only the explicit,
      // content-free handshake; never forward child output into evidence.
      buffered = (buffered + String(chunk)).slice(-4096)
      const match = /^ADDRESS_GATEWAY_PORT:(\d+)$/m.exec(buffered)
      if (!match) return
      clearTimeout(timer)
      resolve(Number(match[1]))
    })
  })
  const base = `http://127.0.0.1:${port}`
  let accountSigns = 0
  const secret = generateSecretKey(),
    wallet = generateSecretKey(),
    owner = getPublicKey(secret)
  await page.exposeFunction(
    "__nameSignAccount",
    (draft: UnsignedNostrEvent) => {
      accountSigns++
      return finalizeEvent(draft, secret)
    }
  )
  await page.exposeFunction(
    "__nameSignWallet",
    (draft: Omit<AddressNameRequest, "sparkIdentity">) => {
      const value = {
        ...draft,
        sparkIdentity: bytesToHex(secp256k1.getPublicKey(wallet)),
      }
      return {
        ...value,
        walletSignature: bytesToHex(
          secp256k1.sign(
            sha256(new TextEncoder().encode(addressNameRequestMessage(value))),
            wallet,
            { prehash: false, format: "der" }
          )
        ),
      }
    }
  )
  await page.route("https://**/*", (route) => route.abort())
  await page.goto(`${market}/wallet`)
  await page.evaluate(
    async ({
      component,
      workflow,
      owner,
      reactUrl,
      domUrl,
      challengeFailsOnce,
      base,
    }) => {
      const React = (await import(reactUrl)).default
      const dom = (await import(domUrl)).default
      const { AddressNameRequestForm } = await import(component)
      const { createAddressRequestWorkflow } = await import(workflow)
      // Use the real browser CORS/preflight stack against the disposable gateway.
      // The fixture gateway verifies the canonical https://conduit.cash proof URL.
      const originalFetch = window.fetch.bind(window)
      const gatewayFetch: typeof fetch = (input, init) =>
        typeof input === "string" &&
        input.startsWith("https://conduit.cash/api/name-requests")
          ? originalFetch(base + new URL(input).pathname, init)
          : originalFetch(input, init)
      window.fetch = gatewayFetch
      let retained: AddressRequestView | undefined
      const scope = window as typeof window & {
        turnstile: {
          render(
            node: HTMLElement,
            options: { callback(token: string): void; "error-callback"(): void }
          ): string
          remove(): void
        }
        __nameSignWallet(
          draft: Omit<AddressNameRequest, "sparkIdentity">
        ): Promise<SignedAddressNameRequest>
        __nameSignAccount: AddressRequestWorkflowDependencies["signAccount"]
      }
      scope.turnstile = {
        render: (_node, options) => {
          if (challengeFailsOnce) {
            challengeFailsOnce = false
            queueMicrotask(() => options["error-callback"]())
          } else queueMicrotask(() => options.callback("controlled"))
          return "controlled-widget"
        },
        remove() {},
      }
      const submit = createAddressRequestWorkflow({
        owner,
        assertCurrent() {},
        load: async () => retained,
        save: async (_id: string, record: AddressRequestRecord) => {
          retained = { record, publication: "local" as const }
          return retained
        },
        signWallet: async (
          _id: string,
          draft: Omit<AddressNameRequest, "sparkIdentity">
        ) => scope.__nameSignWallet(draft),
        signAccount: scope.__nameSignAccount,
        fetch,
        address: async () => ({ status: "absent" }),
        publishProfile: async () => {
          throw new Error("No live activation in this fixture")
        },
      })
      const host = document.createElement("div")
      host.id = "name-request-fixture"
      host.style.cssText =
        "position:fixed;inset:80px 24px;z-index:1000;overflow:auto;background:var(--background)"
      document.body.append(host)
      dom.createRoot(host).render(
        React.createElement(AddressNameRequestForm, {
          walletId: "controlled-wallet",
          ownerPubkey: owner,
          submit,
          onActivated: async () => {},
          siteKey: "controlled-site-key",
        })
      )
    },
    {
      component: source(
        "packages/ui/src/components/AddressNameRequestForm.tsx"
      ),
      workflow: source("packages/core/src/wallets/address-request-workflow.ts"),
      owner,
      challengeFailsOnce,
      base,
      reactUrl: "/@id/react",
      domUrl: "/@id/react-dom/client",
    }
  )
  return {
    base,
    accountSigns: () => accountSigns,
    close: () => child.kill(),
    control: page.locator("#name-request-fixture"),
  }
}
test("signed name submission and approved status use the actual controlled gateway @market", async ({
  page,
}) => {
  const f = await fixture(page)
  try {
    if (process.env.CONDUIT_DEPLOYMENT_PROFILE === "preview")
      await expect(f.control).toContainText(
        "This preview creates real @conduit.cash name requests."
      )
    await f.control
      .getByRole("textbox", { name: "Desired name" })
      .fill("preview-test")
    await f.control
      .getByRole("button", { name: "Request name", exact: true })
      .click()
    await expect(f.control.getByRole("status")).toContainText(
      "Pending approval"
    )
    expect(await (await fetch(f.base + "/control/count")).json()).toEqual({
      count: 1,
    })
    await fetch(f.base + "/control/approve")
    await f.control
      .getByRole("button", { name: "Check request status" })
      .click()
    await expect(f.control.getByRole("status")).toContainText("Name approved")
    await expect(
      f.control.getByRole("button", { name: "Activate and use address" })
    ).toBeEnabled()
    expect(await (await fetch(f.base + "/control/count")).json()).toEqual({
      count: 1,
    })
  } finally {
    f.close()
  }
})
test("gateway authorization denial is clear and creates no request @market", async ({
  page,
}) => {
  const f = await fixture(page)
  try {
    await f.control
      .getByRole("textbox", { name: "Desired name" })
      .fill("preview-test")
    await expect(
      f.control.getByRole("button", { name: "Request name", exact: true })
    ).toBeEnabled()
    await fetch(f.base + "/control/block")
    await f.control
      .getByRole("textbox", { name: "Desired name" })
      .fill("preview-test")
    await f.control
      .getByRole("button", { name: "Request name", exact: true })
      .click()
    await expect(f.control.getByRole("alert")).toContainText("not authorized")
    expect(await (await fetch(f.base + "/control/count")).json()).toEqual({
      count: 0,
    })
    await expect(f.control).not.toContainText("Submission is uncertain")
  } finally {
    f.close()
  }
})

test("security-check recovery does not implicitly submit or sign a request @market", async ({
  page,
}) => {
  const f = await fixture(page, true)
  try {
    await expect(f.control.getByRole("alert")).toContainText(
      "Security check unavailable or expired"
    )
    await f.control
      .getByRole("textbox", { name: "Desired name" })
      .fill("preview-test")
    await f.control
      .getByRole("button", { name: "Retry security check" })
      .click()
    await expect(
      f.control.getByRole("button", { name: "Request name", exact: true })
    ).toBeEnabled()
    expect(f.accountSigns()).toBe(0)
    expect(await (await fetch(f.base + "/control/count")).json()).toEqual({
      count: 0,
    })
  } finally {
    f.close()
  }
})
