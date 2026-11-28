# AnyWear E2E Agent Instructions

This repository owns system tests that cross at least two deployable AnyWear
boundaries. It uses TypeScript, Playwright Test, Node.js 24, and pnpm 11.18.0.

## Ownership Rules

- Keep mocked browser tests in `AnyWear-Client`.
- Keep Service route, database, contract, and CDK tests in `AnyWear-Service`.
- Add a test here only when it exercises the real Client and Service together,
  a deployed environment, or a real external identity/cloud boundary.
- Treat Client and Service as black boxes. Do not import their implementation
  modules into E2E tests.

## Stage Policy

- Do not run or gate the `AnyWear-E2E` suite in the dev stage. Dev-stage
  verification is covered by unit tests and integration tests; those are
  sufficient for that stage.
- Run this E2E suite only in the beta stage and later stages, including prod.
  Do not add dev-stage E2E jobs, release gates, or required checks.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Audit: `pnpm audit`
- Lint: `pnpm lint`
- Type check: `pnpm typecheck`
- Discover tests: `pnpm test:list`
- Smoke tests: `pnpm test:smoke`
- Release-gating deployed selection: `pnpm test:regression`; `pnpm test` runs the same
  selection, and the protected gate step runs it as the release gate
- Scenario classification: [docs/scenario-inventory.md](docs/scenario-inventory.md)

Run install and build commands from this repository.

## Test Design

- Tag stable critical paths with `@smoke`, release-gating scenarios with
  `@regression`, and all cross-repository scenarios with `@full-stack`.
- Classify every scenario in the [scenario inventory](docs/scenario-inventory.md):
  its policy class, intent, selecting invocation, evidence level, cleanup contract
  and what a red result means. A new scenario is admitted only under the testing
  policy's admission rule.
- Lease a distinct worker-pool address per parallel test attempt through the account-budget
  ledger, and generate unique records per test, so parallel execution is safe. The pool rows
  are stable by design; the lease, not a random address, is what separates attempts.
- Clean up every cloud resource created by a test in teardown, even after a
  failed assertion.
- Fail clearly when required environment variables are missing; do not silently
  skip a required CI gate.
- Use role, label, and visible-text locators before test IDs or CSS selectors.
- Never commit credentials, browser storage state, reports, traces, screenshots,
  or videos.
- The gate reads the live deployed tuple. The Client identifies itself through
  `build-metadata.json` (`source_commit`, `client_version`, `built_at`, schema 3) and the
  Service through `/health` (`service_commit`, `image_digest`, `minimum_client_version`);
  `full` compares those values with the dispatch expectation and refuses a mismatch before
  the suite, naming the observed and the expected value. The only committed input on the
  live path is `minimum-supported-client.json` (`{version}`): the reviewed Client floor,
  whose `version` must equal the live Service floor (a disagreement is a refusal, never an
  automatic choice). Every direct Service request in the deployed suite presents that
  version in the `X-AnyWear-Client-Version` header, and `tests/rejection-contract.spec.ts`
  proves the deployed Service refuses a Client below the floor with HTTP 400
  `CLIENT_VERSION_UNSUPPORTED` while admitting one at it. Do not add a committed file that
  describes the deployed revisions; that is what #180 removed.
- The release gate's verdict is the `full` run itself. Its run name carries the operation, the
  trigger and the expected Service commit, plus the dispatching run URL when a workflow
  dispatched the gate and the `@<actor>` that started it when a person did; the `preflight`
  step summary states the live Client and Service revisions, the
  image digest, the minimum Client version and the immutable Service release. The run re-reads
  both online identities after the suite, so a mismatch or a deployment change cannot gate the
  tuple. The
  audit trail is the `workflow_dispatch` event (actor and time), the run object
  (`conclusion`, `path`, `display_title`) and the `beta-e2e-diagnostics-*` artifact. There
  is no sealed record, no artifact a release consumer downloads and no cross-repository
  record lookup: checking out pinned source alone still does not prove the deployed system
  ran it, which is why the run's own identity read is the evidence.
