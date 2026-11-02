// Browser builds select this entry before schemas are initialized. Zod's
// default code-generation probe is blocked (and reported) by the browser CSP.
import { config } from "zod/v4"

config({ jitless: true })

export * from "zod/v4"
export { default } from "zod/v4"
