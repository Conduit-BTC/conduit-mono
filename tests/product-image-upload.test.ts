import { readFileSync } from "node:fs"
import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { computeBlobSha256 } from "nostr-tools/nipb7"
import {
  MAX_PRODUCT_IMAGE_DECODED_PIXELS,
  MAX_PRODUCT_IMAGE_INPUT_DIMENSION,
  MAX_PRODUCT_IMAGE_OUTPUT_DIMENSION,
  PRODUCT_IMAGE_FALLBACK_SERVER,
  PRODUCT_IMAGE_UPLOAD_AUTH_TTL_SECONDS,
  ProductImageUploadError,
  getPreparedProductImageDimensions,
  getProductImageUploadErrorMessage,
  inspectProductImageBytes,
  prepareProductImageFile,
  resolveProductImageUploadTarget,
  uploadPreparedProductImage,
  type MediaServerDraftRecord,
  type MediaServerPreferenceResolution,
  type PreparedProductImage,
  type ProductImageUploadFailureCode,
} from "@conduit/core"

const CONFIGURED_SERVER = "https://media.conduit.market"
const DRAFT_SERVER = "https://draft-media.conduit.market"
const uploadHookSource = readFileSync(
  new URL(
    "../packages/core/src/hooks/useProductImageUpload.ts",
    import.meta.url
  ),
  "utf8"
)

function resolution(
  overrides: Partial<MediaServerPreferenceResolution> = {}
): MediaServerPreferenceResolution {
  return {
    owner: "a".repeat(64),
    status: "not_observed",
    coverage: "complete",
    publishedServerUrls: [],
    publishedRevision: null,
    frontier: null,
    sourceRelayUrls: [],
    observedAt: 1,
    completeObservedAt: null,
    stale: false,
    retained: false,
    lookup: {
      observedAt: 1,
      coverage: "complete",
      plannedRelayCount: 1,
      successfulRelayCount: 1,
      partialRelayCount: 0,
      failedRelayCount: 0,
      rejectedEventCount: 0,
      hadEvent: false,
    },
    pending: null,
    ...overrides,
  }
}

function localDraft(
  overrides: Partial<MediaServerDraftRecord> = {}
): MediaServerDraftRecord {
  return {
    serverUrls: [CONFIGURED_SERVER],
    baseServerUrls: [CONFIGURED_SERVER],
    baseEventId: "b".repeat(64),
    updatedAt: 1,
    ...overrides,
  }
}

async function preparedImage(
  bytes = new Uint8Array([1, 2, 3, 4])
): Promise<PreparedProductImage> {
  const blob = new Blob([bytes], { type: "image/png" })
  return {
    blob,
    sha256: await computeBlobSha256(blob),
    size: blob.size,
    mimeType: blob.type,
    width: 2,
    height: 2,
  }
}

function responseWithUrl(
  body: BodyInit,
  init: ResponseInit,
  url: string
): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, "url", { value: url })
  return response
}

function decodeAuthorization(value: string): Record<string, unknown> {
  const encoded = value.replace(/^Nostr /u, "")
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    )
  ) as Record<string, unknown>
}

