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
test("production pins only exact production origins and stages automatic previews disabled", () => {
  const config = configured()
  expect(config.vars.ALLOWED_ORIGINS).toBe(
    "https://shop.conduit.market,https://sell.conduit.market"
  )
  expect(config.vars.TURNSTILE_HOSTNAMES).toBe(
    "shop.conduit.market,sell.conduit.market"
  )
  expect(config.vars.TRUSTED_PREVIEWS_ENABLED).toBe("false")
  expect(() => validateGatewayDeployment(config, "production")).not.toThrow()
  config.vars.ALLOWED_ORIGINS += ",https://anything.pages.dev"
  expect(() => validateGatewayDeployment(config, "production")).toThrow(
    "exact app origins"
  )
})
test("automatic preview authorization requires reviewed account and server-only credential storage", () => {
  const config = configured()
  config.vars.TRUSTED_PREVIEWS_ENABLED = "true"
  expect(() => validateGatewayDeployment(config, "production")).toThrow(
    "reviewed Pages account"
  )
  Object.assign(config.vars, { PAGES_ACCOUNT_ID: "a".repeat(32) })
  expect(() => validateGatewayDeployment(config, "production")).not.toThrow()
  Object.assign(config.vars, { PAGES_READ_API_TOKEN: "must-not-be-public" })
  expect(() => validateGatewayDeployment(config, "production")).toThrow(
    "secret store"
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
