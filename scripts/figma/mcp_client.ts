type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: number
  method: string
  params?: unknown
}

type InitializeResult = {
  protocolVersion: string
  capabilities: unknown
  serverInfo: { name: string; version: string }
}

function parseFirstSseMessage(body: string): unknown {
  // Streamable HTTP uses SSE. We only need the first message for one-shot calls.
  const lines = body.split("\n")
  const dataLine = lines.find((l) => l.startsWith("data: "))
  if (!dataLine) throw new Error("MCP response missing SSE data line")
  const json = dataLine.slice("data: ".length).trim()
  return JSON.parse(json)
}

export class FigmaMcpClient {
  private readonly url: string
  private sessionId: string | null = null

  constructor(url = "http://127.0.0.1:3845/mcp") {
    this.url = url
  }

  private async post(
    req: JsonRpcRequest
  ): Promise<{ headers: Headers; bodyText: string }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    })
    const text = await res.text()
    return { headers: res.headers, bodyText: text }
  }

  async initialize(): Promise<InitializeResult> {
    const { headers, bodyText } = await this.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "conduit-mono", version: "0" },
      },
    })

    const sessionId = headers.get("mcp-session-id")
    if (!sessionId)
      throw new Error("MCP response missing mcp-session-id header")
    this.sessionId = sessionId

    const msg = parseFirstSseMessage(bodyText) as {
      result?: InitializeResult
      error?: unknown
    }
    if (!msg.result)
      throw new Error(
        `MCP initialize failed: ${JSON.stringify(msg.error ?? msg)}`
      )

    // Complete the init handshake. This is a notification (no id).
    await this.post({ jsonrpc: "2.0", method: "initialized" })

    return msg.result
  }

  async callTool<TArgs extends Record<string, unknown>, TResult>(
    name: string,
    args: TArgs
  ): Promise<TResult> {
    if (!this.sessionId) await this.initialize()

    const { bodyText } = await this.post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    })

    const msg = parseFirstSseMessage(bodyText) as {
      result?: { content?: unknown[] }
      error?: unknown
    }
    if (!msg.result)
      throw new Error(
        `MCP tools/call failed: ${JSON.stringify(msg.error ?? msg)}`
      )
    return msg.result as unknown as TResult
  }
}
