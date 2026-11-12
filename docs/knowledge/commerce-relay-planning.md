# Commerce relay planning ownership

`commerce-read-relay-plan.ts` owns the existing commerce read planner and its
bounded legacy direct-message policy. Both the commerce facade and the inbox
consume this owner directly; inbox synchronization does not import the facade.
The facade keeps `planLegacyDirectMessageRead` as a re-export of the same function.

This boundary preserves policy rather than introducing a new relay selection
strategy. It keeps durable signed owner settings, authoritative signed-empty
settings, bounded legacy compatibility sources, and relay-target lineage. Generic
public fallback relays still do not authorize protected inbox reads. Planning does
not replace final transport admission or grant new protected-read authority.

The inbox still skips default legacy planning when `includeLegacy` is false or
an explicit legacy plan is supplied. It checks its current authorization after
awaiting legacy planning, before dispatching a transport read.

The facade's existing test override setter forwards its complete effective
planning overrides after each partial merge, and its reset clears them. The
planner reads those overrides at the original points in the asynchronous flow,
including after awaiting durable settings. Internal planner helpers and override
setters are not re-exported from protocol barrels.

`tests/commerce-legacy-relay-planning.test.ts` characterizes these boundaries with
signed relay-list fixtures, an in-memory owner-evidence repository, and a real
inbox/store backed by IndexedDB. It forbids external network access and checks
revocation before transport dispatch. Existing commerce product and profile tests
cover the other consumers of the shared planner.
