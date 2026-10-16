import { describe, expect, it } from "bun:test"

/** Exercise cold-worker recovery and real IDB transactions without global test leakage. */
function runScenario(scenario: string): void {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `
      import { indexedDB, IDBKeyRange } from "fake-indexeddb";
      import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
      globalThis.indexedDB = indexedDB;
      globalThis.IDBKeyRange = IDBKeyRange;
      const { db } = await import("./packages/core/src/db");
      const proof = await import("./packages/core/src/protocol/verified-public-event");
      const follows = await import("./packages/core/src/protocol/follows");
      const shipping = await import("./packages/core/src/protocol/merchant-shipping-settings");
      const secret = generateSecretKey();
      const pubkey = getPublicKey(secret);
      const target = getPublicKey(generateSecretKey());
      const sign = (kind, tags, created_at = 100, content = "") => finalizeEvent({kind, tags, created_at, content}, secret);
      const event = sign(3, [["p", target]]);
      const relays = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
      const row = { pubkey, event, state: "observed", sourceRelayUrls: [relays[0]], cachedAt: 100000 };
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const failWorker = () => {
        proof.__resetPublicEventVerificationForTests();
        follows.__resetFollowListTestState();
        globalThis.window = { location: { hostname: "localhost" }, addEventListener() {},
          localStorage: { getItem() { return null; }, setItem() {} } };
        globalThis.Worker = undefined;
      };
      const recoverWorker = () => {
        delete globalThis.window;
        proof.__resetPublicEventVerificationForTests();
      };
      const subject = { pubkeys: [pubkey], authenticatedPubkey: pubkey, accountPubkey: pubkey };
      const options = {
        now: () => 200000,
        readAccountRelaySettingsPlanningSnapshot: async () => null,
        resolveRelayListsDetailed: async () => ({
          relayLists: new Map([[pubkey, { pubkey, writeRelayUrls: relays, readRelayUrls: [], lookupState: "network", eventCreatedAt: 1, cachedAt: 1 }]]),
          resolutionStates: new Map([[pubkey, "network"]]),
        }),
        fetchEvents: async (_filter, plan) => ({ events: [], eventSourceRelayUrls: {},
          relays: plan.relayUrls.map(relayUrl => ({ relayUrl, status: "success", eventCount: 0, rejectedEventCount: 0 })) }),
      };
      const liveOptions = (admitted, source = relays[0]) => ({
        ...options,
        fetchEvents: async (_filter, plan) => ({ events: [admitted], eventSourceRelayUrls: { [admitted.id]: [source] },
          relays: plan.relayUrls.map(relayUrl => ({ relayUrl, status: "success", eventCount: 1, rejectedEventCount: 0 })) }),
      });
      ${scenario}
      db.close();
      process.stdout.write("ok");
      process.exit(0);
    `,
    ],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = result.stdout.toString() + result.stderr.toString()
  expect(result.exitCode, output).toBe(0)
  expect(output).toContain("ok")
}

