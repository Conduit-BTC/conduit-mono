import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { format, resolveConfig } from "prettier"
import { SHIPPING_COUNTRIES } from "../packages/core/src/protocol/countries"

// Usage: bun scripts/generate-merchant-places.ts cities500.zip admin1CodesASCII.txt admin2Codes.txt
const [citiesPath, admin1Path, admin2Path] = process.argv.slice(2)
if (!citiesPath || !admin1Path || !admin2Path) {
  throw new Error(
    "Pass cities500.zip, admin1CodesASCII.txt, and admin2Codes.txt"
  )
}

const sourcePaths = [citiesPath, admin1Path, admin2Path]
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex")
const sources = sourcePaths.map((path) => ({
  name: path.split("/").at(-1),
  sha256: sha256(readFileSync(path)),
}))
const unzipped = spawnSync("unzip", ["-p", citiesPath, "cities500.txt"], {
  encoding: "utf8",
  maxBuffer: 100 * 1024 * 1024,
})
if (unzipped.status !== 0)
  throw new Error(unzipped.stderr || "Could not read cities500.zip")

const admin1 = new Map<string, string>()
for (const line of readFileSync(admin1Path, "utf8").split("\n")) {
  const [code, name] = line.split("\t")
  if (code && name) admin1.set(code, name)
}
const admin2 = new Map<string, string>()
for (const line of readFileSync(admin2Path, "utf8").split("\n")) {
  const [code, name] = line.split("\t")
  if (code && name) admin2.set(code, name)
}
const accepted = new Set(SHIPPING_COUNTRIES.map(({ code }) => code))
type PlaceRow = [number, string, string, string, number, number, number]
const byCountry = new Map<string, PlaceRow[]>(
  [...accepted].map((code) => [code, []])
)
const usByState = new Map<string, PlaceRow[]>()
for (const line of unzipped.stdout.split("\n")) {
  if (!line) continue
  const fields = line.split("\t")
  const code = fields[8]
  if (!accepted.has(code) || fields[6] !== "P") continue
  const id = Number(fields[0])
  const latitude = Number(fields[4])
  const longitude = Number(fields[5])
  const population = Number(fields[14]) || 0
  if (
    !Number.isSafeInteger(id) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  )
    continue
  const region = admin1.get(`${code}.${fields[10]}`) ?? ""
  const county = admin2.get(`${code}.${fields[10]}.${fields[11]}`) ?? ""
  const row: PlaceRow = [
    id,
    fields[1],
    county,
    region,
    latitude,
    longitude,
    population,
  ]
  if (code === "US") {
    const stateCode = fields[10]
    if (!stateCode || !region) throw new Error(`Unknown US state for ${id}`)
    const rows = usByState.get(stateCode) ?? []
    rows.push(row)
    usByState.set(stateCode, rows)
  } else byCountry.get(code)?.push(row)
}

const output = "apps/merchant/public/places"
mkdirSync(output, { recursive: true })
rmSync(join(output, "US.json"), { force: true })
rmSync(join(output, "US"), { recursive: true, force: true })
mkdirSync(join(output, "US"), { recursive: true })
const sizes: Array<{
  code: string
  count: number
  bytes: number
  gzipBytes: number
}> = []
for (const [code, rows] of [...byCountry]
  .filter(([code]) => code !== "US")
  .sort(([a], [b]) => a.localeCompare(b))) {
  rows.sort((a, b) => b[6] - a[6] || a[1].localeCompare(b[1]) || a[0] - b[0])
  const bytes = Buffer.from(JSON.stringify(rows))
  writeFileSync(join(output, `${code}.json`), bytes)
  sizes.push({
    code,
    count: rows.length,
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
  })
}
const usStateSizes = [...usByState]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, rows]) => {
    rows.sort((a, b) => b[6] - a[6] || a[1].localeCompare(b[1]) || a[0] - b[0])
    const bytes = Buffer.from(JSON.stringify(rows))
    writeFileSync(join(output, "US", `${code}.json`), bytes)
    return {
      code,
      name: admin1.get(`US.${code}`)!,
      count: rows.length,
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: 9 }).length,
    }
  })
const statesSource = `// Generated from GeoNames admin1CodesASCII.txt and cities500.zip. Regenerate with scripts/generate-merchant-places.ts.\nexport const US_LISTING_AREA_STATES = ${JSON.stringify(
  usStateSizes.map(({ code, name }) => ({ code, name })),
  null,
  2
)} as const\n`
const statesPath = "apps/merchant/src/lib/usListingAreaStates.ts"
writeFileSync(
  statesPath,
  await format(statesSource, {
    ...(await resolveConfig(statesPath)),
    parser: "typescript",
  })
)
const manifest = {
  source: "GeoNames cities500",
  sourceUrl: "https://download.geonames.org/export/dump/",
  license: "CC BY 4.0",
  sources,
  acceptedCountryCodes: [...accepted].sort(),
  rows:
    sizes.reduce((total, row) => total + row.count, 0) +
    usStateSizes.reduce((total, row) => total + row.count, 0),
  sizes,
  usStateSizes,
}
writeFileSync(
  join(output, "source.json"),
  JSON.stringify(manifest, null, 2) + "\n"
)
console.log(
  `Generated ${manifest.rows} places in ${sizes.length + 1} accepted countries (${usStateSizes.length} US states)`
)
console.log(
  `JSON ${sizes.reduce((n, row) => n + row.bytes, 0) + usStateSizes.reduce((n, row) => n + row.bytes, 0)} bytes; gzip ${sizes.reduce((n, row) => n + row.gzipBytes, 0) + usStateSizes.reduce((n, row) => n + row.gzipBytes, 0)} bytes`
)