- The gate reads the live Service release identity, never a manifest. The live Service
  commit must resolve to an immutable `service-artifacts-<service sha>` GitHub release whose
  tag resolves to that commit and whose four expected assets (`pre-sign-up.zip`,
  `post-confirmation.zip`, `runtime-policy.json`, `service-schema.json`) are each uploaded
  with a non-empty size and a published `sha256:<hex>` digest. The gate reads only the
  release and the tag ref through the GitHub API and downloads zero release asset bytes. An
  extra asset is ignored, so a pre-change five-asset release (the four plus the retired
  `service-artifacts.json`) stays gateable for rollback; its manifest is never read or
  parsed. The image digest stays in the live `/health` identity and is not compared with a
  release field.
- The qualification ledger is removed (#358). The `record` job, the v4 record's producer and
  verifier, the two archived ledger artifacts and the repository's own full-resource
  platform hash snapshot (`scripts/infra-observation.mjs`) are deleted with
  `scripts/qualification-record.mjs`. What survives is `scripts/deployment-evidence.mjs`:
  the two live identities, the committed floor comparison, the before/after stability
  check and the immutable Release identity. Do not reintroduce a record, a record job, a
  ledger artifact or a cross-repository record reader; `scripts/record-reader-census.test.mjs`
  names the forbidden ledger tokens and fails `pnpm check` if one returns.
- The consumer-side drift gate is removed (#259), and so is the ledger it fed (#358): `full`
  does not compare the deploy-smoke observation with this run's observation, the gate script and
  the strict ZIP reader it alone used are deleted, and there is no `record` job reading a
  record. `full` gates the tuple from its own before-read, the release-gating suite and its
  after-read. The removal follows decision D2(c) of
  [#226](https://github.com/git-malu/AnyWear/issues/226) (2026-11-02), which dropped the
  deploy-smoke precondition. `smoke` remains the on-demand diagnostic and still uploads its own
  revision evidence, which has no machine consumer, and `deploy-smoke` remains a live `trigger`
  value.
- The compatibility pin is **deleted** (#192): the committed pin file, `docs/compatibility-pin.md`,
  `docs/compatibility-v3.md` and the pin tools (`validate-compatibility-pin.mjs`,
  `migrate-compatibility.mjs`, `check-compatibility.mjs`) were removed, and no gate path read
  them (`beta-e2e.yml`, `pnpm check`, `test:core` and `test:list` are pin-free). The last manual
  expected-tuple readers — the `runtime-drill.mjs` and `runtime-recovery-artifact.mjs` CLIs —
  were retired with the runtime instrumentation ladder under #213, so no tracked command reads a
  deployed tuple or a committed deployment file, no workflow, `pnpm check`, `test:core` or
  `test:list` path is affected, and `minimum-supported-client.json` remains the only committed
  input on the live path.
- Beta registration is gated by the exact tester allowlist in the Cognito `PreSignUp`
  trigger (#213). The deployed scenarios lease one of the eight stable worker-pool addresses
  (`e2e-beta-worker-0-chromium@anywear.local` … `-7-`, offset by `E2E_WORKER_SLOT_OFFSET`) and
  never mint an address; the gate pre-flight refuses before the first account exists
  unless every pool address the run can lease is on the allowlist. Do not add a synthetic
  address family, an `E2E_PUBLIC_REGISTRATION_OPEN` switch, or any reader/writer of
  `custom:e2e_bootstrap` back.
- The release decision is the green `full` run. There is no separate approval job or approval
  Environment and no record to attach: the audit trail is the `workflow_dispatch` event (actor
  and time), the E2E `full` run object and the `beta-e2e-diagnostics-*` artifact. Do not add an
  approval Environment, approval/`Approved`/`Rejected` states, or a replacement ledger.
- The single protected gate entry in `beta-e2e.yml` owns the deployed operations for beta and
  later stages; it must not target dev. Separation between the gate, the smoke diagnostic and
  automatic leftover expiry lives in the signed `operation` field, not in a workflow-file
  boundary: only `full` runs the release-gating suite, and `execution-guard.mjs` maps each
  operation to that one entry. A `smoke` or `reconcile` run therefore cannot produce or
  withhold the verdict the `full` run carries, and a reconcile result is never substituted for
  gate evidence.
- Leftover data is bounded by time, not quarantined (#217). A teardown that cannot prove
  deletion records its identity `retained` with a `retainedReason` and a `reconcileBy` bound
  (24 hours after the account record's own `createdAt`), fails its own run exactly as before,
  and is resolved by the `reconcile` operation: a job before every gate suite, and a
  daily dispatch of the same protected `workflow_dispatch` entry by `AnyWear-Infra`'s
  scheduled entry (`schedule.yml`, `trigger=scheduled`). This repository has no schedule
  entry of its own: the daily dispatch has one starter, in the writer repository.
  There is no quarantine budget and no `quarantined` account status; a
  historical manifest recording `quarantined` reads as `retained`. `retained` consumes no
  active-account budget, while its own address stays out of the pool until the identity is
  deleted; `maxNewAccountsPerRun` still counts every attempt.
- A gate an operator dispatches is admitted only when no `AnyWear-Infra` writer is
  holding the served tuple (#344). For `trigger=manual` (all three operations) and
  `trigger=release-gate`, the credential-free preflight mints one read-only
  `AnyWear-Infra` App token (`actions: read` only), lists the nonterminal `mutate.yml` and
  scheduled-entry runs across `requested`, `waiting`, `pending`, `queued` and `in_progress` in
  `scripts/writer-admission.mjs`, and refuses only when a successfully read list names a run
  that is not this dispatch's `dispatched_by` while that run's hold job (`e2e-hold` for
  `mutate.yml`, `hold` for the scheduled entry) is nonterminal. An unreadable list warns and
  admits. The automated dispatches (`deploy-gate`, `deploy-smoke`, `scheduled`) run inside
  the writer's held run and skip the read, so a queued writer cannot refuse them. Only
  `schedule.yml`'s `release-gate` child names its own writer run and is admitted by that one
  comparison; a hand dispatch (`manual`, and a direct `release-gate`) carries no
  `dispatched_by` at all, so it can exempt nothing and is admitted only while no writer holds
  the tuple; do not add a second exemption path.
- Attribution follows the creator, not the address (#217). Every protected credential step
  assumes `beta-e2e-qualification-role` with
  `role-session-name: e2e-${{ github.run_id }}-${{ github.run_attempt }}`, and
  `scripts/execution-guard.mjs` requires the authenticated principal ARN to end
  `/e2e-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`; `tests/support/account.ts` calls the guard
  immediately before `AdminCreateUser`. A pool-address identity is deleted only with a
  qualification-role creation for that exact address **or** a captured manifest subject, plus a
  live `AdminGetUser` identity read-back and a committed exact-reference cleanup; a newer
  creation displaces an older manifest record. `reconcile` accepts only lifecycle artifacts
  bound to the protected `main` `workflow_dispatch` run of the gate entry, reads the
  closed upload set (both `account-budget*.json` manifests, the two cleanup diagnostics) and
  every manifest must name that run and attempt. Both the current gate path and the retired
  pre-#358 path bind, so an artifact from either side of the workflow rename stays
  authoritative; the retired path is a named transitional exception and a follow-up change
  removes it once the 7-day lookback (90 days for the migration dispatch) holds no pre-rename
  artifact. It is bounded to 15 minutes and nine
  artifacts per lookback day, resolves an identity within 24 hours, and fails the run for a
  leftover past that bound. A source failure writes no record and mutates nothing;
  `unattributable_caller`, `unprovable_ownership` and `outside_worker_family` are reported as
  warnings and never fail a run. One `reconcile_lookback_days=90` migration dispatch over the
  artifact retention is permitted before the removals. That dispatch alone carries the
  migration cleanup allowance (#217): when a captured scope's generation 0 and `-retry1` are
  both terminal non-success and one bounded check shows the cleanup families stopped, it may
  start the single `beta-cleanup-<runScope>-<request_sha16>-migration1` generation from the
  unchanged captured envelope; the ordinary reconcile, `full`, `smoke` and the teardown
  cannot request it and keep the two-name rule. Runbook:
  [docs/account-reconcile.md](docs/account-reconcile.md).
- Never delete, or list for deletion, by scope label, prefix or address alone. The only
  deletion selectors are a manifest's captured `{sub, email}` and the Service cleanup's own
  exact-reference request; the object phase deletes only a captured subject's
  `wearable-items/<sub>/`, `base-photos/<sub>/` and `outfit-generations/<sub>/` objects,
  plus the `task-attempts/vto/<vto_id>/` staging objects of that subject's captured
  generations and `vto` task resource ids. A creation by a principal other
  than the E2E qualification role is reported and never deleted.
