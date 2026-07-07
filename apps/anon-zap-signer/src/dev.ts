import {
  getAnonZapSignerDevPort,
  handleAnonZapSignerRequest,
  type AnonZapSignerEnv,
} from "./signer"

declare const Bun: {
  serve(options: {
    port: number
    fetch: (request: Request) => Response | Promise<Response>
  }): unknown
}
declare const process: { env: AnonZapSignerEnv }

const port = getAnonZapSignerDevPort(process.env)

Bun.serve({
  port,
  fetch: (request) => handleAnonZapSignerRequest(request, process.env),
})

console.log(`Anon zap signer listening on http://localhost:${port}`)
