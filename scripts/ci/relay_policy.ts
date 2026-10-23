import ts from "typescript"

export interface RelayPolicySource {
  path: string
  content: string
}
export interface RelayPolicyFinding {
  path: string
  line: number
  rule: "endpoint-owner" | "configured-grant-owner" | "transport-owner"
  detail: string
}

// Existing shared policy owners; feature modules must consume their interfaces.
const configuredGrantOwners = new Set([
  "packages/core/src/protocol/account-network-local-state.ts",
  "packages/core/src/protocol/account-storage-relay-policy.ts",
  "packages/core/src/protocol/relay-planner.ts",
  "packages/core/src/protocol/private-message-routing.ts",
  "packages/core/src/protocol/owner-relay-list-evidence.ts",
  "packages/core/src/protocol/account-network-mutation.ts",
  "packages/core/src/protocol/relay-publish.ts",
])
// Exact adapters, rather than a directory-wide exemption for raw transports.
const transports = new Map([
  ["packages/core/src/protocol/relay-reader.ts", "WebSocket"],
  ["packages/core/src/protocol/relay-writer.ts", "WebSocket"],
  ["packages/core/src/protocol/relay-executor.ts", "WebSocket"],
  ["packages/core/src/protocol/ndk.ts", "NDK"],
  ["apps/market/src/hooks/useLivePresenceCount.ts", "WebSocket"],
  ["scripts/smoke/nip42_protected_read.ts", "WebSocket"],
  ["scripts/dev/seed_products.ts", "NDK"],
  ["scripts/publish_nip89_handlers.ts", "NDK"],
])
// These declarations belong to another protocol or an offline, network-blocked census.
// The exception is tied to the declaration, not every endpoint in the file.
const endpointDeclarations = new Map([
  [
    "apps/market/src/lib/live-presence.ts",
    new Set([
      "PREVIEW_LIVE_PRESENCE_WEBSOCKET_URL",
      "PREVIOUS_PREVIEW_LIVE_PRESENCE_WEBSOCKET_URL",
      "PRODUCTION_LIVE_PRESENCE_WEBSOCKET_URL",
    ]),
  ],
  [
    "scripts/dev/measure_checkout_spark_merchant_lifecycle.ts",
    new Set(["INBOX"]),
  ],
])

export function inspectRelayPolicy(
  sources: readonly RelayPolicySource[]
): RelayPolicyFinding[] {
  const findings: RelayPolicyFinding[] = []
  for (const { path, content } of sources) {
    // Controlled fixtures are audited as a separate authority, never app defaults.
    if (
      /^(tests|e2e)\//.test(path) ||
      /\/test-fixtures\//.test(path) ||
      /\.test\.[cm]?[jt]sx?$/.test(path)
    )
      continue
    const source = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const aliases = new Map<string, string>()
    const initializers = new Map<string, ts.Expression>()
    const add = (
      node: ts.Node,
      rule: RelayPolicyFinding["rule"],
      detail: string
    ) =>
      findings.push({
        path,
        rule,
        detail,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      })
    const collect = (node: ts.Node) => {
      if (ts.isImportSpecifier(node))
        aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      )
        initializers.set(node.name.text, node.initializer)
      ts.forEachChild(node, collect)
    }
    collect(source)
    const unwrap = (expression: ts.Expression): ts.Expression => {
      while (
        ts.isAsExpression(expression) ||
        ts.isParenthesizedExpression(expression) ||
        ts.isSatisfiesExpression(expression)
      )
        expression = expression.expression
      return expression
    }
    const configuredKind = (
      expression: ts.Expression,
      seen = new Set<string>()
    ): string | undefined => {
      const value = unwrap(expression)
      if (ts.isIdentifier(value) && !seen.has(value.text)) {
        seen.add(value.text)
        const initializer = initializers.get(value.text)
        return initializer ? configuredKind(initializer, seen) : undefined
      }
      if (!ts.isObjectLiteralExpression(value)) return undefined
      for (const property of value.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText(source).replace(/["']/g, "") === "kind"
        ) {
          const kind = unwrap(property.initializer)
          if (
            ts.isStringLiteralLike(kind) &&
            ["app", "public_fallback", "compatibility", "discovery"].includes(
              kind.text
            )
          )
            return kind.text
        }
      }
      return undefined
    }
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) && /^wss?:\/\/[^\s]+/.test(node.text)) {
        const parent = node.parent
        const placeholder =
          ts.isJsxAttribute(parent) &&
          parent.name.getText(source) === "placeholder"
        const declaration =
          ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
            ? parent.name.text
            : undefined
        const owned =
          declaration && endpointDeclarations.get(path)?.has(declaration)
        let loopback = false
        try {
          loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
            new URL(node.text).hostname
          )
        } catch {
          /* Invalid executable endpoints also fail ownership. */
        }
        if (
          !loopback &&
          !placeholder &&
          !owned &&
          path !== "packages/core/src/config.ts"
        )
          add(
            node,
            "endpoint-owner",
            "Executable relay endpoint must be centrally registered"
          )
      }
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression)
          ? (aliases.get(node.expression.text) ?? node.expression.text)
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : ""
        if (
          name === "relayTargetsFromUrls" &&
          node.arguments[1] &&
          configuredKind(node.arguments[1]) &&
          !configuredGrantOwners.has(path)
        )
          add(
            node,
            "configured-grant-owner",
            "Use configuredRelayTargets; features cannot manufacture configured authority"
          )
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const name = aliases.get(node.expression.text) ?? node.expression.text
        if (
          ["WebSocket", "NDK"].includes(name) &&
          transports.get(path) !== name
        )
          add(
            node,
            "transport-owner",
            "Use an audited shared transport or explicit operator adapter"
          )
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return findings
}
