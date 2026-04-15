import { FigmaMcpClient } from "./mcp_client"

function usage(): never {
  console.error(
    "Usage: bun scripts/figma/get_variable_defs.ts <nodeId|figma-url>"
  )
  process.exit(1)
}

function extractNodeId(input: string): string {
  const trimmed = input.trim()

  // Accept raw node IDs in "1:2" or "1-2" form.
  if (/^-?\d+[:-]-?\d+$/.test(trimmed)) return trimmed.replace("-", ":")

  // Attempt to parse `node-id=` from a Figma URL.
  try {
    const url = new URL(trimmed)
    const nodeId = url.searchParams.get("node-id")
    if (!nodeId) throw new Error("missing node-id")
    return nodeId.replace("-", ":")
  } catch {
    throw new Error(`Unable to extract node id from: ${input}`)
  }
}

const input = process.argv[2]
if (!input) usage()

const nodeId = extractNodeId(input)

const client = new FigmaMcpClient()

type ToolResult = {
  content: Array<{ type: string; text?: string }>
}

const res = await client.callTool("get_variable_defs", {
  nodeId,
  clientLanguages: "typescript,css",
  clientFrameworks: "react",
})

const toolRes = res as unknown as ToolResult
const firstText = toolRes.content?.find((c) => c.type === "text")?.text
if (!firstText) {
  console.log(JSON.stringify(toolRes, null, 2))
  process.exit(0)
}

try {
  console.log(JSON.stringify(JSON.parse(firstText), null, 2))
} catch {
  // Some servers already return a JSON string wrapped in text; print as-is if it doesn't parse.
  console.log(firstText)
}
