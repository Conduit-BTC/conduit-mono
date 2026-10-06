import { describe, expect, it } from "bun:test"

const coreUrl = new URL("../packages/core/src/index.ts", import.meta.url).href
const repositoryUrl = new URL(
  "../apps/market/src/lib/cart-repository.ts",
  import.meta.url
).href
const proofUrl = new URL(
  "../packages/core/src/protocol/verified-public-event.ts",
  import.meta.url
).href

function runIsolatedCartScenario(scenario: string): {
  exitCode: number
  output: string
} {
  const script = `
    import { indexedDB, IDBKeyRange } from "fake-indexeddb";
    import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
    globalThis.indexedDB = indexedDB;
    globalThis.IDBKeyRange = IDBKeyRange;
    const storage = new Map();
    globalThis.window = {
      location: { hostname: "localhost" },
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      addEventListener() {},
    };
    globalThis.document = { visibilityState: "visible", addEventListener() {} };
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = finalizeEvent({ kind: 30402, created_at: 100, content: "", tags: [
      ["d", "one"], ["title", "One"], ["price", "1", "SATS"],
      ["type", "simple", "physical"],
    ] }, secret);
    const item = {
      productId: \`30402:\${pubkey}:one\`, merchantPubkey: pubkey,
      title: "One", price: 1, currency: "SATS", quantity: 1,
      format: "physical", productEventId: event.id, productUpdatedAt: 100000,
      signedProductEvent: event,
    };
    const core = await import(${JSON.stringify(coreUrl)});
    const proof = await import(${JSON.stringify(proofUrl)});
    const repo = await import(${JSON.stringify(repositoryUrl)});
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    ${scenario}
    await core.db.close();
    process.stdout.write("ok");
    process.exit(0);
  `
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode ?? -1,
    output: result.stdout.toString() + result.stderr.toString(),
  }
}

describe("cart stored product proof", () => {
  it("restores exact signed bytes as immutable action evidence after IDB cloning", () => {
    const result = runIsolatedCartScenario(`
      await core.db.shoppingCarts.put({ id: "market", version: 1, revision: 1,
        nextSequence: 3, migratedAt: 1, updatedAt: 1,
        lines: [{ id: "line:1", item, batches: [{ id: "batch:2", quantity: 1 }] }],
      });
      await repo.initializeCartRepository();
      const restored = repo.getCartRepositorySnapshot().items[0]?.signedProductEvent;
      assert(proof.isVerifiedNostrEvent(restored), "persisted event was not admitted");
      assert(restored.id === event.id && restored.sig === event.sig, "signed bytes changed");
      assert(Object.isFrozen(restored) && Object.isFrozen(restored.tags[0]), "proof is mutable");
    `)
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain("ok")
  }, 20000)

  it("keeps a tampered stored event as display data without action proof", () => {
    const result = runIsolatedCartScenario(`
      item.signedProductEvent = { ...event, content: "changed after signing" };
      await core.db.shoppingCarts.put({ id: "market", version: 1, revision: 1,
        nextSequence: 3, migratedAt: 1, updatedAt: 1,
        lines: [{ id: "line:1", item, batches: [{ id: "batch:2", quantity: 1 }] }],
      });
      await repo.initializeCartRepository();
      const restored = repo.getCartRepositorySnapshot().items[0];
      assert(restored?.title === "One", "display projection disappeared");
      assert(restored.signedProductEvent === undefined, "tampered event was trusted");
    `)
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain("ok")
  }, 20000)

  it("keeps legacy bytes and blocks cutover when verification is unavailable", () => {
    const result = runIsolatedCartScenario(`
      storage.set(repo.LEGACY_CART_STORAGE_KEY, JSON.stringify({ version: 2, items: [item] }));
      const original = storage.get(repo.LEGACY_CART_STORAGE_KEY);
      proof.__resetPublicEventVerificationForTests();
      globalThis.Worker = undefined;
      await repo.initializeCartRepository();
      assert(storage.get(repo.LEGACY_CART_STORAGE_KEY) === original, "legacy bytes were replaced");
      assert(await core.db.shoppingCarts.get("market") === undefined, "empty cart was migrated");
    `)
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain("ok")
  }, 20000)

  it("does not capture stale cart state when verification becomes unavailable", () => {
    const result = runIsolatedCartScenario(`
      await core.db.shoppingCarts.put({ id: "market", version: 1, revision: 1,
        nextSequence: 3, migratedAt: 1, updatedAt: 1,
        lines: [{ id: "line:1", item, batches: [{ id: "batch:2", quantity: 1 }] }],
      });
      await repo.initializeCartRepository();
      const snapshot = repo.getCartRepositorySnapshot();
      assert(snapshot.items.length === 1, "cart did not hydrate");
      const model = await import(${JSON.stringify(new URL("../apps/market/src/lib/cart-model.ts", import.meta.url).href)});
      const purchaseId = model.groupCartPurchases(snapshot.items)[0].id;
      proof.__resetPublicEventVerificationForTests();
      globalThis.Worker = undefined;
      let blocked = false;
      try { await repo.captureCartPurchase(purchaseId, snapshot.items); }
      catch (error) { blocked = error?.name === "CartVerificationUnavailableError"; }
      assert(blocked, "capture accepted stale cart after verification became unavailable");
    `)
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain("ok")
  }, 20000)
})
