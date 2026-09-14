import { expect, test, type Page } from "@playwright/test"
import { installTestSigner } from "./helpers/auth"

const BUYER_PUBKEY = "c".repeat(64)
const MERCHANT_PUBKEY = "d".repeat(64)
const SEED_MODULE = "/src/test-fixtures/direct-message-seed.ts"

async function seedMessages(
  page: Page,
  rows: { id: string; read: 0 | 1 }[]
): Promise<void> {
  await page.evaluate(
    async ([modulePath, rows, recipient, sender]) => {
      const seed = (await import(modulePath)) as {
        seedDirectMessages(
          rows: {
            id: string
            senderPubkey: string
            recipientPubkey: string
            read: 0 | 1
          }[]
        ): Promise<void>
      }
      await seed.seedDirectMessages(
        rows.map((row) => ({
          ...row,
          senderPubkey: sender,
          recipientPubkey: recipient,
        }))
      )
    },
    [SEED_MODULE, rows, BUYER_PUBKEY, MERCHANT_PUBKEY] as const
  )
}

async function markRead(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(
    async ([modulePath, ids]) => {
      const seed = (await import(modulePath)) as {
        markSeededDirectMessagesRead(ids: string[]): Promise<void>
      }
      await seed.markSeededDirectMessagesRead(ids)
    },
    [SEED_MODULE, ids] as const
  )
}

test("market header shows unread cached direct messages as a live icon badge @market", async ({
  page,
}) => {
  await installTestSigner(page, BUYER_PUBKEY)
  await page.goto("http://127.0.0.1:7000/products")
  await page.waitForLoadState("networkidle")

  const messages = page
    .getByRole("navigation", { name: "Market navigation" })
    .getByRole("button", { name: /^Messages/ })
  await expect(messages).toHaveAttribute("aria-label", "Messages, 0 unread")
  await expect(messages.getByText("Messages")).toHaveClass(/sr-only/)

  await seedMessages(page, [
    { id: "dm-1", read: 0 },
    { id: "dm-2", read: 0 },
    { id: "dm-3", read: 1 },
  ])
  await expect(messages).toHaveAttribute("aria-label", "Messages, 2 unread")
  await expect(messages.locator("span span")).toHaveText("2")

  await markRead(page, ["dm-1"])
  await expect(messages).toHaveAttribute("aria-label", "Messages, 1 unread")
  await expect(messages.locator("span span")).toHaveText("1")

  await markRead(page, ["dm-2"])
  await expect(messages).toHaveAttribute("aria-label", "Messages, 0 unread")
  await expect(messages.locator("span span")).toHaveCount(0)
})