describe("product image upload target resolution", () => {
  it("uses a clean local CND-186 mirror only when it matches signed authority", () => {
    const publishedRevision = {
      eventId: "b".repeat(64),
      createdAt: 100,
    }
    expect(
      resolveProductImageUploadTarget({
        owner: "a".repeat(64),
        signerAvailable: true,
        localDraft: localDraft(),
        resolution: resolution({
          status: "published",
          publishedServerUrls: [CONFIGURED_SERVER],
          publishedRevision,
          frontier: { ...publishedRevision, state: "valid" },
        }),
      })
    ).toEqual({
      kind: "configured",
      serverUrl: CONFIGURED_SERVER,
      maxFileUploads: 12,
    })
  })

  it("ignores dirty and stale local drafts in favor of signed authority", () => {
    const publishedRevision = {
      eventId: "c".repeat(64),
      createdAt: 101,
    }
    const signedResolution = resolution({
      status: "published",
      publishedServerUrls: [CONFIGURED_SERVER],
      publishedRevision,
      frontier: { ...publishedRevision, state: "valid" },
    })

    for (const draft of [
      localDraft({
        serverUrls: [DRAFT_SERVER],
        baseEventId: publishedRevision.eventId,
      }),
      localDraft({ baseEventId: "b".repeat(64) }),
    ]) {
      expect(
        resolveProductImageUploadTarget({
          owner: "a".repeat(64),
          signerAvailable: true,
          localDraft: draft,
          resolution: signedResolution,
        })
      ).toEqual({
        kind: "configured",
        serverUrl: CONFIGURED_SERVER,
        maxFileUploads: 12,
      })
    }
  })

  it("does not let a dirty draft override a stronger signed-empty frontier", () => {
    expect(
      resolveProductImageUploadTarget({
        owner: "a".repeat(64),
        signerAvailable: true,
        localDraft: localDraft({ serverUrls: [DRAFT_SERVER] }),
        resolution: resolution({
          status: "empty",
          retained: true,
          publishedServerUrls: [CONFIGURED_SERVER],
          publishedRevision: {
            eventId: "b".repeat(64),
            createdAt: 100,
          },
          frontier: {
            eventId: "a".repeat(64),
            createdAt: 101,
            state: "empty",
          },
        }),
      })
    ).toEqual({
      kind: "fallback",
      serverUrl: PRODUCT_IMAGE_FALLBACK_SERVER,
      maxFileUploads: 1,
    })

    expect(
      resolveProductImageUploadTarget({
        owner: "a".repeat(64),
        signerAvailable: true,
        localDraft: localDraft({ serverUrls: [DRAFT_SERVER] }),
        resolution: resolution({
          status: "lookup_partial",
          coverage: "partial",
          retained: true,
          publishedServerUrls: [CONFIGURED_SERVER],
          publishedRevision: {
            eventId: "b".repeat(64),
            createdAt: 100,
          },
          frontier: {
            eventId: "a".repeat(64),
            createdAt: 101,
            state: "empty",
          },
        }),
      })
    ).toEqual({ kind: "pending", reason: "lookup_incomplete" })
  })

  it("keeps retained published authority through incomplete reads", () => {
    for (const status of [
      "lookup_partial",
      "lookup_unavailable",
      "malformed",
    ] as const) {
      expect(
        resolveProductImageUploadTarget({
          owner: "a".repeat(64),
          signerAvailable: true,
          resolution: resolution({
            status,
            coverage:
              status === "lookup_partial"
                ? "partial"
                : status === "lookup_unavailable"
                  ? "unavailable"
                  : "complete",
            retained: true,
            publishedServerUrls: [CONFIGURED_SERVER],
          }),
        })
      ).toMatchObject({
        kind: "configured",
        serverUrl: CONFIGURED_SERVER,
      })
    }
  })

  it("keeps retained published authority after a complete no-event read", () => {
    const publishedRevision = {
      eventId: "b".repeat(64),
      createdAt: 100,
    }
    const retained = resolution({
      status: "not_observed",
      coverage: "complete",
      retained: true,
      publishedServerUrls: [CONFIGURED_SERVER],
      publishedRevision,
      frontier: {
        ...publishedRevision,
        state: "valid",
      },
    })

    expect(
      resolveProductImageUploadTarget({
        owner: "a".repeat(64),
        signerAvailable: true,
        resolution: retained,
      })
    ).toMatchObject({
      kind: "configured",
      serverUrl: CONFIGURED_SERVER,
    })

    expect(
      resolveProductImageUploadTarget({
        owner: "a".repeat(64),
        signerAvailable: true,
        resolution: {
          ...retained,
          frontier: {
            eventId: "a".repeat(64),
            createdAt: 101,
            state: "empty",
          },
        },
      })
    ).toEqual({
      kind: "fallback",
      serverUrl: PRODUCT_IMAGE_FALLBACK_SERVER,
      maxFileUploads: 1,
    })
  })

  it("does not turn loading, partial, unavailable, or malformed evidence into fallback", () => {
    expect(
      resolveProductImageUploadTarget({
        owner: "a".repeat(64),
        signerAvailable: true,
      })
    ).toEqual({ kind: "pending", reason: "loading" })

    for (const candidate of [
      resolution({ status: "lookup_partial", coverage: "partial" }),
      resolution({
        status: "lookup_unavailable",
        coverage: "unavailable",
      }),
    ]) {
      expect(
        resolveProductImageUploadTarget({
          owner: "a".repeat(64),
          signerAvailable: true,
          resolution: candidate,
        }).kind
      ).toBe("pending")
    }

    expect(
      resolveProductImageUploadTarget({
        owner: "a".repeat(64),
        signerAvailable: true,
        resolution: resolution({ status: "malformed" }),
      })
    ).toEqual({ kind: "unavailable", reason: "malformed_preferences" })
  })

  it("offers the approved fallback only after complete positive absence", () => {
    expect(
      resolveProductImageUploadTarget({
        owner: "a".repeat(64),
        signerAvailable: true,
        resolution: resolution(),
      })
    ).toEqual({
      kind: "fallback",
      serverUrl: PRODUCT_IMAGE_FALLBACK_SERVER,
      maxFileUploads: 1,
    })
  })
})

