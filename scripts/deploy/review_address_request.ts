import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  proposeApprovedName,
  type StoredNameRequest,
} from "../../apps/address-gateway/src/request-review"

// A trusted operator exports one row privately. This offline candidate utility
// never obtains Cloudflare credentials or queries production.
if (import.meta.main) {
  try {
    const [evidencePath, proposalPath] = process.argv.slice(2)
    if (
      !evidencePath ||
      !proposalPath ||
      resolve(evidencePath) === resolve(proposalPath)
    )
      throw new Error()
    const evidence = await readFile(evidencePath, "utf8")
    if (Buffer.byteLength(evidence) > 32768) throw new Error()
    const row = JSON.parse(evidence) as StoredNameRequest
    const registry = JSON.parse(
      await readFile("apps/address-gateway/approved-names.json", "utf8")
    )
    const proposal = proposeApprovedName(registry, row)
    // Exclusive output protects the original manifest and private evidence.
    await writeFile(proposalPath, JSON.stringify(proposal, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    })
    console.log(
      JSON.stringify({
        check: "address-request-review",
        verdict: "proposal_written",
        approval: "required",
      })
    )
  } catch {
    console.error(
      JSON.stringify({ check: "address-request-review", verdict: "rejected" })
    )
    process.exitCode = 1
  }
}
