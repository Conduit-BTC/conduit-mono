import { handleAnonZapSignerRequest, type AnonZapSignerEnv } from "./signer"

export default {
  fetch(request: Request, env: AnonZapSignerEnv): Promise<Response> {
    return handleAnonZapSignerRequest(request, env)
  },
}
