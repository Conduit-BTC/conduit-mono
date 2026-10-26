export async function boundedText(
  body: ReadableStream<Uint8Array> | null,
  max: number
): Promise<string> {
  if (!body) throw new Error("missing_body")
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel()
        throw new Error("body_limit")
      }
      parts.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    )
  } finally {
    reader.releaseLock()
  }
}
