type PagesFunctionContext = {
  request: Request
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  })
}

export async function onRequestPost({
  request: _request,
}: PagesFunctionContext): Promise<Response> {
  void _request
  return jsonResponse(
    { error: "Anon zap signer requires trusted checkout authorization." },
    403
  )
}

export function onRequest(): Response {
  return jsonResponse({ error: "Method not allowed." }, 405)
}