describe("product image upload queue authority", () => {
  it("captures each queued item's owner, signer, method, and generation before waiting", () => {
    const snapshotIndex = uploadHookSource.indexOf(
      "const authority: ProductImageUploadAuthoritySnapshot"
    )
    const queueIndex = uploadHookSource.indexOf(
      "uploadQueueRef.current.then",
      snapshotIndex
    )

    expect(snapshotIndex).toBeGreaterThanOrEqual(0)
    expect(queueIndex).toBeGreaterThan(snapshotIndex)
    expect(uploadHookSource).toContain("generation: auth.authGeneration")
    expect(uploadHookSource).toContain("owner,\n        signer: auth.signer")
    expect(uploadHookSource).toContain("method: auth.method")
    expect(uploadHookSource).toContain("performUploadFile(request, authority)")
    expect(uploadHookSource).toContain(
      "authGenerationRef.current !== generation"
    )
  })
})

describe("product image preparation bounds", () => {
  it("reads bounded still-image headers before browser decode", () => {
    const png = new Uint8Array(33)
    png.set([137, 80, 78, 71, 13, 10, 26, 10])
    new DataView(png.buffer).setUint32(8, 13)
    png.set([73, 72, 68, 82], 12)
    new DataView(png.buffer).setUint32(16, 640)
    new DataView(png.buffer).setUint32(20, 480)
    expect(inspectProductImageBytes(png, "image/png")).toEqual({
      width: 640,
      height: 480,
      animated: false,
    })

    const animatedPng = new Uint8Array(53)
    animatedPng.set(png)
    new DataView(animatedPng.buffer).setUint32(33, 8)
    animatedPng.set([97, 99, 84, 76], 37)
    expect(inspectProductImageBytes(animatedPng, "image/png")).toMatchObject({
      animated: true,
    })
  })

  it("downscales within the decoded and output bounds", () => {
    const dimensions = getPreparedProductImageDimensions({
      width: 6_000,
      height: 4_000,
    })
    expect(dimensions.width).toBeLessThanOrEqual(
      MAX_PRODUCT_IMAGE_OUTPUT_DIMENSION
    )
    expect(dimensions.height).toBeLessThanOrEqual(
      MAX_PRODUCT_IMAGE_OUTPUT_DIMENSION
    )
  })

  it("rejects oversized dimensions and decoded pixel counts", () => {
    expect(() =>
      getPreparedProductImageDimensions({
        width: MAX_PRODUCT_IMAGE_INPUT_DIMENSION + 1,
        height: 1,
      })
    ).toThrow(ProductImageUploadError)
    expect(() =>
      getPreparedProductImageDimensions({
        width: Math.floor(Math.sqrt(MAX_PRODUCT_IMAGE_DECODED_PIXELS)) + 1,
        height: Math.floor(Math.sqrt(MAX_PRODUCT_IMAGE_DECODED_PIXELS)) + 1,
      })
    ).toThrow(ProductImageUploadError)
  })

  it("releases cancellation while local preparation is still pending", async () => {
    const controller = new AbortController()
    const preparation = prepareProductImageFile(
      new File([new Uint8Array([1])], "local.png", { type: "image/png" }),
      {
        signal: controller.signal,
        inspectMetadata: () => new Promise(() => {}),
      }
    )
    controller.abort()
    await expect(preparation).rejects.toMatchObject({ code: "cancelled" })
  })
})

