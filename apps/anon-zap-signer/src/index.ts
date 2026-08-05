import { handleAnonZapSignerRequest, type AnonZapSignerEnv } from "./signer"

type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void
}

export default {
  fetch(
    request: Request,
    env: AnonZapSignerEnv,
    context: WorkerExecutionContext
  ): Promise<Response> {
    return handleAnonZapSignerRequest(request, env, {
      waitUntil: (promise) => context.waitUntil(promise),
    })
  },
}
