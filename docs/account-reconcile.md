# Account reconcile runbook

The `reconcile` operation of the protected `beta-qualification.yml` entry bounds E2E leftover
data by time instead of by an operator (#217). It runs as a job before every `qualify` suite
and daily through `reconcile-schedule.yml`, which dispatches `operation=reconcile` with
`trigger=scheduled` through the same protected `workflow_dispatch` entry: the execution guard
requires that event, so a `schedule` event on the qualify entry would fail closed.

There is no manual repair step and no attempt or predecessor chain to supply. A teardown that
cannot prove deletion records the identity `retained` with a reason and a `reconcileBy` bound
(24 hours after the account record's own `createdAt`), fails its own run exactly as before, and
is resolved by this operation.

## How an identity is attributed

Attribution follows the creator, not the address. Every attempt leases one of the eight stable
pool rows (`e2e-beta-worker-0..7-chromium@anywear.local`), so a later run reuses the same
address; the address alone can never name the run that created the identity now bound to it.
The creating run is named twice:

- **The credential session.** Every protected credential step assumes
  `beta-e2e-qualification-role` with
  `role-session-name: e2e-<github.run_id>-<github.run_attempt>`. AWS writes that session into
  the `AdminCreateUser` CloudTrail event before the identity exists, so the creation names its
  run with no new write, store, attribute or permission. `scripts/execution-guard.mjs` requires
  the authenticated principal ARN to end `/e2e-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`, and
  `tests/support/account.ts` calls the guard immediately before `AdminCreateUser`.
- **The run's manifest.** The run's lifecycle artifact records the address and its captured
  `sub` under its own `runScope`.

A creation newer than a manifest record **displaces** it: a successful `AdminCreateUser` proves
the identity the record named was absent, so the record's stale subject must not judge the live
one. The live `sub` is read back with `AdminGetUser` instead.

## What the operation reads

Both sources are read over the same window, and the window is recorded in the result: seven
days for every ordinary invocation, or the 90-day artifact retention for the one recorded
migration dispatch. The migration window starts marginally inside CloudTrail's 90-day
`LookupEvents` history, because a range starting exactly at `now - 90 days` can already be
outside the accepted range when it is read. The artifact read is bounded to nine lifecycle
artifacts per lookback day; the repository's other workflows' artifacts are paged through but
never consume that bound, and a listing that cannot be read to its last page fails closed
rather than truncating.

- **Lifecycle artifacts** — the `beta-account-lifecycle-<run>-<attempt>` and
  `beta-smoke-account-lifecycle-<run>-<attempt>` artifacts of the lookback. An artifact is
  authoritative only when it is bound to the protected run: its name's run is the run the
  artifact API reports, that run is on `main`, the artifact and its head repository are this
  repository, and one cached `GET actions/runs/<run>` shows
  `path: .github/workflows/beta-qualification.yml`, `event: workflow_dispatch`,
  `head_branch: main` and a consistent `head_sha`. A run's conclusion is deliberately not
  required: a failed or cancelled run's manifest is exactly the leftover to read. An unbound
  artifact — including a lifecycle-named artifact whose readable cached run fails the workflow
  binding — is ignored and counted in `sources.artifacts_ignored`, never authoritative. Only a
  lookup that cannot be read at all is a source failure. A bound artifact whose bytes fail the
  digest or archive checks is a source failure too, and so is one whose listing has no
  well-formed `sha256:<64 hex>` digest.
- **The upload set is closed** — `account-budget.json`, the historical
  `account-budget-oldest-client.json`, `service-cleanup-operation.json` and
  `service-cleanup-run.json`. The smoke artifact carries the first, third and fourth. Every
  `account-budget*.json` present is read as a manifest, so the addresses feed one identity
  set; `service-cleanup-operation.json` is indexed as a durable cleanup witness source, and
  `service-cleanup-run.json` is not read. The oldest-client manifest is no longer
  produced for new runs since #256 removed the oldest-Client leg, but it stays in the closed
  set because runs recorded before that change still uploaded it. Any other name, a
  directory, a symlink, a duplicate or an over-bound file refuses the artifact. No specific
  manifest is required.
- **CloudTrail `AdminCreateUser`** — the Beta pool creations in the window, attributed through
  the caller and the credential session. A creation for an address with no manifest entry is an
  orphan whose run comes from the session and whose `sub` is read back; a creation recorded
  before run-scoped sessions has no run, and its record names the creation event. The caller is
  still checked against the qualification role, so the identity is attributable even though the
  record's `origin` carries no role field. A creation by any other principal is reported as
  `unattributable_caller` and **never deleted**.

The reconcile also reads its own `beta-account-reconcile-<run>-<attempt>` artifact family,
under the same protected-run binding the lifecycle family uses: `account-reconcile.json` and
`deployment-evidence.json` are its diagnostics, and every
`service-cleanup-<index>-<scope>.json` is one per-scope Service cleanup operation record. A
cleanup is proved by the strongest evidence that survives: first the live ECS tasks and the
unique `ANYWEAR_BETA_CLEANUP_RESULT=` completion marker, then the marker alone once a stopped
task has aged out of ECS's one-hour retention, and last a previously verified operation record
for that exact execution from either artifact family. A record accepted this way is bound to
the execution, envelope, request, run scope, instance and committed counters being re-proved,
is stamped `proof_origin: artifact` with its source named, and never stands in for a task ECS
can still return. When none of the three survives, the cleanup is refused at `task_proof`
and the identity stays `retained` and unresolved.

A manifest entry is authoritative for its address, captured subject and run. Every
non-`deleted` worker record is a leftover: `reserved`, `provisioning`, `in_use` and
`cleanup_pending` mean the teardown never proved absence, and `retained` (or a historical
`quarantined`) means it ran and failed. The latest record for an address wins, because a stable
pool address is reused: a later `deleted` record proves the address was resolved after the
older record was written.

## What the operation does per identity

1. Read the identity from Cognito (`AdminGetUser`). An absent identity whose manifest carries a
   subject still replays the Service cleanup, because the rows and objects may remain; an
   absent identity with no captured subject is `already_absent`, exit 0, with no request.
2. Verify the address and the captured subject. A mismatch, a missing immutable username or an
   unprovable address is reported and never deleted.
3. Submit the existing exact-reference Service cleanup in **normal** mode
   (`{runScope, users:[{sub,email}]}`, at most eight users), grouped by the captured run scope;
   a creation-only identity derives its scope from the run its session names. The scope is an
   operation/idempotency name and never a selector — the exact users select the rows and
   objects. The Service deletes the captured users' objects under `wearable-items/<sub>/`,
   `base-photos/<sub>/` and `outfit-generations/<sub>/`, plus the `task-attempts/vto/<vto_id>/`
   staging objects of their captured generations, reads absence back by listing, and only then
   deletes their rows; it
   commits `objects` and `objectsMissing`. Both counters are required: a Service release without
   them cannot prove the object phase, and the identity is recorded as a Service refusal and
   retained rather than reported clean.
4. Delete the Cognito identity by its immutable username — never by address — then read absence
   back. Only `UserNotFoundException` on a fresh read makes it `reconciled`.

The Service cleanup resolves the captured scope's deterministic execution names. Every dispatch
follows the ordinary rule: generation 0, then one bounded retry after generation 0 is terminal
non-success and one predecessor check shows the cleanup families stopped. The one 90-day
migration dispatch additionally carries the migration allowance below.

The identity set and its unresolved entries are proven against the record's closed contract
**before the first mutation**, so no input can throw after a deletion and lose the record.

## Outcomes that are reported, never resolved

Three conditions are written to the record, warned about, and never fail the reconcile:

| Reason | Condition |
| --- | --- |
| `unattributable_caller` | A creation by a principal other than the qualification role; the record also names the caller. |
| `unprovable_ownership` | A pool-address record with neither a captured subject nor a qualification-role creation event. |
| `outside_worker_family` | A manifest record outside the Beta worker families (a retired `ephemeral` or mailbox record). |

None can be resolved by any automatic path this design has, and failing every qualification on
one would reintroduce the operator dependency the issue removes. Every other unresolved reason
fails the reconcile at the 24-hour bound, and that failure is the alert. A bound breach is what
fails a run; a reported condition is what warns on it.

## The record

`reconcile/account-reconcile.json` is uploaded as
`beta-account-reconcile-<run>-<attempt>`. It is the `anywear_e2e_account_reconcile` v1 record
and the durable audit trail — the artifacts it was built from expire, the record does not.

```json
{
  "schema_version": 1,
  "record_type": "anywear_e2e_account_reconcile",
  "reconcile_id": "<dispatch run>-<attempt>",
  "window": { "from": "2026-10-16T00:00:00.000Z", "to": "2026-10-23T00:00:00.000Z" },
  "sources": { "artifacts": 12, "artifacts_ignored": 1, "cloudtrail_events": 34 },
  "identities": [
    {
      "email": "e2e-beta-worker-0-chromium@anywear.local",
      "subject": "<captured or read-back sub>",
      "origin": { "kind": "cloudtrail", "event_id": "<event id>", "event_time": "2026-10-22T03:14:07.000Z", "run": 1234567890, "attempt": 1 },
      "actions": { "service_cleanup": "committed", "cognito": "deleted", "objects": "deleted", "readback": "absent" },
      "outcome": "reconciled"
    }
  ],
  "unresolved": [],
  "result": "passed"
}
```

- `sources.artifacts` counts run-bound artifacts (not the manifests inside them),
  `sources.artifacts_ignored` counts lifecycle-named artifacts skipped because they could not be
  bound to the protected run, and `sources.cloudtrail_events` counts the events the creation set
  was built from.
- `origin` is `{kind: manifest, run, attempt}` or
  `{kind: cloudtrail, event_id, event_time}`, with `run`/`attempt` added to a cloudtrail origin
  when the creation's credential session names them. `subject` is `null` only for an absent
  identity whose subject could not be captured or read back.
- `actions.service_cleanup` is `committed`, `refused`, `unavailable` or `not_required`;
  `actions.cognito` is `deleted`, `already_absent`, `refused` or `not_attempted`;
  `actions.objects` is `deleted`, `absent`, `none`, `unavailable` or `not_required`;
  `actions.readback` is `absent`, `present`, `unreadable` or `not_attempted`.
- `outcome` is `reconciled`, `already_absent` or `retained`; a `retained` identity is also in
  `unresolved[]` with its reason and is retried.
- `unresolved[]` entries carry `{email, reason, origin}` and, for a foreign caller, `caller`.
  Reasons: `cognito_delete_refused`, `cognito_readback_failed`, `deadline_exceeded`,
  `outside_worker_family`, `service_cleanup_refused`, `service_cleanup_unavailable`,
  `subject_mismatch`, `unattributable_caller`, `unprovable_ownership`.

## Result and failure

The artifact scan is valid when it returns nothing: a seven-day window with no lifecycle
artifact is exactly the crashed-run case, and the identity set is then built from CloudTrail
alone with `sources.artifacts: 0`. Only an unreadable or truncated artifact list, unreadable
CloudTrail, an unreadable bound artifact (including a missing or malformed digest), or an
unreadable workflow-run lookup fails closed before any deletion — the empty scan is a recorded
no-op, not a refusal. A source failure writes no record and leaves the environment untouched,
because a record is a statement about a scan that read a stated window, and a record whose
sources are zeros would read as a quiet scan.

`result` is `passed` when every leftover was resolved or is still inside its `reconcileBy`
bound, and `failed` when a leftover is past its bound. A reported condition never fails the
run: it is emitted as a run warning. A failed run emits one error annotation per unresolved
identity naming its address, its reason and the original run (or CloudTrail event and session),
so the alert carries the attribution:

```text
::error title=Unresolved E2E leftover::e2e-beta-worker-3-chromium@anywear.local (service_cleanup_refused) from run 123 attempt 1
```

The job is bounded to 15 minutes and stops starting work at 720 seconds; the absolute in-job
deadline is passed into the cleanup wait, so a Service wait cannot outlive the job and the
record is still written. An identity a group could not finish is recorded `deadline_exceeded`
and retried by the next reconcile.

## The one migration dispatch

One reconciliation with `reconcile_lookback_days=90` is permitted before the removals. It reads
every artifact inside the 90-day retention, so a `quarantined` manifest from any run still
inside that retention is reconciled by the same path, and a pre-change creation inside
CloudTrail's 90-day history is cleared through its creation event even though its credential
session does not name a run; the record then names the creation event and no run. Its job is
bounded to 30 minutes, it states the window it read, and its record names every leftover it
could not resolve. A leftover older than both the artifact retention and CloudTrail's event
history is the one recorded residual, bounded by the eight pool rows.

The migration dispatch also carries the one **migration allowance** (#217). A captured scope
whose cleanup operation never committed may already have spent both ordinary generations, and
the cleanup capability's names are deterministic, so a further ordinary dispatch refuses with
`retry_not_authorized` and the leftover can never be resolved automatically. The allowance adds
exactly one name, `beta-cleanup-<runScope>-<request_sha16>-migration1`, derived from the same
envelope and bounded to the Step Functions execution-name limit (the base is truncated so the
longer suffix fits). It may start only when generation 0 and the `-retry1` generation both
exist and are terminal non-success, and one bounded predecessor check shows the cleanup families
stopped; the captured `runScope` and the cleanup operation identity are preserved, never
re-scoped. It is started at most once: an existing migration execution is resumed while it is
`RUNNING` and verified when it `SUCCEEDED`, and when it is itself terminal non-success the
dispatch refuses and starts nothing else, so there is no fourth attempt. The allowance never
manufactures its own precondition — a migration dispatch that finds the retry absent refuses
rather than starting it — while generation 0 keeps its ordinary behavior so a scope with no
execution is still cleaned. The ordinary seven-day reconcile, `full`, `smoke` and the
qualification teardown leave the allowance unset and keep the unchanged two-name rule.

Dispatch it from `main` with:

```text
gh workflow run beta-qualification.yml --ref main \
  -f operation=reconcile -f reconcile_lookback_days=90 -f trigger=manual
```

## Budget

`retained` is not a capacity gate: it consumes no active-account budget, so it cannot exhaust a
later run's budget, while its own address stays out of the pool — a lease is refused with the
retained reason — until this operation deletes the identity and the record is written `deleted`.
`maxNewAccountsPerRun` still counts every attempt, retained or not.

A `full` run whose own cleanup is not verified still withholds the qualification record: the
teardown gate is unchanged, and a deferred cleanup is never evidence of a verified one.

## Relationship to the removed `recover` operation

The manual `recover` operation is removed, together with its dispatch inputs,
`account-recovery-inputs.mjs`, the frozen cleanup diagnostic (`beta-cleanup-diagnostic.mjs`) and
its retained diagnostic tuple (#217). `reconcile` needs none of them: it reads the run-bound
lifecycle manifests and CloudTrail, not a pinned historical evidence artifact, and it resolves a
leftover without an operator supplying a run id, an attempt number or a predecessor chain. A
historical manifest that recorded `quarantined` is read as `retained`, so the records written
before the removal are resolved by this operation rather than stranded.
