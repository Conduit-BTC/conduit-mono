import { describe, expect, it } from "bun:test"

const root = new URL("..", import.meta.url).pathname

/** Isolate browser worker failures and real IndexedDB transactions from other suites. */
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
        const owner = await import("./packages/core/src/protocol/owner-relay-list-evidence");
        const media = await import("./packages/core/src/protocol/media-server-preferences");
        const mutation = await import("./packages/core/src/protocol/account-network-mutation");
        const proof = await import("./packages/core/src/protocol/verified-public-event");
        const secret = generateSecretKey();
        const pubkey = getPublicKey(secret);
        const relays = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
        const sign = (kind, tags, created_at = 100) => finalizeEvent({kind, tags, created_at, content: ""}, secret);
        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        const event = sign(10002, relays.map(url => ["r", url]));
        const admitted = await proof.admitPublicEvent(event);
        assert(admitted.status === "verified", "fixture admission failed");
        const retained = owner.applyOwnerRelayListDistributionStage(undefined, {
          pubkey, signedEvent: admitted.event, publishRelayUrls: relays,
          relayOutcomes: relays.map(relayUrl => ({relayUrl, publishStatus: "pending", publishAttemptCount: 0,
            readbackStatus: "pending", readbackAttemptCount: 0})),
          expectedCurrentEventId: null, stagedAt: 100000,
        });
        await db.ownerRelayListEvidence.put(structuredClone(retained));
        const values = new Map();
        const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
        const key = media.getMediaServerPreferencesStorageKey(pubkey);
        const published = sign(10063, [["server", "https://media.conduit.market"]]);
        const pending = sign(10063, [["server", "https://next.conduit.market"]], 101);
        const mediaRecord = {
          version: 1, owner: pubkey,
          published: {signedEvent: published, serverUrls: ["https://media.conduit.market"],
            sourceRelayUrls: relays, observedAt: 100000, completeObservedAt: 100000},
          frontier: {eventId: pending.id, createdAt: 101, state: "valid"},
          pending: {signedEvent: pending, serverUrls: ["https://next.conduit.market"], publishRelayUrls: relays,
            ownerSelectedRelayUrls: [], acknowledgedRelayUrls: [relays[0]], rejectedRelayUrls: [],
            timedOutRelayUrls: [relays[1]], stagedAt: 101000},
        };
        storage.setItem(key, JSON.stringify(mediaRecord));
        const failWorker = () => {
          proof.__resetPublicEventVerificationForTests();
          owner.__resetOwnerRelayListEvidenceForTests();
          media.__resetMediaServerPreferencesForTests();
          globalThis.window = {};
          globalThis.Worker = undefined;
        };
        ${scenario}
        db.close();
        process.stdout.write("ok");
        process.exit(0);
      `,
    ],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = result.stdout.toString() + result.stderr.toString()
  expect(result.exitCode, output).toBe(0)
  expect(output).toContain("ok")
}

describe("durable public evidence admission", () => {
  it("preserves every retained owner byte and outcome during a verifier and lookup outage", () => {
    runScenario(`
      const before = JSON.stringify(await db.ownerRelayListEvidence.get(pubkey));
      failWorker();
      const result = await owner.resolveOwnerRelayList(pubkey, {
        relayUrls: relays, now: () => 200000,
        fetchEventsWithDiagnostics: async () => ({events: [], attemptedRelayUrls: relays,
          successfulRelayUrls: [], failedRelayUrls: relays, cappedRelayUrls: []}),
      });
      assert(result.state === "lookup_unavailable", "outage was reported as usable evidence");
      assert(result.observation.coverage === "unavailable", "outage coverage lost");
      assert(JSON.stringify(await db.ownerRelayListEvidence.get(pubkey)) === before, "retained owner bytes were erased");
      delete globalThis.window;
      proof.__resetPublicEventVerificationForTests();
      const recovered = await owner.dexieOwnerRelayListEvidenceRepository.get(pubkey);
      assert(recovered.pendingDistribution.signedEvent.id === event.id, "pending retry was lost");
      assert(proof.isVerifiedNostrEvent(recovered.current.signedEvent), "recovery did not re-admit the event");
    `)
  }, 20000)

  it("preserves published and pending media bytes and blocks retry during a verifier outage", () => {
    runScenario(`
      const before = storage.getItem(key);
      failWorker();
      const result = await media.readMediaServerPreferences(pubkey, {
        storage, readRelayUrls: relays, now: () => 200000,
        fetchEvents: async () => { throw new Error("lookup unavailable"); },
      });
      assert(result.status === "lookup_unavailable", "outage was reported as usable evidence");
      assert(result.frontier === null && result.publishedRevision === null, "display bytes became action authority");
      assert(storage.getItem(key) === before, "recoverable media evidence was erased");
      let failure;
      try { await media.retryMediaServerPreferencesPublish({owner: pubkey, dependencies: {storage}}); }
      catch (error) { failure = error; }
      assert(failure?.code === "evidence_unavailable", "retry did not report verification unavailability");
      assert(storage.getItem(key) === before, "failed retry mutated retained bytes");
      delete globalThis.window;
      proof.__resetPublicEventVerificationForTests();
      const recovered = await media.readMediaServerPreferences(pubkey, {
        storage, readRelayUrls: relays, fetchEvents: async () => { throw new Error("lookup unavailable"); },
      });
      assert(recovered.pending?.signedEvent.id === pending.id, "pending retry did not recover");
      assert(recovered.publishedRevision?.eventId === published.id, "published evidence did not recover");
    `)
  }, 20000)

  it("sanitizes malformed same-version media display fields without changing storage", () => {
    runScenario(`
      const malformed = {...mediaRecord,
        published: {...mediaRecord.published, serverUrls: {}, sourceRelayUrls: {}},
        pending: {...mediaRecord.pending, publishRelayUrls: {}, acknowledgedRelayUrls: {}},
        latestLookup: {coverage: "surprise", observedAt: "yesterday"},
        draft: {serverUrls: {}, baseServerUrls: {}, baseEventId: {}, updatedAt: "yesterday"},
      };
      storage.setItem(key, JSON.stringify(malformed));
      const before = storage.getItem(key);
      const display = media.loadMediaServerPreferenceRecord(pubkey, storage);
      assert(Array.isArray(display.published?.serverUrls ?? []), "unsafe published display field");
      assert(Array.isArray(display.published?.sourceRelayUrls ?? []), "unsafe source display field");
      assert(!display.pending && !display.latestLookup && !display.draft, "malformed display metadata survived");
      assert(!proof.isVerifiedNostrEvent(display.published?.signedEvent), "display minted proof");
      assert(storage.getItem(key) === before, "display changed stored bytes");
    `)
  }, 20000)

  it("merges concurrent relay acknowledgements, attempt counts and source observations", () => {
    runScenario(`
      const repository = mutation.dexieAccountNetworkMutationRepository;
      const get = repository.get.bind(repository);
      let release, reads = 0;
      const gate = new Promise(resolve => release = resolve);
      repository.get = async account => {
        const snapshot = await get(account);
        if (++reads <= 2) { if (reads === 2) release(); await gate; }
        return snapshot;
      };
      await Promise.all(relays.slice(0, 2).map((relayUrl, index) => repository.recordOutcomes({
        pubkey, kind: 10002, signedEventId: event.id,
        update: {observedAt: 200000 + index, publish: [{relayUrl, status: "acked"}],
          readback: [{relayUrl, status: "observed"}]},
      })));
      const result = await get(pubkey);
      for (const outcome of result.ownerRelayList.pendingDistribution.relayOutcomes.slice(0, 2)) {
        assert(outcome.publishStatus === "acked" && outcome.publishAttemptCount === 1, "concurrent publish outcome lost");
        assert(outcome.readbackStatus === "observed" && outcome.readbackAttemptCount === 1, "concurrent readback outcome lost");
      }
      assert(result.ownerRelayList.current.sourceRelayUrls.length === 2, "concurrent sources lost");
      assert(result.ownerRelayList.lastUsable.sourceRelayUrls.length === 2, "last usable sources lost");
    `)
  }, 20000)

  it("stages inbox changes against the latest retained owner delivery metadata", () => {
    runScenario(`
      const repository = mutation.dexieAccountNetworkMutationRepository;
      const get = repository.get.bind(repository);
      let release, captured;
      const gate = new Promise(resolve => release = resolve);
      const capturedGate = new Promise(resolve => captured = resolve);
      let first = true;
      repository.get = async account => {
        const snapshot = await get(account);
        if (first) { first = false; captured(); await gate; }
        return snapshot;
      };
      const inbox = sign(10050, [["relay", relays[0]]], 102);
      const stage = repository.stage({pubkey, expectedRelayListEventId: event.id,
        expectedInboxDeclarationEventId: null, expectedExcludedRelayUrls: [],
        checkpoints: [{kind: 10050, signedEvent: (await proof.admitPublicEvent(inbox)).event, publishRelayUrls: relays}],
        previousInboxRelayUrls: [], removedRelayUrls: [], stagedAt: 250000});
      await capturedGate;
      await repository.recordOutcomes({pubkey, kind: 10002, signedEventId: event.id,
        update: {observedAt: 200000, publish: [{relayUrl: relays[0], status: "acked"}],
          readback: [{relayUrl: relays[0], status: "observed"}]}});
      release();
      await stage;
      const result = await get(pubkey);
      const outcome = result.ownerRelayList.pendingDistribution.relayOutcomes[0];
      assert(outcome.publishStatus === "acked" && outcome.publishAttemptCount === 1, "staging regressed acknowledgement");
      assert(outcome.readbackStatus === "observed" && outcome.readbackAttemptCount === 1, "staging regressed readback");
      assert(result.ownerRelayList.current.sourceRelayUrls.includes(relays[0]), "staging regressed sources");
      assert(result.inboxDeclaration.pendingDistribution.signedEvent.id === inbox.id, "inbox staging was lost");
    `)
  }, 20000)
})
