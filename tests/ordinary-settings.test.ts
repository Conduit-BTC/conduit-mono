import { describe, expect, test } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools"
import {
  emptyPrivateSettings,
  emptyPublicSettings,
  parsePrivateSettingsDocument,
  parsePublicSettingsDocument,
  PRIVATE_SETTINGS_KIND,
  PRIVATE_SETTINGS_ID,
  PUBLIC_SETTINGS_KIND,
  PUBLIC_SETTINGS_ID,
  SettingsError,
} from "../packages/core/src/settings/documents"
import { rebaseSettings } from "../packages/core/src/settings/edits"
import {
  readPrivateSettingsEvent,
  readPublicSettingsEvent,
  signPublicSettingsDocument,
  signPrivateSettingsDocument,
  compareSettingsEvents,
} from "../packages/core/src/settings/events"
import { SettingsCoordinator } from "../packages/core/src/settings/coordinator"
import {
  createSettingsStore,
  OrdinarySettingsDB,
  type SettingsStore,
  type SettingsRow,
} from "../packages/core/src/settings/store"
import type { SettingsTransport } from "../packages/core/src/settings/transport"
import type {
  AccountSigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"

function fixture() {
  const secret = generateSecretKey(),
    pubkey = getPublicKey(secret)
  let denied = false,
    encrypts = 0,
    decrypts = 0,
    signs = 0,
    active = true
  const signer: AccountSigner = {
    pubkey,
    revision: "test",
    authMethod: "nip07",
    capabilities: { signEvent: true, nip44: true, nip04Decrypt: false },
    async getPublicKey() {
      return pubkey
    },
    async signEvent(event) {
      signs++
      return finalizeEvent(event, secret)
    },
    async encryptNip44(owner, text) {
      encrypts++
      if (denied) throw { code: "authorization_denied" }
      return nip44.v2.encrypt(
        text,
        nip44.v2.utils.getConversationKey(secret, owner)
      )
    },
    async decryptNip44(owner, text) {
      decrypts++
      if (denied) throw { code: "authorization_denied" }
      return nip44.v2.decrypt(
        text,
        nip44.v2.utils.getConversationKey(secret, owner)
      )
    },
    async decryptLegacy() {
      throw new Error("Not supported")
    },
  }
  const rows = new Map<string, SettingsRow>()
  let failStore = false,
    offline = false
  const published: SignedNostrEvent[] = [],
    remote: SignedNostrEvent[] = []
  const store: SettingsStore = {
    async get(key) {
      if (failStore) throw new SettingsError("storage")
      return structuredClone(rows.get(key) ?? { key })
    },
    async put(row, expected) {
      if (failStore) throw new SettingsError("storage")
      if (rows.get(row.key)?.head?.id !== expected)
        throw new SettingsError("conflict")
      rows.set(row.key, structuredClone(row))
    },
  }
  const transport: SettingsTransport = {
    async read(owner, kind, current, id) {
      return {
        events: offline
          ? []
          : remote.filter(
              (e) =>
                e.pubkey === owner && e.kind === kind && (!id || e.id === id)
            ),
        coverage: offline ? "unavailable" : "complete",
      }
    },
    async publish(event) {
      if (offline) return false
      published.push(event)
      remote.push(event)
      return true
    },
  }
  const coordinator = () =>
    new SettingsCoordinator(
      signer,
      store,
      transport,
      () => active,
      () => 1000000
    )
  return {
    signer,
    store,
    rows,
    published,
    remote,
    transport,
    coordinator,
    counts: () => ({ encrypts, decrypts, signs }),
    deny: (value = true) => {
      denied = value
    },
    offline: (v: boolean) => {
      offline = v
    },
    fail: (v: boolean) => {
      failStore = v
    },
    retire: () => {
      active = false
    },
    event: (kind: number, document: unknown, created_at = 1000) =>
      finalizeEvent(
        {
          kind,
          pubkey,
          created_at,
          tags: [
            [
              "d",
              kind === PRIVATE_SETTINGS_KIND
                ? PRIVATE_SETTINGS_ID
                : PUBLIC_SETTINGS_ID,
            ],
          ],
          content:
            kind === PRIVATE_SETTINGS_KIND
              ? nip44.v2.encrypt(
                  JSON.stringify(document),
                  nip44.v2.utils.getConversationKey(secret, pubkey)
                )
              : JSON.stringify(document),
        },
        secret
      ),
  }
}
describe("ordinary settings ownership and privacy", () => {
  test("different schemas reject cross-type documents and private egress recursively", () => {
    expect(() => parsePublicSettingsDocument(emptyPrivateSettings())).toThrow()
    expect(() => parsePrivateSettingsDocument(emptyPublicSettings())).toThrow()
    for (const key of [
      "savedAddresses",
      "defaultAddressId",
      "mnemonic",
      "walletId",
      "credentials",
      "email",
      "visibility",
      "rates",
    ]) {
      expect(() =>
        parsePublicSettingsDocument({
          ...emptyPublicSettings(),
          extensions: {
            "org.example.test": {
              version: 1,
              data: { [key]: "PRIVATE_SENTINEL" },
            },
          },
        })
      ).toThrow()
    }
    for (const key of [
      "mnemonic",
      "walletId",
      "originCountry",
      "rates",
      "restrictTo",
    ])
      expect(() =>
        parsePrivateSettingsDocument({
          ...emptyPrivateSettings(),
          settings: { [key]: "sentinel" },
        })
      ).toThrow()
  })
  test("real NIP-44 private event contains no plaintext and restores with signer", async () => {
    const f = fixture(),
      c = f.coordinator()
    const saved = await c.publishPrivateSettings({
      baseline: emptyPrivateSettings(),
      changes: [{ path: "display.language", value: "fr" }],
    })
    expect(saved.delivery).toBe("observed")
    expect(f.published[0]!.content).not.toContain("display")
    expect(JSON.stringify([...f.rows.values()])).not.toContain('"language"')
    expect(
      (await readPrivateSettingsEvent(f.published[0]!, f.signer, () => true))
        .settings.display?.language
    ).toBe("fr")
    const otherApp = new SettingsCoordinator(
      f.signer,
      { get: async (key) => ({ key }), put: async () => {} },
      f.transport,
      () => true
    )
    expect(
      (await otherApp.readPrivate()).document.settings.display?.language
    ).toBe("fr")
  })
  test("public browsing never decrypts; public writer rejects arbitrary opaque injection", async () => {
    const f = fixture(),
      event = f.event(PUBLIC_SETTINGS_KIND, {
        ...emptyPublicSettings(),
        settings: { merchant: { notice: "Open", future: { nested: [1, 2] } } },
      })
    const base = readPublicSettingsEvent(event, f.signer.pubkey)
    expect(f.counts().decrypts).toBe(0)
    await expect(
      signPublicSettingsDocument(
        {
          baseline: base,
          changes: [
            {
              path: "merchant.generalLocation",
              value: { location: "Town", extra: "PRIVATE_SENTINEL" },
            },
          ],
        },
        f.signer,
        1001,
        () => true
      )
    ).rejects.toThrow()
    expect(f.counts().signs).toBe(0)
    const next = await signPublicSettingsDocument(
      {
        baseline: base,
        changes: [{ path: "merchant.notice", value: "Closed" }],
      },
      f.signer,
      1001,
      () => true
    )
    expect(JSON.parse(next.content).settings.merchant.future).toEqual({
      nested: [1, 2],
    })
    base.settings.merchant!.extra = "PRIVATE_SENTINEL"
    await expect(
      signPublicSettingsDocument(
        { baseline: base, changes: [] },
        f.signer,
        1002,
        () => true
      )
    ).rejects.toThrow()
  })
  test("wrong kinds and plaintext private payloads fail before decrypt", async () => {
    const f = fixture(),
      event = f.event(PUBLIC_SETTINGS_KIND, emptyPublicSettings())
    await expect(
      readPrivateSettingsEvent(event, f.signer, () => true)
    ).rejects.toThrow()
    expect(f.counts().decrypts).toBe(0)
    await expect(
      signPrivateSettingsDocument(
        emptyPublicSettings() as never,
        f.signer,
        1000,
        () => true
      )
    ).rejects.toThrow()
    expect(f.counts().encrypts).toBe(0)
  })
  test("unknown nested data survives known edits; duplicate keys and oversized data fail", () => {
    const base = parsePrivateSettingsDocument({
      ...emptyPrivateSettings(),
      settings: {
        display: { currency: "USD", future: { nested: [{ x: 1 }] } },
      },
      extensions: {
        "org.example.test": { version: 7, data: { nested: { x: [1] } } },
      },
    })
    const next = rebaseSettings(
      { baseline: base, changes: [{ path: "display.currency", value: "EUR" }] },
      base,
      "a".repeat(64)
    )
    expect(next.settings.display?.future).toEqual({ nested: [{ x: 1 }] })
    expect(next.extensions).toEqual(base.extensions)
    expect(() =>
      parsePrivateSettingsDocument(
        '{"format":"openmarkets.private-settings","version":1,"version":1,"settings":{}}'
      )
    ).toThrow()
    expect(() =>
      parsePrivateSettingsDocument({
        ...emptyPrivateSettings(),
        extra: "x".repeat(32769),
      })
    ).toThrow()
    expect(() =>
      parsePrivateSettingsDocument({ ...emptyPrivateSettings(), version: 2 })
    ).toThrow("unsupported")
  })
  test("address removal and default selection are atomic; nested unknown address fields survive", () => {
    const id = crypto.randomUUID()
    const address = {
      recipientName: "Test",
      addressLine1: "Synthetic",
      city: "Town",
      country: "US",
      postalCode: "00000",
      future: { nested: true },
    }
    const base = parsePrivateSettingsDocument({
      ...emptyPrivateSettings(),
      settings: {
        shipping: { savedAddresses: { [id]: address }, defaultAddressId: id },
      },
    })
    expect(() =>
      rebaseSettings(
        {
          baseline: base,
          changes: [
            {
              path: "shipping",
              value: { savedAddresses: {}, defaultAddressId: id },
            },
          ],
        },
        base,
        "a".repeat(64)
      )
    ).toThrow()
    const next = rebaseSettings(
      {
        baseline: base,
        changes: [
          {
            path: "shipping",
            value: {
              savedAddresses: { [id]: { ...address, city: "New town" } },
              defaultAddressId: id,
            },
          },
        ],
      },
      base,
      "a".repeat(64)
    )
    expect(next.settings.shipping!.savedAddresses[id]!.future).toEqual({
      nested: true,
    })
    expect(
      rebaseSettings(
        {
          baseline: base,
          changes: [
            {
              path: "shipping",
              value: { savedAddresses: {}, defaultAddressId: null },
            },
          ],
        },
        base,
        "a".repeat(64)
      ).settings.shipping!.savedAddresses
    ).toEqual({})
  })
})
describe("ordinary settings coordination", () => {
  test("rebase disjoint stale edits, reject overlaps without signing or losing draft", async () => {
    const f = fixture(),
      c = f.coordinator(),
      baseline = emptyPrivateSettings()
    await c.publishPrivateSettings({
      baseline,
      changes: [{ path: "display.currency", value: "EUR" }],
    })
    const next = await c.publishPrivateSettings({
      baseline,
      changes: [{ path: "working.weightUnit", value: "kg" }],
    })
    expect(next.document.settings.display?.currency).toBe("EUR")
    expect(next.document.settings.working?.weightUnit).toBe("kg")
    const draft = {
      baseline,
      changes: [{ path: "display.currency", value: "GBP" }],
    }
    const signed = f.counts().signs
    await expect(c.publishPrivateSettings(draft)).rejects.toThrow("conflict")
    expect(f.counts().signs).toBe(signed)
    expect(draft.changes[0]!.value).toBe("GBP")
  })
  test("concurrent local saves serialize and retain disjoint changes", async () => {
    const f = fixture(),
      c = f.coordinator(),
      baseline = emptyPrivateSettings()
    await Promise.all([
      c.publishPrivateSettings({
        baseline,
        changes: [{ path: "display.currency", value: "EUR" }],
      }),
      c.publishPrivateSettings({
        baseline,
        changes: [{ path: "working.weightUnit", value: "oz" }],
      }),
    ])
    const result = await c.readPrivate()
    expect(result.document.settings.display?.currency).toBe("EUR")
    expect(result.document.settings.working?.weightUnit).toBe("oz")
  })
  test("restart retries exact signed bytes and offline reads preserve state", async () => {
    const f = fixture()
    f.offline(true)
    const saved = await f.coordinator().publishPrivateSettings({
      baseline: emptyPrivateSettings(),
      changes: [{ path: "display.currency", value: "EUR" }],
    })
    expect(saved.delivery).toBe("local")
    expect(
      (await f.coordinator().readPrivate()).document.settings.display?.currency
    ).toBe("EUR")
    const count = f.counts().signs
    f.offline(false)
    expect((await f.coordinator().readPrivate()).delivery).toBe("observed")
    expect(f.published[0]!.id).toBe(saved.event!.id)
    expect(f.counts().signs).toBe(count)
  })
  test("storage failure prevents all egress and does not fabricate local success", async () => {
    const f = fixture()
    f.fail(true)
    await expect(
      f.coordinator().publishPrivateSettings({
        baseline: emptyPrivateSettings(),
        changes: [{ path: "display.currency", value: "EUR" }],
      })
    ).rejects.toThrow("storage")
    expect(f.published).toHaveLength(0)
  })
  test("unsupported newer major blocks downgrade and retains last usable display", async () => {
    const f = fixture(),
      c = f.coordinator()
    const saved = await c.publishPrivateSettings({
      baseline: emptyPrivateSettings(),
      changes: [{ path: "display.currency", value: "EUR" }],
    })
    await c.readPrivate()
    f.remote.push(
      f.event(
        PRIVATE_SETTINGS_KIND,
        { ...emptyPrivateSettings(), version: 2 },
        1002
      )
    )
    const result = await c.readPrivate()
    expect(result.problem).toBe("unsupported")
    expect(result.document.settings.display?.currency).toBe("EUR")
    await expect(
      c.publishPrivateSettings({
        baseline: saved.document,
        changes: [{ path: "working.weightUnit", value: "kg" }],
      })
    ).rejects.toThrow("unsupported")
    expect(f.published).toHaveLength(1)
  })
  test("refusal pauses repeated decrypts; settings do not touch wallet transport", async () => {
    const f = fixture(),
      c = f.coordinator()
    f.remote.push(f.event(PRIVATE_SETTINGS_KIND, emptyPrivateSettings()))
    f.deny()
    expect((await c.readPrivate()).problem).toBe("signer")
    const count = f.counts().decrypts
    await c.readPrivate()
    await c.readPublic()
    expect(f.counts().decrypts).toBe(count)
    expect(f.published).toHaveLength(0)
  })
  test("account replacement fences delayed signer results before persistence/publication", async () => {
    const f = fixture(),
      original = f.signer.encryptNip44
    f.signer.encryptNip44 = async (...args) => {
      const value = await original(...args)
      f.retire()
      return value
    }
    await expect(
      f.coordinator().publishPrivateSettings({
        baseline: emptyPrivateSettings(),
        changes: [{ path: "display.currency", value: "EUR" }],
      })
    ).rejects.toThrow("session")
    expect(f.rows.size).toBe(0)
    expect(f.published).toHaveLength(0)
  })
  test("equal timestamps use lowest ID independently of arrival order", () => {
    const f = fixture(),
      a = f.event(PUBLIC_SETTINGS_KIND, emptyPublicSettings()),
      b = f.event(PUBLIC_SETTINGS_KIND, {
        ...emptyPublicSettings(),
        settings: { merchant: { notice: "Open" } },
      })
    expect([a, b].sort(compareSettingsEvents)[0]!.id).toBe(
      [a.id, b.id].sort()[0]!
    )
    expect([b, a].sort(compareSettingsEvents)[0]!.id).toBe(
      [a.id, b.id].sort()[0]!
    )
  })
  test("real IndexedDB compare-and-swap stages atomically without touching domain DB", async () => {
    const db = new OrdinarySettingsDB(`settings-test-${crypto.randomUUID()}`, {
        indexedDB: new IDBFactory(),
        IDBKeyRange,
      }),
      store = createSettingsStore(db),
      f = fixture()
    const a = f.event(PUBLIC_SETTINGS_KIND, emptyPublicSettings()),
      key = `${a.pubkey}:${a.kind}`
    await store.put({ key, head: a, pending: { event: a } }, undefined)
    await expect(
      store.put(
        {
          key,
          head: f.event(PUBLIC_SETTINGS_KIND, emptyPublicSettings(), 1001),
        },
        undefined
      )
    ).rejects.toThrow("conflict")
    expect((await store.get(key)).pending?.event.id).toBe(a.id)
    expect(db.tables.map((table) => table.name)).toEqual(["records"])
    await db.delete()
  })
})

describe("settings restart and persistence boundaries", () => {
  test("restart rebases disjoint pending edits onto the newest relay snapshot", async () => {
    const f = fixture()
    f.offline(true)
    await f.coordinator().publishPrivateSettings({
      baseline: emptyPrivateSettings(),
      changes: [{ path: "display.currency", value: "EUR" }],
    })
    f.remote.push(
      f.event(
        PRIVATE_SETTINGS_KIND,
        {
          ...emptyPrivateSettings(),
          settings: { working: { weightUnit: "kg" } },
        },
        1001
      )
    )
    f.offline(false)
    const restored = await f.coordinator().readPrivate()
    expect(restored.document.settings.display?.currency).toBe("EUR")
    expect(restored.document.settings.working?.weightUnit).toBe("kg")
    expect(restored.delivery).toBe("observed")
    expect(f.published).toHaveLength(1)
    expect(f.published[0]!.created_at).toBe(1002)
  })
  test("restart keeps overlapping encrypted draft without republishing the loser", async () => {
    const f = fixture()
    f.offline(true)
    const draft = await f.coordinator().publishPrivateSettings({
      baseline: emptyPrivateSettings(),
      changes: [{ path: "display.currency", value: "EUR" }],
    })
    f.remote.push(
      f.event(
        PRIVATE_SETTINGS_KIND,
        {
          ...emptyPrivateSettings(),
          settings: { display: { currency: "GBP" } },
        },
        1001
      )
    )
    f.offline(false)
    const c = f.coordinator(),
      restored = await c.readPrivate()
    expect(restored.problem).toBe("conflict")
    expect(restored.document.settings.display?.currency).toBe("GBP")
    expect(restored.pendingDraft?.changes).toContainEqual({
      path: "display.currency",
      value: "EUR",
    })
    expect(f.published).toHaveLength(0)
    expect(f.rows.values().next().value!.pending!.event.id).toBe(
      draft.event!.id
    )
    expect((await c.readPrivate()).document.settings.display?.currency).toBe(
      "GBP"
    )
    await expect(
      c.publishPrivateSettings({
        baseline: restored.document,
        changes: [{ path: "working.weightUnit", value: "kg" }],
      })
    ).rejects.toThrow("conflict")
    expect(f.rows.values().next().value!.pending!.event.id).toBe(
      draft.event!.id
    )
    expect(
      (
        await c.publishPrivateSettings({
          baseline: restored.document,
          changes: restored.pendingDraft!.changes,
          reviewedPendingEventId: restored.pendingEventId,
        })
      ).document.settings.display?.currency
    ).toBe("EUR")
  })
  test("staging failure after signature prevents publication", async () => {
    const f = fixture(),
      original = f.signer.signEvent
    f.signer.signEvent = async (...args) => {
      const event = await original(...args)
      f.fail(true)
      return event
    }
    await expect(
      f.coordinator().publishPrivateSettings({
        baseline: emptyPrivateSettings(),
        changes: [{ path: "display.currency", value: "EUR" }],
      })
    ).rejects.toThrow("storage")
    expect(f.counts().signs).toBe(1)
    expect(f.published).toHaveLength(0)
  })
  test("tampered signed response cannot reach storage or relays", async () => {
    const f = fixture(),
      original = f.signer.signEvent
    f.signer.signEvent = async (...args) => ({
      ...(await original(...args)),
      content: "changed",
    })
    await expect(
      f.coordinator().publishPrivateSettings({
        baseline: emptyPrivateSettings(),
        changes: [{ path: "display.currency", value: "EUR" }],
      })
    ).rejects.toThrow("invalid")
    expect(f.rows.size).toBe(0)
    expect(f.published).toHaveLength(0)
  })
  test("explicit save can resume after refusal, but retired coordinator cannot", async () => {
    const f = fixture(),
      c = f.coordinator()
    f.remote.push(f.event(PRIVATE_SETTINGS_KIND, emptyPrivateSettings()))
    f.deny()
    expect((await c.readPrivate()).problem).toBe("signer")
    f.deny(false)
    expect(
      (
        await c.publishPrivateSettings({
          baseline: emptyPrivateSettings(),
          changes: [{ path: "display.currency", value: "EUR" }],
        })
      ).document.settings.display?.currency
    ).toBe("EUR")
    c.stop()
    await expect(c.readPrivate()).rejects.toThrow("session")
  })
  test("future-dated current settings block timestamp escalation", async () => {
    const f = fixture()
    f.remote.push(f.event(PRIVATE_SETTINGS_KIND, emptyPrivateSettings(), 1060))
    await expect(
      f.coordinator().publishPrivateSettings({
        baseline: emptyPrivateSettings(),
        changes: [{ path: "display.currency", value: "EUR" }],
      })
    ).rejects.toThrow("clock")
    expect(f.counts().signs).toBe(0)
  })
  test("new ordinary documents never write wallet, shipping or product event kinds", async () => {
    const f = fixture(),
      c = f.coordinator()
    await c.publishPrivateSettings({
      baseline: emptyPrivateSettings(),
      changes: [{ path: "working.weightUnit", value: "kg" }],
    })
    await c.publishPublicSettings({
      baseline: emptyPublicSettings(),
      changes: [
        {
          path: "merchant.generalLocation",
          value: { location: "Synthetic town", geohash: "9q8y" },
        },
      ],
    })
    expect(f.published.map((e) => e.kind)).toEqual([
      PRIVATE_SETTINGS_KIND,
      PUBLIC_SETTINGS_KIND,
    ])
    const sources = await Promise.all(
      [
        "packages/core/src/settings/coordinator.ts",
        "packages/core/src/settings/store.ts",
      ].map((path) => Bun.file(path).text())
    )
    for (const source of sources) {
      expect(source).not.toContain("ConduitDB")
      expect(source).not.toContain("publishProduct")
      expect(source).not.toContain("portableWallet")
    }
  })
})

describe("Open Markets proposal fixtures", () => {
  for (const path of new Bun.Glob(
    "tests/fixtures/ordinary-settings/*.json"
  ).scanSync(".")) {
    test(path.split("/").at(-1)!, async () => {
      const fixture = await Bun.file(path).json()
      const parse =
        fixture.documentType === "public"
          ? parsePublicSettingsDocument
          : parsePrivateSettingsDocument
      if (fixture.valid)
        expect(parse(fixture.document)).toEqual(fixture.document)
      else expect(() => parse(fixture.document)).toThrow()
    })
  }
})
