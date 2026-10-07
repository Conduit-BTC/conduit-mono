import { expect, test } from "@playwright/test"
import { getEventHash, type EventTemplate } from "nostr-tools/pure"
import { createWrap } from "nostr-tools/nip59"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  encryptRuntimeTestPayload,
  installRealTestSigner,
  parseCanonicalRuntimePrivateRumor,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
  type RuntimeSignerIdentity,
} from "./helpers/real-nip07-signer"

// Synthetic identities and plaintext stay in the runner; no traces of private events.
test.use({ trace: "off", screenshot: "off", video: "off" })

for (const scenario of [
  "shipping",
  "legacy_handoff",
  "partial_history",
  "stale_cancel",
] as const) {
  test(`merchant completes ${scenario} without tracking and reloads the signed history @merchant`, async ({
    page,
  }, testInfo) => {
    const merchant = createRuntimeSignerIdentity()
    const buyer = createRuntimeSignerIdentity()
    const orderId = `completion-${scenario}`
    const createdAt = Math.floor(Date.now() / 1000) - 20 * 86400
    const wrap = (sender: RuntimeSignerIdentity, rumor: EventTemplate) => {
      const inner = { ...rumor, pubkey: sender.pubkey }
      const seal = signRuntimeTestEvent(sender, {
        kind: 13,
        created_at: createdAt,
        tags: [],
        content: encryptRuntimeTestPayload(
          sender,
          merchant.pubkey,
          JSON.stringify({ ...inner, id: getEventHash(inner) })
        ),
      })
      return createWrap(seal, merchant.pubkey)
    }
    try {
      const events = [merchant, buyer].flatMap((identity) => [
        signRuntimeTestEvent(identity, {
          kind: 10050,
          created_at: createdAt,
          tags: [["relay", TEST_RELAY_URL]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 10002,
          created_at: createdAt,
          tags: [["r", TEST_RELAY_URL]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: createdAt,
          tags: [],
          content: JSON.stringify({
            name:
              identity === buyer
                ? "Completion test buyer"
                : "Completion test merchant",
          }),
        }),
      ])
      if (scenario !== "partial_history")
        events.push(
          wrap(buyer, {
            kind: 16,
            created_at: createdAt,
            tags: [
              ["p", merchant.pubkey],
              ["type", "order"],
              ["order", orderId],
            ],
            content: JSON.stringify({
              id: orderId,
              merchantPubkey: merchant.pubkey,
              buyerPubkey: buyer.pubkey,
              items: [
                {
                  productId: "synthetic-product",
                  title: "Previously fulfilled item",
                  format: "physical",
                  quantity: 1,
                  priceAtPurchase: 21,
                  currency: "SATS",
                  ...(scenario === "shipping"
                    ? { fulfillment: { type: "shipping" } }
                    : {}),
                },
              ],
              subtotal: 21,
              currency: "SATS",
              createdAt: createdAt * 1000,
            }),
          })
        )
      events.push(
        wrap(merchant, {
          kind: 16,
          created_at: createdAt + 1,
          tags: [
            ["p", buyer.pubkey],
            ["type", "status_update"],
            ["order", orderId],
            ["status", "paid"],
          ],
          content: JSON.stringify({ status: "paid" }),
        })
      )
      await publishTestRelayEvents(events)
      await installRealTestSigner(page, merchant, TEST_RELAY_URL)
      await page.goto(
        `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}/orders?order=${orderId}`
      )
      const open = page.getByRole("button", {
        name: "Complete fulfilled order",
        exact: true,
      })
      await expect(open).toBeVisible({ timeout: 30_000 })
      await open.click()
      const dialog = page.getByRole("alertdialog")
      await expect(dialog).toBeVisible()
      await expect(
        dialog.getByLabel("Completion note (optional)")
      ).toBeVisible()
      await dialog
        .getByRole("button", { name: "Keep open", exact: true })
        .click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId("merchant-completion-record")).toHaveCount(
        0
      )
      await open.click()
      if (scenario !== "shipping") {
        await dialog.getByRole("combobox").click()
        await page
          .getByRole("option", {
            name: "Event purchase / picked up",
            exact: true,
          })
          .click()
        await expect(
          dialog.getByText("You are confirming a past handoff.", {
            exact: false,
          })
        ).toBeVisible()
      } else {
        await expect(dialog.getByRole("combobox")).toHaveCount(0)
      }
      if (scenario === "partial_history")
        await expect(dialog).toContainText("the buyer is not notified")
      await dialog
        .getByLabel("Completion note (optional)")
        .fill("Fulfilled previously; tracking unavailable")
      if (scenario !== "stale_cancel")
        await dialog.screenshot({
          path: testInfo.outputPath("completion-confirmation.png"),
        })
      await expect(dialog.getByLabel("Tracking number")).toHaveCount(0)
      await expect(dialog.getByLabel("Carrier")).toHaveCount(0)
      if (scenario === "stale_cancel") {
        await publishTestRelayEvents([
          wrap(merchant, {
            kind: 16,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["p", buyer.pubkey],
              ["type", "status_update"],
              ["order", orderId],
              ["status", "cancelled"],
            ],
            content: JSON.stringify({ status: "cancelled" }),
          }),
        ])
        await page.evaluate(async (root) => {
          const { readAuthSession } = await import(`${root}/remote-signer.ts`)
          const { getCommerceInbox } = await import(`${root}/commerce-inbox.ts`)
          await getCommerceInbox(readAuthSession().userPubkey).syncRecent()
        }, `/@fs${process.cwd()}/packages/core/src/protocol`)
        await expect(
          page.getByRole("button", {
            name: "Complete fulfilled order",
            exact: true,
            includeHidden: true,
          })
        ).toHaveCount(0, { timeout: 30_000 })
        await dialog
          .getByRole("button", {
            name: "Confirm picked up / complete",
            exact: true,
          })
          .click()
        await expect(dialog.getByRole("alert")).toContainText(
          "no longer eligible"
        )
        await expect(
          page.getByTestId("merchant-completion-record")
        ).toHaveCount(0)
        return
      }
      await dialog
        .getByRole("button", {
          name:
            scenario === "shipping"
              ? "Confirm delivered / complete"
              : "Confirm picked up / complete",
          exact: true,
        })
        .click()
      const record = page.getByTestId("merchant-completion-record")
      await expect(record).toContainText(
        "Fulfilled previously; tracking unavailable",
        { timeout: 30_000 }
      )
      await expect(dialog).toHaveCount(0)
      await expect(open).toHaveCount(0)
      await page.reload()
      await expect(record).toContainText(
        "Fulfilled previously; tracking unavailable",
        { timeout: 30_000 }
      )
      await expect(open).toHaveCount(0)
      const completions = async (identity: RuntimeSignerIdentity) =>
        (await readAuthenticatedGiftWraps(identity, TEST_RELAY_URL))
          .map((event) =>
            parseCanonicalRuntimePrivateRumor({
              inboxOwner: identity,
              recipient: buyer,
              sender: merchant,
              wrap: event,
            })
          )
          .filter(
            (rumor) =>
              rumor?.tags.some(
                ([name, value]) => name === "order" && value === orderId
              ) &&
              rumor.tags.some(
                ([name, value]) => name === "status" && value === "complete"
              )
          )
      await expect
        .poll(
          async () =>
            new Set((await completions(merchant)).map((rumor) => rumor!.id))
              .size
        )
        .toBe(1)
      expect((await completions(buyer)).length).toBe(
        scenario === "partial_history" ? 0 : 1
      )
      const saved = (await completions(merchant))[0]!
      const payload = JSON.parse(saved.content)
      expect(payload.completionBasis).toBe(
        scenario === "shipping"
          ? "delivered_without_tracking"
          : "historical_handoff"
      )
      expect(payload.trackingNumber).toBeUndefined()
      expect(payload.carrier).toBeUndefined()
    } finally {
      disposeRuntimeSignerIdentity(merchant)
      disposeRuntimeSignerIdentity(buyer)
    }
  })
}
