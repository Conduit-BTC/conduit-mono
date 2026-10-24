// Disposable local gateway. Never binds Cloudflare or calls a live provider.
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import {
  handleAddressGateway,
  type AddressGatewayEnv,
  type ApprovedName,
} from "../../apps/address-gateway/src/gateway"
const db = new Database(":memory:")
db.exec(
  readFileSync(
    new URL(
      "../../apps/address-gateway/migrations/0001_address_requests.sql",
      import.meta.url
    ),
    "utf8"
  )
)
let approved: ApprovedName[] = []
let blocked = false
const env: AddressGatewayEnv = {
  ADDRESS_REQUESTS: {
    prepare(sql) {
      let values: unknown[] = []
      const statement = {
        bind(...next: unknown[]) {
          values = next
          return statement
        },
        async first<T>() {
          return db.query(sql).get(...(values as never[])) as T | null
        },
        async run() {
          const result = db.query(sql).run(...(values as never[]))
          return { success: true, meta: { changes: result.changes } }
        },
      }
      return statement
    },
  },
  ALLOWED_ORIGINS: process.env.ADDRESS_TEST_ORIGIN!,
  TURNSTILE_HOSTNAMES: "127.0.0.1",
  TURNSTILE_SECRET_KEY: "controlled",
  BREEZ_DOMAIN_API_KEY: "",
  BREEZ_PROXY_SHARED_SECRET: "",
  PROVIDER_PROXY_QUALIFIED: "false",
  REQUEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/control/approve") {
      const row = db
        .query(
          "SELECT desired_name, owner_pubkey, spark_identity FROM name_requests LIMIT 1"
        )
        .get() as {
        desired_name: string
        owner_pubkey: string
        spark_identity: string
      }
      approved = [
        {
          name: row.desired_name,
          ownerPubkey: row.owner_pubkey,
          sparkIdentity: row.spark_identity,
          registration: true,
        },
      ]
      return Response.json({ ok: true })
    }
    if (path === "/control/block") {
      blocked = true
      return Response.json({ ok: true })
    }
    if (path === "/control/count")
      return Response.json(
        db.query("SELECT count(*) AS count FROM name_requests").get()
      )
    return handleAddressGateway(
      new Request("https://conduit.cash" + path, {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : await request.arrayBuffer(),
      }),
      { ...env, ALLOWED_ORIGINS: blocked ? "" : env.ALLOWED_ORIGINS },
      approved,
      (async (_url, init) =>
        Response.json({
          success: JSON.parse(String(init?.body)).response === "controlled",
          hostname: "127.0.0.1",
          action: "address_name_request",
        })) as typeof fetch
    )
  },
})
console.log(`ADDRESS_GATEWAY_PORT:${server.port}`)
