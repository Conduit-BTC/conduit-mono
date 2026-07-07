import {
  getAnonZapSignerDevPort,
  handleAnonZapSignerRequest,
  type AnonZapSignerEnv,
} from "../../apps/anon-zap-signer/src/signer"

declare const process: { env: AnonZapSignerEnv }

if (import.meta.main) {
  const port = getAnonZapSignerDevPort(process.env)
  Bun.serve({
    port,
    fetch: (request) => handleAnonZapSignerRequest(request, process.env),
  })
  console.log(`Anon zap signer listening on http://localhost:${port}`)
}
