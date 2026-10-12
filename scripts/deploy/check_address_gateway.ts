import { readFile } from "node:fs/promises"
import {
  validateApprovedNames,
  type ApprovedName,
} from "../../apps/address-gateway/src/gateway"
const registry = JSON.parse(
  await readFile("apps/address-gateway/approved-names.json", "utf8")
) as { version: number; names: ApprovedName[] }
if (registry.version !== 1)
  throw new Error("Unknown approved-name registry version.")
validateApprovedNames(registry.names)
const environment = process.argv[2] ?? "preview"
if (!["preview", "production"].includes(environment))
  throw new Error("Choose preview or production.")
const config = JSON.parse(
  await readFile("apps/address-gateway/wrangler.json", "utf8")
)
const selected = environment === "preview" ? config.env.preview : config
if (
  selected.d1_databases.some(
    (database: { database_id: string }) =>
      database.database_id === "00000000-0000-0000-0000-000000000000"
  )
)
  throw new Error(
    "Create and bind the dedicated request database before deployment."
  )
if (
  environment === "production" &&
  (config.workers_dev !== false || config.preview_urls !== false)
)
  throw new Error("Production must use only the approved cash-domain route.")
console.log(
  JSON.stringify({
    check: "address-gateway-config",
    environment,
    approvedNames: registry.names.length,
    valid: true,
  })
)
