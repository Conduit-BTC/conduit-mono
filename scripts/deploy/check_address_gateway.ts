import { readFile } from "node:fs/promises"
import { validateGatewayDeployment } from "../../apps/address-gateway/src/deployment-config"
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
validateGatewayDeployment(config, environment as "preview" | "production")
console.log(
  JSON.stringify({
    check: "address-gateway-config",
    environment,
    approvedNames: registry.names.length,
    valid: true,
  })
)
