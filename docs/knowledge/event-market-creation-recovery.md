# Event Market creation recovery

Organizer creation saves stable calendar and market coordinates before signing.
The saved form is a publishing plan, not evidence that a signature exists or
that a relay accepted anything. Calendar wire validation must run before saving
a new plan. Organizer descriptions use the client's existing 1,000-character
limit after trimming; it is not a NIP-52 protocol limit. Line breaks and tabs
are ordinary prose. Other control characters remain invalid.

Restore the structural v1 plan without applying current authoring validation.
An invalid unsigned form must remain available for correction. Under the same
account-scoped browser lock used by publication, check retained evidence and
pinned signature IDs before changing or discarding the plan. Retention precedes
pointer saving, so a missing ID alone is not evidence that nothing was signed.
Unreadable evidence, changed account/session, a stale tab, or a competing lock
must leave the saved plan intact.

Initial plan staging uses the same lock as series creation, signing and repair.
Compare the visible plan with current storage before either resuming or creating
one, including when a plan disappeared because another tab completed it. A stale
Retry action must not become a new creation with a different identity.

For a single event, correction preserves its market identity. Discard removes
only a positively unsigned local plan. It never deletes retained signed events
or publishes a NIP-09 deletion. Signed records may already be public: finish
their exact-byte delivery retry, then use ordinary event editing to publish a
newer calendar revision at the same coordinate. Missing pinned signed bytes
need recovery; do not generate replacement signatures or a new market identity.

Series plans pin each signed event ID before network I/O as well as retaining
the signed event. A legacy series with no signature history is editable only
when its common description necessarily failed the old builder before signing.
Other legacy plans with missing history stay frozen for recovery. Empty local
storage or an incomplete relay read is not global absence evidence.

Web Locks coordinate the cooperating clients in one browser origin. They do not
promise atomicity across separate devices, origins, or older client versions.
Storage reset is not a recovery procedure. Keep the original browser profile
and its retained records while diagnosing an incomplete operation.

The creation-retry unit suite covers unsigned correction/discard, stable
coordinates, missing pointers, unavailable storage, account/tab fences, and
unchanged signed retries. The Event Market browser suite covers restoration,
correction, new creation, discard/reload, signed retry followed by editing,
series correction, native lock refusal and missing pinned series signatures.
These controlled fixtures do not establish an external extension, public-relay
delivery, physical-device recovery, or paid handout.

Recovery controls refresh retained-signature evidence after every publication
attempt, including when retention committed but the plan-pointer write failed.
The unchanged pointer is not proof that the draft is still unsigned. Legacy
series ID upgrades update the page's frozen plan immediately after persistence,
so repeated delivery failures can resume in the same page. Browser regressions
exercise both interruptions without reload and compare every canonical signed
field, including the signature, through the successful retry.