describe("retained follow-list admission", () => {
  it("preserves immutable proof through repeated restores and duplicate observations", () => {
    runScenario(`
      await db.ownContactListSnapshots.put(row);
      for (let i = 0; i < 3; i++) {
        const retained = await follows.readRetainedOwnFollowListSnapshot(pubkey, { now: options.now });
        assert(proof.isVerifiedNostrEvent(retained?.event), "restore lost proof");
        assert(Object.isFrozen(retained.event) && Object.isFrozen(retained.event.tags[0]), "restored proof is mutable");
      }
      const admitted = (await proof.admitPublicEvent(event)).event;
      await follows.readLatestFollowLists(subject, liveOptions(admitted, relays[1]));
      const read = await follows.readLatestFollowLists(subject, options);
      assert(read.verificationComplete && proof.isVerifiedNostrEvent(read.events[0]), "complete read returned raw bytes");
      assert(Object.isFrozen(read.events[0].tags[0]), "read returned mutable tags");
      assert(read.authors[0].eventSourceRelayUrls.includes(relays[1]), "duplicate observation lost its source");
    `)
  }, 20000)

  it("reports unavailable retained evidence during empty relay reads and recovers without rewriting storage", () => {
    runScenario(`
      await db.ownContactListSnapshots.put(row);
      const before = JSON.stringify(await db.ownContactListSnapshots.get(pubkey));
      failWorker();
      const read = await follows.readLatestFollowLists(subject, options);
      assert(read.authors[0].coverage === "unavailable" && !read.verificationComplete, "outage became confirmed absence");
      assert(read.events.length === 0, "unverified bytes escaped as evidence");
      let retainedBlocked = false;
      try { await follows.readRetainedOwnFollowListSnapshot(pubkey); }
      catch (error) { retainedBlocked = error instanceof follows.FollowListEvidenceUnavailableError; }
      assert(retainedBlocked, "retained read reported absence");
      let signed = 0;
      let published = 0;
      const signer = { getPublicKey: async () => pubkey, signEvent: async draft => { signed++; return finalizeEvent(draft, secret); } };
      follows.__setFollowListTestOverrides({ getAccountSigner: () => signer, readLatestFollowLists: async () => read,
        publishWithPlanner: async () => { published++; return { successfulRelayUrls: [relays[0]] }; } });
      let blocked = false;
      try { await follows.publishContactListUpdate({ ownerPubkey: pubkey, targetPubkey: getPublicKey(generateSecretKey()), shouldFollow: true, appId: "market" }); }
      catch { blocked = true; }
      assert(blocked && signed === 0 && published === 0, "outage authorized an initial replacement");
      assert(JSON.stringify(await db.ownContactListSnapshots.get(pubkey)) === before, "outage changed durable bytes");
      recoverWorker();
      const recovered = await follows.readRetainedOwnFollowListSnapshot(pubkey, { now: options.now });
      assert(recovered?.event.id === event.id && proof.isVerifiedNostrEvent(recovered.event), "retained list did not recover");
    `)
  }, 20000)

  for (const invalid of ['{ ...event, content: "tampered" }', "null"]) {
    it(`repairs a stable ${invalid === "null" ? "malformed" : "invalid"} row from live evidence and admits a newly signed replacement`, () => {
      runScenario(`
      await db.ownContactListSnapshots.put({ ...row, event: ${invalid} });
      const admitted = (await proof.admitPublicEvent(event)).event;
      const read = await follows.readLatestFollowLists(subject, liveOptions(admitted));
      const repaired = await db.ownContactListSnapshots.get(pubkey);
      assert(proof.sameSignedPublicEvent(repaired.event, event), "invalid row was not repaired");
      assert(proof.isVerifiedNostrEvent(read.events[0]), "live evidence lost proof");
      let published = 0;
      const signer = { getPublicKey: async () => pubkey, signEvent: async draft => finalizeEvent(draft, secret) };
      follows.__setFollowListTestOverrides({ getAccountSigner: () => signer, readLatestFollowLists: async () => read,
        publishWithPlanner: async () => { published++; return { successfulRelayUrls: [relays[1]] }; } });
      await follows.publishContactListUpdate({ ownerPubkey: pubkey, targetPubkey: getPublicKey(generateSecretKey()), shouldFollow: true, appId: "market" });
      const next = await db.ownContactListSnapshots.get(pubkey);
      assert(published === 1 && next.state === "observed", "repaired storage still blocked publication");
      const retained = follows.peekRetainedOwnFollowListSnapshot(pubkey);
      assert(proof.isVerifiedNostrEvent(retained?.event) && Object.isFrozen(retained.event.tags), "signer output bypassed admission");
    `)
    }, 20000)
  }

  it("merges concurrent source observations from the transaction-current metadata", () => {
    runScenario(`
      await db.ownContactListSnapshots.put(row);
      const admitted = (await proof.admitPublicEvent(event)).event;
      const originalGet = db.ownContactListSnapshots.get.bind(db.ownContactListSnapshots);
      let preflightLoads = 0;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      db.ownContactListSnapshots.get = async key => {
        const value = await originalGet(key);
        if (!db.constructor.currentTransaction) {
          preflightLoads++;
          if (preflightLoads === 3 || preflightLoads === 4) {
            if (preflightLoads === 4) release();
            await gate;
          }
        }
        return value;
      };
      const results = await Promise.all([
        follows.readLatestFollowLists(subject, liveOptions(admitted, relays[1])),
        follows.readLatestFollowLists(subject, liveOptions(admitted, relays[2])),
      ]);
      db.ownContactListSnapshots.get = originalGet;
      const stored = await originalGet(pubkey);
      const memory = follows.peekRetainedOwnFollowListSnapshot(pubkey, { now: options.now });
      assert(relays.every(url => stored.sourceRelayUrls.includes(url)), "durable sources lost a concurrent commit");
      assert(relays.every(url => memory.sourceRelayUrls.includes(url)), "memory sources lost a concurrent commit");
      assert(results.some(read => relays.every(url => read.authors[0].eventSourceRelayUrls.includes(url))), "returned read ignored transactional sources");
      assert(stored.state === "observed" && stored.cachedAt >= row.cachedAt, "metadata regressed");
    `)
  }, 20000)
})

