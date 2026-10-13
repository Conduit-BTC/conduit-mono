import { expect, test } from "bun:test"
import source from "../apps/address-gateway/wrangler.json"
import { validateGatewayDeployment } from "../apps/address-gateway/src/deployment-config"

test("placeholder bindings block either environment before deployment", () => {
  const config = structuredClone(source)
  config.d1_databases[0]!.database_id = "00000000-0000-0000-0000-000000000000"
  config.env.preview.d1_databases[0]!.database_id =
    "00000000-0000-0000-0000-000000000000"
  for (const env of ["preview", "production"] as const)
    expect(() => validateGatewayDeployment(config, env)).toThrow(
      "dedicated request database"
    )
})
function configured() {
  const config = structuredClone(source)
  config.d1_databases[0]!.database_id = crypto.randomUUID()
  config.env.preview.d1_databases[0]!.database_id = crypto.randomUUID()
  return config
}
test("dedicated bindings permit offline config validation without credentials", () => {
  for (const env of ["preview", "production"] as const)
    expect(() => validateGatewayDeployment(configured(), env)).not.toThrow()
})
test("production pins the one Merchant release preview without admitting another preview", () => {
  const config = configured()
  const merchantOrigin =
    "https://feat-conduit-cash-release.conduit-merchant-33n.pages.dev"
  expect(config.vars.ALLOWED_ORIGINS.split(",")).toContain(merchantOrigin)
  expect(config.vars.TURNSTILE_HOSTNAMES.split(",")).toContain(
    new URL(merchantOrigin).hostname
  )
  expect(() => validateGatewayDeployment(config, "production")).not.toThrow()
  config.vars.ALLOWED_ORIGINS +=
    ",https://another-preview.conduit-merchant-33n.pages.dev"
  expect(() => validateGatewayDeployment(config, "production")).toThrow(
    "exact app origins"
  )
  config.vars.ALLOWED_ORIGINS = source.vars.ALLOWED_ORIGINS
  config.vars.TURNSTILE_HOSTNAMES +=
    ",another-preview.conduit-merchant-33n.pages.dev"
  expect(() => validateGatewayDeployment(config, "production")).toThrow(
    "exact app origins"
  )
})
test("production rejects missing binding, changed origins, exposed credentials and logging", () => {
  for (const mutate of [
    (c: ReturnType<typeof configured>) => {
      c.d1_databases = []
    },
    (c: ReturnType<typeof configured>) => {
      c.vars.ALLOWED_ORIGINS = "*"
    },
    (c: ReturnType<typeof configured>) => {
      c.routes = []
    },
    (c: ReturnType<typeof configured>) => {
      c.workers_dev = true
    },
    (c: ReturnType<typeof configured>) => {
      c.observability.enabled = true
    },
    (c: ReturnType<typeof configured>) => {
      c.ratelimits = []
    },
    (c: ReturnType<typeof configured>) => {
      Object.assign(c.vars, { BREEZ_DOMAIN_API_KEY: crypto.randomUUID() })
    },
  ]) {
    const config = configured()
    mutate(config)
    expect(() => validateGatewayDeployment(config, "production")).toThrow()
  }
})
test("preview cannot enable provider mutations or bind the cash domain", () => {
  const config = configured()
  config.env.preview.vars.PROVIDER_PROXY_QUALIFIED = "true"
  expect(() => validateGatewayDeployment(config, "preview")).toThrow()
})
