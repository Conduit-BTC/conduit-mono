import { describe, expect, it } from "bun:test"
import { onRequest as authorize } from "../functions/api/anon-zap-authorize"
import { onRequest as sign } from "../functions/api/anon-zap-sign"
import { onRequest as tip } from "../functions/api/project-tip-sign"
import { onRequest as config } from "../functions/api/anon-zap-config"
import { onRequest as authority } from "../functions/api/zapout-authority"

describe("retired signer APIs", () => {
  for (const [name, handler] of Object.entries({
    authorize,
    sign,
    tip,
    config,
    authority,
  })) {
    it(`${name} fails explicitly without credentials, bindings, or provider calls`, async () => {
      const response = handler()
      expect(response.status).toBe(410)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({
        error:
          "Anonymous public zap signing has been retired. Use private checkout or a plain Lightning tip.",
      })
    })
  }
})
