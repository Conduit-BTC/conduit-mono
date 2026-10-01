/** Build authoring suggestions from public references; never runs in the apps. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const chartDate = "10/1/2026"
const output = resolve(
  import.meta.dir,
  "../../apps/merchant/src/lib/us-shipping-starter.generated.json"
)
const endpoint = "https://postcalc.usps.com/DomesticZoneChart/GetZoneChart"
type Cell = { ZipCodes: string; Zone: string; MailService: string }
type Chart = {
  ZIPCodeError: string
  ShippingDateError: string
  PageError: string
  EffectiveDate: string
  Column0: Cell[]
  Column1: Cell[]
  Column2: Cell[]
  Column3: Cell[]
  Zip5Digit: Cell[]
}
const excludedPrefix = (zip: number) =>
  zip < 10 ||
  (zip >= 90 && zip <= 99) ||
  zip === 340 ||
  (zip >= 962 && zip <= 966) ||
  zip === 969
function range(value: string): [number, number] {
  const match = /^(\d{3})(?:---(\d{3}))?$/.exec(value)
  if (!match) throw new Error(`Unrecognized reference range: ${value}`)
  return [Number(match[1]), Number(match[2] ?? match[1])]
}
async function chart(prefix: string): Promise<Chart> {
  const cacheDir = "/private/tmp/conduit-us-zone-reference-2026-10-01"
  await mkdir(cacheDir, { recursive: true })
  const cached = await readFile(
    resolve(cacheDir, `${prefix}.json`),
    "utf8"
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return null
  })
  if (cached) return JSON.parse(cached) as Chart
  const url = new URL(endpoint)
  url.searchParams.set("zipCode3Digit", prefix)
  url.searchParams.set("shippingDate", chartDate)
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new Error(`Reference request failed: ${response.status}`)
  const result = (await response.json()) as Chart
  if (result.ZIPCodeError || result.ShippingDateError || result.PageError)
    throw new Error(`Reference chart unavailable for ${prefix}`)
  if (result.EffectiveDate !== "October 1, 2026")
    throw new Error(
      "Review the changed zone reference date before regenerating."
    )
  await writeFile(resolve(cacheDir, `${prefix}.json`), JSON.stringify(result))
  await Bun.sleep(500)
  return result
}
function suggestedAreas(source: Chart): string {
  const areas = Array<string>(1000).fill("0")
  for (const cell of [
    ...source.Column0,
    ...source.Column1,
    ...source.Column2,
    ...source.Column3,
  ]) {
    // The public three-digit chart labels Hawaii's 967 area as 96700.
    // Independent ZIP-pair checks are recorded in the accompanying source note.
    const [first, last] = range(
      cell.ZipCodes === "96700" ? "967" : cell.ZipCodes
    )
    const zone = Number.parseInt(cell.Zone, 10)
    if (!Number.isInteger(zone) || zone < 1 || zone > 9)
      throw new Error("Unexpected reference zone; review coverage explicitly.")
    for (let prefix = first; prefix <= last; prefix++) {
      if (excludedPrefix(prefix)) continue
      if (cell.Zone.includes("+"))
        throw new Error(
          "Review a new domestic five-digit exception before generation."
        )
      areas[prefix] = zone <= 4 ? "1" : zone <= 6 ? "2" : "3"
    }
  }
  // Do not silently discard a newly introduced ordinary-US exception.
  for (const cell of source.Zip5Digit) {
    const prefix = Number(cell.ZipCodes.slice(0, 3))
    if (!excludedPrefix(prefix))
      throw new Error(
        "Review a new domestic five-digit exception before generation."
      )
  }
  // Use conservative two-digit price areas where all ten source prefixes are
  // covered. Keep holes and Alaska/Hawaii detail. This bounds signed-table
  // size without understating the referenced group at any destination.
  for (let block = 0; block < 100; block++) {
    if (block === 96 || block === 99) continue
    const first = block * 10
    const children = areas.slice(first, first + 10)
    if (children.includes("0")) continue
    const maximum = String(Math.max(...children.map(Number)))
    for (let index = first; index < first + 10; index++) areas[index] = maximum
  }
  return areas.join("")
}

if (import.meta.main) {
  const seed = suggestedAreas(await chart("941"))
  const prefixes = Array.from({ length: 1000 }, (_, index) => index)
    .filter((prefix) => seed[prefix] !== "0")
    .map((prefix) => String(prefix).padStart(3, "0"))
  const origins: Record<string, string> = {}
  let completed = 0
  // Bounded reference reads, with no merchant or buyer information.
  const queue = [...prefixes]
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (queue.length) {
        const prefix = queue.shift()!
        // The public 967 origin chart reports an error. This explicitly
        // conservative authoring estimate uses farther prices outside Hawaii;
        // independent five-digit pairs validate nearby Hawaii examples.
        origins[prefix] =
          prefix === "967"
            ? seed
                .split("")
                .map((area, index) =>
                  area === "0"
                    ? "0"
                    : index === 967 || index === 968
                      ? "1"
                      : "3"
                )
                .join("")
            : suggestedAreas(await chart(prefix))
        completed++
        if (completed % 100 === 0)
          console.log(`Read ${completed} reference areas`)
      }
    })
  )
  const data = {
    version: "us-ground-starter-2026-10-01",
    reviewedAt: "2026-10-01",
    reviewAfter: "2027-01-17",
    zoneReferenceEffectiveAt: "2026-10-01",
    areaGrouping:
      "Conservative two-digit price areas, with three-digit coverage holes and Alaska/Hawaii detail preserved",
    originApproximations: {
      "967":
        "Conservative farther prices outside Hawaii; nearby Hawaii. Public origin chart unavailable, checked with individual ZIP pairs.",
    },
    service: "USPS Ground Advantage",
    referenceRateType: "Retail, with the October 4 seasonal upper envelope",
    currency: "USD",
    sources: [
      "https://postcalc.usps.com/DomesticZoneChart",
      "https://pe.usps.com/TEXT/dmm300/Notice123.htm",
      "https://pe.usps.com/PriceChange/Index",
      "https://www.usps.com/ship/ground-advantage.htm",
    ],
    // Own conservative suggestions, not an exact carrier rate table. Each group
    // uses the ceiling of the highest referenced retail price in that group.
    // Gram limits round DOWN so a whole-gram input cannot cross a carrier tier.
    maxWeightGrams: [226, 453, 907, 2267],
    pricesDollars: [
      [9, 12, 14, 17],
      [10, 13, 16, 21],
      [11, 14, 20, 28],
    ],
    suggestedPackingGramsPerItem: 50,
    exclusions:
      "Territories, APO/FPO/DPO, American Samoa ZIP 96799, oversized/special parcels, and baskets above 5 lb",
    originAreas: Object.fromEntries(
      Object.entries(origins).sort(([a], [b]) => a.localeCompare(b))
    ),
  }
  await writeFile(output, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`Wrote ${completed} origin-aware starter maps`)
}
