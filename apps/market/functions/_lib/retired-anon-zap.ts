/** Cached clients must receive an explicit failure, never a fake signature. */
export function retiredAnonZapResponse(): Response {
  return Response.json(
    {
      error:
        "Anonymous public zap signing has been retired. Use private checkout or a plain Lightning tip.",
    },
    { status: 410, headers: { "cache-control": "no-store" } }
  )
}
