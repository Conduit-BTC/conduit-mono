import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import type { StoredMessage } from "../packages/core/src/db"
import { isUnreadInboundDirectMessage } from "../packages/core/src/protocol/direct-message-unread"

function row(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: "m1",
    senderPubkey: "a".repeat(64),
    recipientPubkey: "b".repeat(64),
    content: "",
    kind: 14,
    createdAt: 1,
    read: 0,
    ...overrides,
  }
}

describe("unread direct message count", () => {
  it("counts unopened kind-14 and legacy kind-4 rows only", () => {
    expect(isUnreadInboundDirectMessage(row({}))).toBe(true)
    expect(isUnreadInboundDirectMessage(row({ kind: 4 }))).toBe(true)
    expect(isUnreadInboundDirectMessage(row({ read: 1 }))).toBe(false)
    expect(isUnreadInboundDirectMessage(row({ kind: 1059 }))).toBe(false)
  })

  it("shows the count as an icon badge in the Market header without relay reads", async () => {
    const [header, hook] = await Promise.all([
      readFile("apps/market/src/components/MarketHeader.tsx", "utf8"),
      readFile(
        "packages/core/src/hooks/useUnreadDirectMessageCount.ts",
        "utf8"
      ),
    ])

    expect(header).toContain("useUnreadDirectMessageCount(")
    expect(header).toContain("badge={unreadMessages}")
    expect(header).toContain("`Messages, ${unreadMessages} unread`")
    expect(hook).toContain("subscribeUnreadDirectMessageCount(")
    expect(hook).toContain("snapshot?.principalPubkey !== principalPubkey")
    expect(hook).not.toMatch(/from "\.\.\/protocol\/(ndk|commerce)"/)
    expect(hook).not.toContain("fetchEvents")
  })
})
