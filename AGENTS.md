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
  selection, and the protected qualification step runs it as the release gate
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
- Qualification reads the live deployed tuple. The Client identifies itself through
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
- For release qualification, record the full intended Client, Service, and E2E
  SHAs and verify that the target environment serves those Client and Service
  revisions through Client `build-metadata.json` and Service `/health`. Recheck
  both identities, the platform observation and the Service image digest after the suite;
  a mismatch or deployment change cannot qualify the release. Preserve the observed runtime
  revisions, image digest, environment endpoints, and qualification run/artifact
  links together with the intended SHAs in the release evidence. Checking out
  pinned source alone does not prove the deployed system ran it.
- Qualification reads the live Service release identity, never a manifest. The live Service
  commit must resolve to an immutable `service-artifacts-<service sha>` GitHub release whose
  tag resolves to that commit and whose four expected assets (`pre-sign-up.zip`,
  `post-confirmation.zip`, `runtime-policy.json`, `service-schema.json`) are each uploaded
  with a non-empty size and a published `sha256:<hex>` digest. The gate reads only the
  release and the tag ref through the GitHub API and downloads zero release asset bytes. An
  extra asset is ignored, so a pre-change five-asset release (the four plus the retired
  `service-artifacts.json`) stays qualifiable for rollback; its manifest is never read or
  parsed. The image digest stays in the live `/health` identity and is not compared with a
  release field.
- Qualification record schema v4 is self-contained: `expected`, `revisions`
  (`e2e`/`client`/`service`, never `infra`), `service_artifacts`
  (`{repository, release_id, tag, target_commit, assets}` where `tag` is
  `service-artifacts-<service sha>`, `target_commit` is the commit the tag resolved to, and
  `assets` is exactly the four released names each with `{size, digest}`), the two
  `observations`, `test`, `workflow` (including `trigger` and `dispatched_by`) and
  `integrity`. It has no `compatibility` and no `deployment` member, and the v4 verifier
  refuses a v2/v3 record. The independent platform observation is this repository's own
  authenticated read (`scripts/infra-observation.mjs`), which discovers the deployed
  surface through AWS public list/describe APIs and hashes it with RFC 8785 canonical
  JSON and sha256 — not a cross-repository Infra checkout. No committed stage-parameter
  list remains; the committed surface is the stage path, the name prefixes, the account
  and the two observation regions (`scripts/platform-entrypoints.mjs`).
- The consumer-side drift gate is removed (#259): `full` no longer compares the deploy-smoke
  observation with the qualification observation, and the gate script, the strict ZIP reader
  it alone used and both their tests are deleted. `full` qualifies the tuple from its own
  before-observation, the release-gating suite and the after-observation, and the
  credential-free `record` job verifies only the v4 record. The removal follows decision
  D2(c) of [#226](https://github.com/git-malu/AnyWear/issues/226) (2026-11-02), which
  dropped the deploy-smoke precondition. `smoke` remains the on-demand diagnostic and still
  uploads its own revision evidence, which now has no machine consumer, and `deploy-smoke`
  remains a live `trigger` value.
- The compatibility pin is **deleted** (#192): the committed pin file, `docs/compatibility-pin.md`,
  `docs/compatibility-v3.md` and the pin tools (`validate-compatibility-pin.mjs`,
  `migrate-compatibility.mjs`, `check-compatibility.mjs`) were removed, and no
  **release-qualification** path read them (`beta-qualification.yml`, `pnpm check`, `test:core`
  and `test:list` were pin-free). The last manual expected-tuple readers — the
  `runtime-drill.mjs` and `runtime-recovery-artifact.mjs` CLIs — were retired with the runtime
  instrumentation ladder under #213, so no tracked command reads a qualification tuple or a
  committed deployment file, no workflow, `pnpm check`, `test:core` or `test:list` path is
  affected, and `minimum-supported-client.json` remains the only committed input on the live
  path.
- Beta registration is gated by the exact tester allowlist in the Cognito `PreSignUp`
  trigger (#213). The deployed scenarios lease one of the eight stable worker-pool addresses
  (`e2e-beta-worker-0-chromium@anywear.local` … `-7-`, offset by `E2E_WORKER_SLOT_OFFSET`) and
  never mint an address; the qualification pre-flight refuses before the first account exists
  unless every pool address the run can lease is on the allowlist. Do not add a synthetic
  address family, an `E2E_PUBLIC_REGISTRATION_OPEN` switch, or any reader/writer of
  `custom:e2e_bootstrap` back.
- The release decision is the green `full` run plus the sealed record that `record` verifies
  and attaches. There is no separate approval job or approval Environment: the audit trail is
  the `qualify` `workflow_dispatch` event (actor and time), the E2E `full` run/attempt and the
  record tuple. Do not add an approval Environment or approval/`Approved`/`Rejected` states.
- The single protected `qualify` entry in `beta-qualification.yml` owns the deployed
  operations for beta and later stages; it must not target dev. Separation between
  qualification, the smoke diagnostic and automatic leftover expiry now
  lives in the
  signed `operation` field, not in a workflow-file boundary: `qualification-record.json` is
  produced only by the `full` operation, the record binds the operation that was dispatched,
  and both this repository's producer/verifier and the Infra-side executor allow-list require
  `operation: full`. A `smoke` or `reconcile` run therefore can neither produce nor
  withhold the record the release gate produced, and a reconcile result is
  never substituted for qualification evidence.
- Leftover data is bounded by time, not quarantined (#217). A teardown that cannot prove
  deletion records its identity `retained` with a `retainedReason` and a `reconcileBy` bound
  (24 hours after the account record's own `createdAt`), fails its own run exactly as before,
  and is resolved by the `reconcile` operation: a job before every `qualify` suite, and a
  daily dispatch of the same protected `workflow_dispatch` entry from `reconcile-schedule.yml`
  (`trigger=scheduled`). There is no quarantine budget and no `quarantined` account status; a
  historical manifest recording `quarantined` reads as `retained`. `retained` consumes no
  active-account budget, while its own address stays out of the pool until the identity is
  deleted; `maxNewAccountsPerRun` still counts every attempt.
- Attribution follows the creator, not the address (#217). Every protected credential step
  assumes `beta-e2e-qualification-role` with
  `role-session-name: e2e-${{ github.run_id }}-${{ github.run_attempt }}`, and
  `scripts/execution-guard.mjs` requires the authenticated principal ARN to end
  `/e2e-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`; `tests/support/account.ts` calls the guard
  immediately before `AdminCreateUser`. A pool-address identity is deleted only with a
  qualification-role creation for that exact address **or** a captured manifest subject, plus a
  live `AdminGetUser` identity read-back and a committed exact-reference cleanup; a newer
  creation displaces an older manifest record. `reconcile` accepts only lifecycle artifacts
  bound to the protected `main` `workflow_dispatch` run of `beta-qualification.yml`, reads the
  closed upload set (both `account-budget*.json` manifests, the two cleanup diagnostics) and
  every manifest must name that run and attempt. It is bounded to 15 minutes and nine
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
