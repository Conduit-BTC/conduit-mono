import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { computeBlobSha256 } from "nostr-tools/nipb7"
import {
  getProductImageSources,
  readProductImageMetadata,
  uploadPreparedProductImageCopies,
  type ProductImageUploadResult,
} from "@conduit/core"

const servers = [
  "https://primary.conduit.market",
  "https://backup.conduit.market",
]
async function fixture() {
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" })
  const prepared = {
    blob,
    sha256: await computeBlobSha256(blob),
    size: blob.size,
    mimeType: blob.type,
  }
  const key = generateSecretKey()
  const pubkey = getPublicKey(key)
  const uploads: string[] = []
  const bodies: Blob[] = []
  const authorizations: string[] = []
  let failures = new Set<string>()
  let corrupt = false
  const input = {
    prepared,
    target: {
      kind: "configured" as const,
      serverUrl: servers[0],
      backupServerUrls: [servers[1]],
    },
    expectedPubkey: pubkey,
    signer: {
      authMethod: "nip07" as const,
      getPublicKey: async () => pubkey,
      signEvent: async (event: Parameters<typeof finalizeEvent>[0]) =>
        finalizeEvent(event, key),
    },
    dependencies: {
      fetch: (async (url, init) => {
        const target = String(url)
        const server = new URL(target).origin
        if (init?.method === "PUT") {
          uploads.push(server)
          bodies.push(init.body as Blob)
          const auth = JSON.parse(
            Buffer.from(
              new Headers(init.headers).get("Authorization")!.slice(6),
              "base64url"
            ).toString()
          )
          authorizations.push(
            auth.tags.find((tag: string[]) => tag[0] === "server")[1]
          )
          if (failures.has(server)) return new Response(null, { status: 429 })
          return Response.json(
            {
              url: `${server}/${prepared.sha256}.png`,
              sha256: prepared.sha256,
              type: prepared.mimeType,
              size: prepared.size,
              uploaded: 1,
            },
            { status: 201 }
          )
        }
        return new Response(
          corrupt && server === servers[1]
            ? new Blob(["bad"], { type: blob.type })
            : blob,
          { headers: { "Content-Type": blob.type } }
        )
      }) as typeof fetch,
    },
  }
  return {
    input,
    uploads,
    bodies,
    authorizations,
    fail: (server: string) => failures.add(server),
    repair: () => {
      failures = new Set()
    },
    corrupt: () => {
      corrupt = true
    },
  }
}

describe("verified product image copies", () => {
  it("stores identical prepared bytes, verifies both and exposes only verified sources", async () => {
    const f = await fixture()
    const updates: ProductImageUploadResult[] = []
    const result = await uploadPreparedProductImageCopies({
      ...f.input,
      onVerified: (r) => updates.push(r),
    })
    expect(f.uploads).toEqual(servers)
    expect(f.bodies[0]).toBe(f.input.prepared.blob)
    expect(f.bodies[1]).toBe(f.input.prepared.blob)
    expect(f.authorizations).toEqual(servers.map((s) => new URL(s).hostname))
    expect(updates).toHaveLength(2)
    expect(updates[0].image.fallbackUrls).toEqual([])
    expect(getProductImageSources(result.image)).toHaveLength(2)
  })
  for (const failed of servers) {
    it(`retains the other verified copy when ${failed} fails and retries only the failed provider`, async () => {
      const f = await fixture()
      f.fail(failed)
      const result = await uploadPreparedProductImageCopies(f.input)
      expect(getProductImageSources(result.image)).toHaveLength(1)
      expect(
        result.copies.find((c) => c.serverUrl === failed)?.failureCode
      ).toBe("rate_limited")
      f.repair()
      const retried = await uploadPreparedProductImageCopies({
        ...f.input,
        previousResult: result,
      })
      expect(f.uploads).toEqual([...servers, failed])
      expect(getProductImageSources(retried.image)).toHaveLength(2)
    })
  }
  it("does not reuse a retry URL with the wrong hash or a private destination", async () => {
    const f = await fixture()
    const prior = await uploadPreparedProductImageCopies(f.input)
    prior.copies[0].url = `${servers[0]}/wrong.png?hash=${f.input.prepared.sha256}`
    prior.copies[1].url = `https://127.0.0.1/${f.input.prepared.sha256}.png`
    await uploadPreparedProductImageCopies({
      ...f.input,
      previousResult: prior,
    })
    expect(f.uploads).toEqual([...servers, ...servers])
  })
  it("keeps a verified primary when the backup bytes do not match", async () => {
    const f = await fixture()
    f.corrupt()
    const result = await uploadPreparedProductImageCopies(f.input)
    expect(result.image.fallbackUrls).toEqual([])
    expect(result.copies[1].failureCode).toBe("integrity_failed")
  })
  it("retains the first copy but sends nothing further after authority changes", async () => {
    const f = await fixture()
    let current = true
    const result = await uploadPreparedProductImageCopies({
      ...f.input,
      shouldContinue: () => current,
      onVerified: () => {
        current = false
      },
    })
    expect(f.uploads).toEqual([servers[0]])
    expect(result.copies[1].failureCode).toBe("authority_changed")
  })
  it("surfaces failure when no provider verifies a copy", async () => {
    const f = await fixture()
    servers.forEach(f.fail)
    await expect(
      uploadPreparedProductImageCopies(f.input)
    ).rejects.toMatchObject({ code: "rate_limited" })
  })
  it("rejects unsafe backup destinations before any upload", async () => {
    const f = await fixture()
    await expect(
      uploadPreparedProductImageCopies({
        ...f.input,
        target: { ...f.input.target, backupServerUrls: ["https://127.0.0.1"] },
      })
    ).rejects.toMatchObject({ code: "target_unavailable" })
    expect(f.uploads).toHaveLength(0)
  })
  it("never trusts backup metadata with another hash or a private destination", () => {
    const hash = "a".repeat(64),
      url = `${servers[0]}/${hash}.png`
    const image = readProductImageMetadata(url, [
      [
        "imeta",
        `url ${url}`,
        `x ${hash}`,
        `fallback ${servers[1]}/${hash}.png`,
        `fallback https://127.0.0.1/${hash}.png`,
        `fallback ${servers[1]}/${"b".repeat(64)}.png`,
      ],
    ])
    expect(
      getProductImageSources({
        ...image,
        url: `${servers[0]}/wrong.png?hash=${hash}`,
      })
    ).toEqual([`${servers[0]}/wrong.png?hash=${hash}`])
    expect(getProductImageSources(image)).toEqual([
      url,
      `${servers[1]}/${hash}.png`,
    ])
    expect(
      getProductImageSources({
        ...image,
        url: "https://cdn.jsdelivr.net/edited.png",
      })
    ).toEqual(["https://cdn.jsdelivr.net/edited.png"])
  })
})