describe("verified Blossom product image upload", () => {
  it("uses short hash/server/action auth, one PUT, and adopts only verified bytes", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const prepared = await preparedImage()
    const resourceUrl = `https://cdn.conduit.market/${prepared.sha256}.png`
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const phases: string[] = []
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (init?.method === "PUT") {
        expect(url).toBe(`${CONFIGURED_SERVER}/upload`)
        expect(init.body).toBe(prepared.blob)
        expect(init.redirect).toBe("error")
        expect(new Headers(init.headers).get("x-sha-256")).toBe(prepared.sha256)
        const authorization = new Headers(init.headers).get("authorization")
        expect(authorization).toBeTruthy()
        const event = decodeAuthorization(authorization!)
        expect(event.kind).toBe(24242)
        expect(event.pubkey).toBe(pubkey)
        expect(event.tags).toContainEqual(["t", "upload"])
        expect(event.tags).toContainEqual(["x", prepared.sha256])
        expect(event.tags).toContainEqual(["server", "media.conduit.market"])
        expect(
          Number(
            (event.tags as string[][]).find(
              (tag) => tag[0] === "expiration"
            )?.[1]
          ) - 1_000
        ).toBe(PRODUCT_IMAGE_UPLOAD_AUTH_TTL_SECONDS)
        return new Response(
          JSON.stringify({
            url: resourceUrl,
            sha256: prepared.sha256,
            size: prepared.size,
            type: prepared.mimeType,
            uploaded: 1_000,
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
      }
      expect(init?.redirect).toBe("error")
      return responseWithUrl(
        prepared.blob,
        {
          status: 200,
          headers: {
            "content-type": prepared.mimeType,
            "content-length": String(prepared.size),
          },
        },
        resourceUrl
      )
    }

    const result = await uploadPreparedProductImage({
      prepared,
      target: {
        kind: "configured",
        serverUrl: CONFIGURED_SERVER,
        maxFileUploads: 12,
      },
      expectedPubkey: pubkey,
      signer: {
        authMethod: "nip07",
        getPublicKey: async () => pubkey,
        signEvent: async (event) => finalizeEvent(event, secretKey),
      },
      shouldContinue: () => true,
      onPhase: (phase) => phases.push(phase),
      dependencies: { fetch: fetchMock, now: () => 1_000 },
    })

    expect(result).toMatchObject({
      url: resourceUrl,
      sha256: prepared.sha256,
      targetKind: "configured",
    })
    expect(requests.map((request) => request.url)).toEqual([
      `${CONFIGURED_SERVER}/upload`,
      resourceUrl,
    ])
    expect(phases).toEqual([
      "awaiting_signature",
      "uploading",
      "verifying",
      "succeeded",
    ])
  })

  it("never sends a PUT to an unsigned draft server", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const prepared = await preparedImage()
    const publishedRevision = {
      eventId: "c".repeat(64),
      createdAt: 101,
    }
    const target = resolveProductImageUploadTarget({
      owner: "a".repeat(64),
      signerAvailable: true,
      localDraft: localDraft({
        serverUrls: [DRAFT_SERVER],
        baseEventId: publishedRevision.eventId,
      }),
      resolution: resolution({
        status: "published",
        publishedServerUrls: [CONFIGURED_SERVER],
        publishedRevision,
        frontier: { ...publishedRevision, state: "valid" },
      }),
    })
    expect(target).toMatchObject({
      kind: "configured",
      serverUrl: CONFIGURED_SERVER,
    })
    if (target.kind !== "configured") throw new Error("Expected signed target")

    const resourceUrl = `https://cdn.conduit.market/${prepared.sha256}.png`
    const putUrls: string[] = []
    await uploadPreparedProductImage({
      prepared,
      target,
      expectedPubkey: pubkey,
      signer: {
        authMethod: "nip07",
        getPublicKey: async () => pubkey,
        signEvent: async (event) => finalizeEvent(event, secretKey),
      },
      dependencies: {
        now: () => 1_000,
        fetch: async (input, init) => {
          const url = String(input)
          if (init?.method === "PUT") {
            putUrls.push(url)
            return new Response(
              JSON.stringify({
                url: resourceUrl,
                sha256: prepared.sha256,
                size: prepared.size,
                type: prepared.mimeType,
                uploaded: 1_000,
              }),
              {
                status: 201,
                headers: { "content-type": "application/json" },
              }
            )
          }
          return responseWithUrl(
            prepared.blob,
            {
              status: 200,
              headers: {
                "content-type": prepared.mimeType,
                "content-length": String(prepared.size),
              },
            },
            resourceUrl
          )
        },
      },
    })

    expect(putUrls).toEqual([`${CONFIGURED_SERVER}/upload`])
    expect(putUrls.some((url) => url.startsWith(DRAFT_SERVER))).toBe(false)
  })

  for (const [status, code] of [
    [400, "upload_failed"],
    [401, "auth_invalid"],
    [402, "payment_required"],
    [403, "policy_rejected"],
    [409, "integrity_failed"],
    [411, "upload_failed"],
    [413, "size_rejected"],
    [415, "type_rejected"],
    [429, "rate_limited"],
  ] as const) {
    it(`maps HTTP ${status} to ${code} without trying another provider`, async () => {
      const secretKey = generateSecretKey()
      const pubkey = getPublicKey(secretKey)
      const prepared = await preparedImage()
      let calls = 0
      try {
        await uploadPreparedProductImage({
          prepared,
          target: {
            kind: "configured",
            serverUrl: CONFIGURED_SERVER,
            maxFileUploads: 12,
          },
          expectedPubkey: pubkey,
          signer: {
            getPublicKey: async () => pubkey,
            signEvent: async (event) => finalizeEvent(event, secretKey),
          },
          dependencies: {
            now: () => 1_000,
            fetch: async () => {
              calls += 1
              return new Response("", { status })
            },
          },
        })
        throw new Error("expected upload failure")
      } catch (error) {
        expect(error).toBeInstanceOf(ProductImageUploadError)
        expect((error as ProductImageUploadError).code).toBe(code)
        expect((error as ProductImageUploadError).uploadOutcome).toBe(
          "definitive_rejection"
        )
      }
      expect(calls).toBe(1)
    })
  }

  it("treats an unspecified server failure as an ambiguous PUT outcome", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const prepared = await preparedImage()

    await expect(
      uploadPreparedProductImage({
        prepared,
        target: {
          kind: "fallback",
          serverUrl: PRODUCT_IMAGE_FALLBACK_SERVER,
          maxFileUploads: 1,
        },
        expectedPubkey: pubkey,
        signer: {
          getPublicKey: async () => pubkey,
          signEvent: async (event) => finalizeEvent(event, secretKey),
        },
        dependencies: {
          now: () => 1_000,
          fetch: async () => new Response("", { status: 500 }),
        },
      })
    ).rejects.toMatchObject({
      code: "upload_failed",
      uploadOutcome: "ambiguous",
    })
  })

  it("rejects descriptor resource redirects before fetch can follow", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const prepared = await preparedImage()
    const descriptorUrl = `${CONFIGURED_SERVER}/${prepared.sha256}.png`
    let calls = 0

    await expect(
      uploadPreparedProductImage({
        prepared,
        target: {
          kind: "configured",
          serverUrl: CONFIGURED_SERVER,
          maxFileUploads: 12,
        },
        expectedPubkey: pubkey,
        signer: {
          getPublicKey: async () => pubkey,
          signEvent: async (event) => finalizeEvent(event, secretKey),
        },
        dependencies: {
          now: () => 1_000,
          fetch: async (input, init) => {
            calls += 1
            if (calls === 1) {
              expect(init?.redirect).toBe("error")
              return new Response(
                JSON.stringify({
                  url: descriptorUrl,
                  sha256: prepared.sha256,
                  size: prepared.size,
                  type: prepared.mimeType,
                  uploaded: 1_000,
                }),
                { status: 201 }
              )
            }
            expect(String(input)).toBe(descriptorUrl)
            expect(init?.redirect).toBe("error")
            throw new TypeError("Redirects are rejected before following")
          },
        },
      })
    ).rejects.toMatchObject({
      code: "resource_unavailable",
      uploadOutcome: "accepted_unverified",
    })

    expect(calls).toBe(2)
  })

  for (const [label, redirectedUrl] of [
    [
      "a changed hash",
      (sha256: string) =>
        `https://cdn.conduit.market/${sha256 === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64)}.png`,
    ],
    [
      "an unsafe destination",
      (sha256: string) => `http://127.0.0.1/${sha256}.png`,
    ],
  ] as const) {
    it(`rejects a retrieval response with ${label}`, async () => {
      const secretKey = generateSecretKey()
      const pubkey = getPublicKey(secretKey)
      const prepared = await preparedImage()
      const descriptorUrl = `${CONFIGURED_SERVER}/${prepared.sha256}.png`
      let calls = 0

      await expect(
        uploadPreparedProductImage({
          prepared,
          target: {
            kind: "configured",
            serverUrl: CONFIGURED_SERVER,
            maxFileUploads: 12,
          },
          expectedPubkey: pubkey,
          signer: {
            getPublicKey: async () => pubkey,
            signEvent: async (event) => finalizeEvent(event, secretKey),
          },
          dependencies: {
            now: () => 1_000,
            fetch: async (_input, init) => {
              calls += 1
              if (calls === 1) {
                return new Response(
                  JSON.stringify({
                    url: descriptorUrl,
                    sha256: prepared.sha256,
                    size: prepared.size,
                    type: prepared.mimeType,
                    uploaded: 1_000,
                  }),
                  { status: 201 }
                )
              }
              expect(init?.redirect).toBe("error")
              return responseWithUrl(
                prepared.blob,
                {
                  status: 200,
                  headers: {
                    "content-type": prepared.mimeType,
                    "content-length": String(prepared.size),
                  },
                },
                redirectedUrl(prepared.sha256)
              )
            },
          },
        })
      ).rejects.toMatchObject({
        code: "resource_unavailable",
        uploadOutcome: "accepted_unverified",
      })
      expect(calls).toBe(2)
    })
  }

  it("rejects descriptor or retrieval integrity mismatches before adoption", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const prepared = await preparedImage()
    const resourceUrl = `https://cdn.conduit.market/${prepared.sha256}.png`
    let calls = 0
    await expect(
      uploadPreparedProductImage({
        prepared,
        target: {
          kind: "configured",
          serverUrl: CONFIGURED_SERVER,
          maxFileUploads: 12,
        },
        expectedPubkey: pubkey,
        signer: {
          getPublicKey: async () => pubkey,
          signEvent: async (event) => finalizeEvent(event, secretKey),
        },
        dependencies: {
          now: () => 1_000,
          fetch: async () => {
            calls += 1
            if (calls === 1) {
              return new Response(
                JSON.stringify({
                  url: resourceUrl,
                  sha256: prepared.sha256,
                  size: prepared.size,
                  type: prepared.mimeType,
                  uploaded: 1_000,
                }),
                { status: 200 }
              )
            }
            const wrong = new Blob([new Uint8Array([9, 9, 9, 9])], {
              type: prepared.mimeType,
            })
            return responseWithUrl(
              wrong,
              {
                status: 200,
                headers: {
                  "content-type": prepared.mimeType,
                  "content-length": String(wrong.size),
                },
              },
              resourceUrl
            )
          },
        },
      })
    ).rejects.toMatchObject({
      code: "integrity_failed",
      uploadOutcome: "accepted_unverified",
    })
  })

  it("distinguishes signer rejection, cancellation, signer timeout, and upload timeout", async () => {
    const secretKey = generateSecretKey()
    const pubkey = getPublicKey(secretKey)
    const prepared = await preparedImage()
    const target = {
      kind: "configured" as const,
      serverUrl: CONFIGURED_SERVER,
      maxFileUploads: 12 as const,
    }
    await expect(
      uploadPreparedProductImage({
        prepared,
        target,
        expectedPubkey: pubkey,
        signer: {
          getPublicKey: async () => pubkey,
          signEvent: async () => {
            throw new ProductImageUploadError(
              "signer_rejected",
              getProductImageUploadErrorMessage("signer_rejected")
            )
          },
        },
      })
    ).rejects.toMatchObject({ code: "signer_rejected" })

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      uploadPreparedProductImage({
        prepared,
        target,
        expectedPubkey: pubkey,
        signer: {
          getPublicKey: async () => pubkey,
          signEvent: async (event) => finalizeEvent(event, secretKey),
        },
        signal: cancelled.signal,
      })
    ).rejects.toMatchObject({ code: "cancelled" })

    const cancelWhileSigning = new AbortController()
    const cancelledSigning = uploadPreparedProductImage({
      prepared,
      target,
      expectedPubkey: pubkey,
      signer: {
        getPublicKey: async () => pubkey,
        signEvent: () => new Promise(() => {}),
      },
      signal: cancelWhileSigning.signal,
    })
    cancelWhileSigning.abort()
    await expect(cancelledSigning).rejects.toMatchObject({ code: "cancelled" })

    await expect(
      uploadPreparedProductImage({
        prepared,
        target,
        expectedPubkey: pubkey,
        signer: {
          getPublicKey: async () => pubkey,
          signEvent: () => new Promise(() => {}),
        },
        dependencies: { signerTimeoutMs: 5 },
      })
    ).rejects.toMatchObject({ code: "signer_timeout" })

    await expect(
      uploadPreparedProductImage({
        prepared,
        target,
        expectedPubkey: pubkey,
        signer: {
          getPublicKey: async () => pubkey,
          signEvent: async (event) => finalizeEvent(event, secretKey),
        },
        dependencies: {
          uploadTimeoutMs: 5,
          fetch: async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true }
              )
            }),
        },
      })
    ).rejects.toMatchObject({
      code: "upload_timeout",
      uploadOutcome: "ambiguous",
    })
  })

  it("keeps public error messages free of raw upload evidence", () => {
    const sensitiveSentinels = [
      "merchant-photo.png",
      CONFIGURED_SERVER,
      "f".repeat(64),
      "npub1private",
    ]
    const codes: ProductImageUploadFailureCode[] = [
      "unsupported_type",
      "fallback_retry_mismatch",
      "fallback_guard_unavailable",
      "payment_required",
      "policy_rejected",
      "integrity_failed",
      "upload_failed",
      "cancelled",
    ]
    for (const code of codes) {
      const message = getProductImageUploadErrorMessage(code)
      for (const sentinel of sensitiveSentinels) {
        expect(message).not.toContain(sentinel)
      }
    }
  })
})