describe("shipping evidence admission outcomes", () => {
  it("preserves stored evidence through verification outages, blocks saving, and recovers", () => {
    runScenario(`
      const settings = { countries: [], shipsFrom: null };
      const signedEvent = sign(30078, [["d", shipping.MERCHANT_SHIPPING_SETTINGS_D_TAG]], 100, shipping.serializeMerchantShippingSettings(settings));
      await db.merchantShippingSettingsEvidence.put({ pubkey, signedEvent });
      const before = JSON.stringify(await db.merchantShippingSettingsEvidence.get(pubkey));
      failWorker();
      const dependencies = { evidenceDb: db, readRelayUrls: [], signer: { getPublicKey: async () => pubkey,
        signEvent: async () => { throw new Error("must not sign"); } } };
      const read = await shipping.fetchMerchantShippingSettings(pubkey, dependencies);
      assert(read.state === "unavailable" && read.reason === "verification_unavailable", "worker outage classified as invalid document");
      let blocked = false;
      try { await shipping.publishMerchantShippingSettings({ pubkey, settings, dependencies }); }
      catch (error) { blocked = error.message.includes("verification is unavailable"); }
      assert(blocked, "outage did not block saving");
      assert(JSON.stringify(await db.merchantShippingSettingsEvidence.get(pubkey)) === before, "outage changed storage");
      recoverWorker();
      const recovered = await shipping.fetchMerchantShippingSettings(pubkey, dependencies);
      assert(recovered.state === "found" && recovered.revision.eventId === signedEvent.id, "shipping settings did not recover");
    `)
  }, 20000)

  for (const source of ["network", "concurrent storage"] as const) {
    it(`reports a verification outage for ${source} evidence arriving during the read`, () => {
      runScenario(`
        const signedEvent = sign(30078, [["d", shipping.MERCHANT_SHIPPING_SETTINGS_D_TAG]], 100,
          shipping.serializeMerchantShippingSettings({ countries: [], shipsFrom: null }));
        const read = await shipping.fetchMerchantShippingSettings(pubkey, { evidenceDb: db, readRelayUrls: [relays[0]],
          fetchEvents: async () => {
            ${source === "concurrent storage" ? "await db.merchantShippingSettingsEvidence.put({ pubkey, signedEvent });" : ""}
            failWorker();
            return { events: ${source === "network" ? "[signedEvent]" : "[]"}, eventSourceRelayUrls: {},
              relays: [{ relayUrl: relays[0], status: "success", eventCount: ${source === "network" ? "1" : "0"} }] };
          },
        });
        assert(read.state === "unavailable" && read.reason === "verification_unavailable", "verification outage was collapsed");
        const stored = await db.merchantShippingSettingsEvidence.get(pubkey);
        ${
          source === "concurrent storage"
            ? 'assert(JSON.stringify(stored.signedEvent) === JSON.stringify(signedEvent), "concurrent bytes changed");'
            : 'assert(!stored, "unverified network evidence was stored");'
        }
      `)
    }, 20000)
  }
})
