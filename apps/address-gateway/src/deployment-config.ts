interface DeploymentConfig {
  env?: { preview?: DeploymentConfig }
  d1_databases?: {
    binding?: string
    database_name?: string
    database_id?: string
    migrations_dir?: string
  }[]
  vars?: Record<string, string>
  observability?: { enabled?: boolean }
  ratelimits?: { name?: string; simple?: { limit?: number; period?: number } }[]
  workers_dev?: boolean
  preview_urls?: boolean
  routes?: { pattern?: string; zone_name?: string }[]
}
/** Credential-free validation. Secret values must never be provided here. */
export function validateGatewayDeployment(
  config: unknown,
  environment: "preview" | "production"
): void {
  const root = config as DeploymentConfig
  const selected = environment === "production" ? root : root.env?.preview
  const databases = selected?.d1_databases
  if (
    !Array.isArray(databases) ||
    databases.length !== 1 ||
    databases[0]?.binding !== "ADDRESS_REQUESTS" ||
    databases[0]?.database_name !==
      `conduit-address-requests${environment === "preview" ? "-preview" : ""}` ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      databases[0]?.database_id ?? ""
    ) ||
    databases[0]?.database_id === "00000000-0000-0000-0000-000000000000" ||
    databases[0]?.migrations_dir !== "migrations"
  )
    throw new Error(
      "Create and bind the dedicated request database before deployment."
    )
  const vars = selected?.vars ?? {}
  if (
    [
      "TURNSTILE_SECRET_KEY",
      "BREEZ_PROXY_SHARED_SECRET",
      "BREEZ_DOMAIN_API_KEY",
    ].some((key) => key in vars || key in (root.vars ?? {}))
  )
    throw new Error("Server credentials belong only in the secret store.")
  if (
    !["false", "true"].includes(vars.PROVIDER_PROXY_QUALIFIED ?? "") ||
    root.observability?.enabled !== false ||
    selected?.observability?.enabled === true ||
    !selected?.ratelimits?.some(
      (limit) =>
        limit.name === "REQUEST_RATE_LIMITER" &&
        limit.simple?.limit === 5 &&
        limit.simple?.period === 60
    )
  )
    throw new Error(
      "Explicit qualification, privacy and abuse controls are required."
    )
  if (environment === "production") {
    if (
      root.workers_dev !== false ||
      root.preview_urls !== false ||
      JSON.stringify(root.routes) !==
        JSON.stringify([
          { pattern: "conduit.cash/*", zone_name: "conduit.cash" },
        ]) ||
      vars.ALLOWED_ORIGINS !==
        "https://shop.conduit.market,https://sell.conduit.market" ||
      vars.TURNSTILE_HOSTNAMES !== "shop.conduit.market,sell.conduit.market"
    )
      throw new Error(
        "Production requires the reviewed domain route and exact app origins."
      )
  } else if (
    selected?.routes?.length !== 0 ||
    selected?.preview_urls !== false ||
    vars.PROVIDER_PROXY_QUALIFIED !== "false"
  )
    throw new Error(
      "Preview must not route production or enable custom-domain mutations."
    )
}
