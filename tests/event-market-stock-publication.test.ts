import { expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { merchantStockCheckpointNotice } from "../apps/merchant/src/lib/merchant-occurrence-publication"
import type { MerchantStockCheckpointOutcome } from "@conduit/core"

it("the actual saved-stock Retry handler uses the observed publication path", async () => {
  const source = ts.createSourceFile(
    "EventMarketStockPanel.tsx",
    readFileSync(
      new URL(
        "../apps/merchant/src/components/EventMarketStockPanel.tsx",
        import.meta.url
      ),
      "utf8"
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const handlers: ts.Expression[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(source) === "Button" &&
      node.children.some(
        (child) =>
          ts.isJsxText(child) &&
          child.text.trim() === "Retry saved stock updates"
      )
    ) {
      const attribute = node.openingElement.attributes.properties.find(
        (property) =>
          ts.isJsxAttribute(property) &&
          property.name.getText(source) === "onClick"
      )
      if (
        attribute &&
        ts.isJsxAttribute(attribute) &&
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression
      )
        handlers.push(attribute.initializer.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(handlers).toHaveLength(1)
  const state: {
    helper: number
    direct: number
    current: boolean
    notice?: string
    work?: Promise<void>
  } = { helper: 0, direct: 0, current: true }
  const execute = new Function(
    "run",
    "resumeStockPublication",
    "resumeMerchantOccurrencePublication",
    "account",
    "shouldContinue",
    "setNotice",
    `${ts.transpile(`const handler = ${handlers[0]!.getText(source)}`, { target: ts.ScriptTarget.ES2022 })}\nreturn handler`
  ) as (...dependencies: unknown[]) => () => void
  const checkpointNotice =
    "Stock recovery checkpoint pending: inbox acknowledgement."
  const click = execute(
    (operation: () => Promise<void>) => {
      state.work = operation()
    },
    async () => {
      state.helper++
      return checkpointNotice
    },
    async () => {
      state.direct++
      return { signed: 0, delivered: 0, pending: 1 }
    },
    "test-account",
    () => state.current,
    (notice: string) => {
      state.notice = notice
    }
  )
  click()
  await state.work
  expect(state.helper).toBe(1)
  expect(state.direct).toBe(0)
  expect(state.notice).toBe(
    `Retried the exact saved stock updates; no stock decision was repeated. ${checkpointNotice}`
  )
  state.current = false
  state.notice = undefined
  click()
  await state.work
  expect(state.helper).toBe(2)
  expect(state.direct).toBe(0)
  expect(state.notice).toBeUndefined()
})

it("shows a fixed checkpoint stage for only the current Event stock", () => {
  const notice = merchantStockCheckpointNotice(
    ["current-product"],
    [
      {
        productCoordinate: "outside-product",
        status: "pending",
        phase: "wrapping",
      },
      {
        productCoordinate: "current-product",
        status: "pending",
        phase: "delivery_ack",
      },
    ]
  )
  expect(notice).toBe(
    "Stock recovery checkpoint pending: inbox acknowledgement."
  )
  expect(notice.includes("product")).toBe(false)
})

it("does not turn unrelated queue failures or missing observations into Event success", () => {
  const acknowledged: MerchantStockCheckpointOutcome = {
    productCoordinate: "current-product",
    status: "acknowledged",
    phase: "freshness",
  }
  expect(
    merchantStockCheckpointNotice(
      ["current-product"],
      [
        {
          productCoordinate: "outside-product",
          status: "pending",
          phase: "snapshot",
        },
        acknowledged,
      ]
    )
  ).toBe("This Event's stock recovery checkpoints were acknowledged.")
  expect(
    merchantStockCheckpointNotice(
      ["current-product", "missing-product"],
      [acknowledged]
    )
  ).toBe(
    "Stock recovery checkpoint status is not confirmed for all current Event stock."
  )
  expect(merchantStockCheckpointNotice(["current-product"], [])).toBe("")
  expect(merchantStockCheckpointNotice([], [acknowledged])).toBe("")
  expect(
    merchantStockCheckpointNotice(["different-product"], [acknowledged])
  ).toBe("")
})

it("uses only fixed allowlisted phase copy and the latest per-product outcome", () => {
  const expected = {
    snapshot: "Stock recovery checkpoint pending: local snapshot preparation.",
    wrapping: "Stock recovery checkpoint pending: private message wrapping.",
    delivery_ack: "Stock recovery checkpoint pending: inbox acknowledgement.",
    freshness: "Stock recovery checkpoint pending: current stock recheck.",
  }
  for (const [phase, copy] of Object.entries(expected)) {
    expect(
      merchantStockCheckpointNotice(
        ["current-product"],
        [
          {
            productCoordinate: "current-product",
            status: "pending",
            phase: phase as MerchantStockCheckpointOutcome["phase"],
          },
        ]
      )
    ).toBe(copy)
  }
  expect(
    merchantStockCheckpointNotice(
      ["current-product"],
      [
        {
          productCoordinate: "current-product",
          status: "pending",
          phase: "wrapping",
        },
        {
          productCoordinate: "current-product",
          status: "acknowledged",
          phase: "snapshot",
        },
      ]
    )
  ).toBe("This Event's stock recovery checkpoints were acknowledged.")
  expect(
    merchantStockCheckpointNotice(
      ["current-product"],
      [
        {
          productCoordinate: "current-product",
          status: "pending",
          phase:
            "untrusted-dynamic-data" as MerchantStockCheckpointOutcome["phase"],
        },
      ]
    )
  ).toBe("Stock recovery checkpoint status is not confirmed.")
})
