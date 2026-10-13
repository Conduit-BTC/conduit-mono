import { expect, test } from "@playwright/test"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"

test.use({ trace: "off", screenshot: "off", video: "off" })

test("orders resume coalesces reads while explicit Refresh queues a fresh read @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    const relayUrl = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
    await installRealTestSigner(page, identity, relayUrl)
    await page.goto(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}/orders`
    )
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    const root = `/@fs${process.cwd()}/packages/core/src/protocol`
    await page.evaluate(
      async ({ root, relayUrl }) => {
        const { readAuthSession } = await import(`${root}/auth-session.ts`)
        const { getCommerceInbox } = await import(`${root}/commerce-inbox.ts`)
        const principal = readAuthSession().userPubkey
        const owner = getCommerceInbox(principal)
        await owner.syncRecent()
        const sync = owner.syncRecent.bind(owner)
        const refresh = owner.refreshRecent.bind(owner)
        let release = () => {}
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        const state = {
          reads: 0,
          refreshes: 0,
          pending: [] as Promise<unknown>[],
          release,
        }
        const options = {
          includeLegacy: false,
          declaration: {
            pubkey: principal,
            state: "declared",
            relayUrls: [relayUrl],
            stale: false,
            fetchedAt: Date.now(),
          },
          read: async () => {
            state.reads++
            await held
            return {
              events: [],
              coverage: "complete",
              auth: {
                state: "not_challenged",
                challengedCount: 0,
                succeededCount: 0,
                failedCount: 0,
              },
              relayResult: {
                status: "success",
                observations: [],
                relays: [],
                attemptedCount: 1,
                completedCount: 1,
                failedCount: 0,
                authoritativeEmpty: true,
              },
            }
          },
        }
        owner.syncRecent = () => {
          const pending = sync(options)
          state.pending.push(pending)
          return pending
        }
        owner.refreshRecent = () => {
          state.refreshes++
          const pending = refresh(options)
          state.pending.push(pending)
          return pending
        }
        Object.assign(window, { __inboxRefreshProbe: state })
      },
      { root, relayUrl }
    )
    const counts = () =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __inboxRefreshProbe: { reads: number; refreshes: number }
          }
        ).__inboxRefreshProbe
        return { reads: state.reads, refreshes: state.refreshes }
      })
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"))
      window.dispatchEvent(new Event("online"))
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await expect.poll(counts).toEqual({ reads: 1, refreshes: 0 })
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect.poll(counts).toEqual({ reads: 1, refreshes: 1 })
    await page.evaluate(async () => {
      const state = (
        window as unknown as {
          __inboxRefreshProbe: {
            release: () => void
            pending: Promise<unknown>[]
          }
        }
      ).__inboxRefreshProbe
      state.release()
      await Promise.all(state.pending)
    })
    expect(await counts()).toEqual({ reads: 2, refreshes: 1 })
  } finally {
    await page.close()
    disposeRuntimeSignerIdentity(identity)
  }
})
