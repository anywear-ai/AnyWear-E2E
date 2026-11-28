# AnyWear E2E

System-level tests for a reviewed combination of `AnyWear-Client` and
`AnyWear-Service`. This repository owns only behavior that crosses deployable
boundaries; repository-local tests remain with the Client or Service.

## Test Boundary

- Browser behavior with mocked APIs belongs in `AnyWear-Client`.
- Route and database tests belong in `AnyWear-Service`; CDK and infrastructure contract tests belong in `AnyWear-Infra` after the controlled ownership cutover.
- Browser flows that use both the real Client and Service belong here.
- Real cloud smoke tests belong here and must be explicitly tagged.

## Prerequisites

- Node.js 24
- pnpm 11.18.0
- AWS credentials for the Beta test identity boundary
- Deployed Beta Client and Service endpoints with HTTPS

## Setup

Install dependencies from this repository:

```bash
pnpm install --frozen-lockfile
```

Configure the ignored `.env` from `.env.example` with `E2E_STAGE=beta`,
`E2E_EXTERNAL_SERVERS=true`, the deployed `E2E_CLIENT_URL` and `E2E_SERVICE_URL`,
and Beta's Cognito IDs. The deployment workflows load the identity IDs from
`/anywear/beta/cognito_user_pool_id` and `/anywear/beta/cognito_client_id` in SSM.
Do not commit `.env` or Playwright authentication state.

The deployed gate profile sets two workers, two active-account slots and six new
account leases per run. There is no quarantine budget: a teardown that cannot prove deletion
records the identity `retained` with a reason and a `reconcileBy` bound, and the `reconcile`
operation resolves it inside 24 hours (#217). Beta registration is gated by the exact
tester allowlist, so an attempt may only use a listed address: each Playwright parallel slot
leases one of the eight stable worker-pool addresses
(`e2e-beta-worker-0-chromium@anywear.local` … `e2e-beta-worker-7-chromium@anywear.local`) and
`E2E_WORKER_SLOT_OFFSET` selects the first slot when a slot allocation must avoid one in use.
The identity is provisioned through the protected AWS admin path, deleted during worker
teardown, and its lease is released only after the subject is read back deleted. Ordinary
gate runs never mutate the allowlist and need no real tester mailbox. The retired
synthetic address family and `custom:e2e_bootstrap` marker are no longer written; a historical
captured identity in either worker family stays deletable.
The operations of the gate entry share a non-cancelling Beta account-pool
concurrency group. Each run uploads its account-budget manifest, and the `reconcile`
operation reads the previous seven days of those manifests plus the CloudTrail
`AdminCreateUser` history to clear a leftover without operator input.

## Commands

```bash
pnpm check             # explicit core contracts, lint, typecheck and safe discovery
pnpm test:core         # the registered offline identity/cleanup/deployment-evidence/artifact contracts
pnpm test:tool-regressions # the one retained offline operational-support test file
pnpm test:deferred-sqs  # two source-only SQS prototype test files; manual #58 review
pnpm audit             # fail on high/critical dependency advisories
pnpm test:smoke        # on-demand deployed Beta diagnostic, @smoke only
pnpm test:regression   # the release-gating deployed selection, @regression only
pnpm test:full-stack   # deployed Beta scenarios marked @full-stack
pnpm test              # the release-gating selection: identical to test:regression
pnpm report            # open the latest HTML report
```

Playwright verifies the configured deployed stage endpoints. Browser execution fails
closed unless the stage is Beta or Production, external servers are selected, and both URLs use
HTTPS. Test discovery and source checks do not connect to the deployed environment.

The explicit file lists in [package.json](package.json) are the suite registry. A new
test file needs an ownership/classification decision before it enters an executed
suite; a filename wildcard cannot select a routine or release gate. The
[scenario inventory](docs/scenario-inventory.md) is that classification for the
deployed scenarios: each one's policy class, intent, selecting invocation, evidence
level, cleanup contract and red-result meaning, plus the admission rule a new
scenario must satisfy.

| Command | Owner and trigger | Actual effects and evidence |
| --- | --- | --- |
| `check` / `test:core` | E2E maintainers; the automatic Check entry (PR/main) and the gate preflight source preparation | Offline fixtures, temporary files/Git repositories, lint, typecheck and discovery; no credentials, cloud calls or deployed result |
| `test:tool-regressions` | E2E operational-tool maintainers; the automatic Check entry's `tool-regressions` job on every PR/main | The retained SSE replica-attribution contract: mocked AWS/fetch and temporary files; no AWS/App credentials or live diagnostic proof |
| `test:deferred-sqs` | Repository maintainer under [#58](https://github.com/git-malu/AnyWear/issues/58); manual future-protocol review only | Two offline ARM/ACK/FIRE prototype files; no live transport, trusted AWS identity or receipt proof, and no #54 acceptance claim |
| `test:smoke` | E2E maintainers; the `smoke` operation of the protected gate entry | Real login/dashboard/wardrobe navigation using a bounded worker identity and existing cleanup contract; diagnostic only |
| `test:regression` / `test` | E2E maintainers; the `full` operation's protected Beta gate suite step, or explicit local investigation | The release-gating business scenarios, including identity creation and cleanup and external VLM/provider work; only this operation carries the release gate |
| `test:full-stack` | E2E maintainers; explicit local investigation | Every cross-repository scenario; not a release-gating selection on its own |

The release gate, the smoke diagnostic and automatic leftover expiry are separated by the
signed `operation` field, not by a workflow boundary, a step or a job. One protected
dispatch surface, the gate entry in `beta-e2e.yml`, carries `full`, `smoke` and `reconcile`.
There is no qualification ledger any more (#358): `full`'s own run is the verdict, so the
release decision is that run's `conclusion`, its run name (operation, trigger, expected
Service commit, and the dispatching run URL of a workflow dispatch or the `@<actor>` a hand
dispatch states) and its
`beta-e2e-diagnostics-*` artifact. A `smoke` or
`reconcile` run can therefore neither produce nor withhold the verdict the `full` run
carries, and a reconcile result is never substituted for gate evidence. The
[scenario inventory](docs/scenario-inventory.md) states which verdict each invocation
carries.

`reconcile` runs twice: as a job before every gate suite, so a run starts from a
reconciled environment, and as a daily dispatch of the same protected `workflow_dispatch`
entry by `AnyWear-Infra`'s scheduled entry (`schedule.yml`, `trigger=scheduled`). That entry
only dispatches — the execution guard requires `workflow_dispatch`, so a `schedule` event on
the gate entry would fail closed — and the dispatched run is what joins the
`beta-e2e-account-pool` concurrency group and holds the Beta credential. This repository
keeps no schedule entry of its own: the daily dispatch has one starter, in the writer
repository. Its runbook is [docs/account-reconcile.md](docs/account-reconcile.md).

The registered core files retain account-budget, Cognito cleanup, deployment-evidence,
cleanup operation, wardrobe cleanup, worker cleanup, account reconcile and
deployed-scenario
declaration contracts plus the live-tuple contracts: `deployment-evidence.test.mjs`
(the live identity, the supported-Client floor, the before/after stability check and the
frozen four asset names), `e2e-environment.test.mjs` (the worker identity capture, its
comparison and the product-or-environment verdict), `service-release.test.mjs` (the immutable
Service release identity, the four-asset gate, the five-asset transition and the
no-asset-read rule), and
`entry-census.test.mjs`, which asserts the two-entry face, the one manual dispatch surface,
the credential ordering, the absence of an approval job, the absence of a `record` job and of
the retired dispatch literals, and the single `ENABLE_BETA_MUTATION` name. `test:core` also
owns
`scripts/reconcile-accounts.test.mjs`, which asserts the reconcile diff, the captured address
grammar, the seven-day window and 24-hour bound, the closed `anywear_e2e_account_reconcile`
v1 record and the fail-closed paths offline, without credentials, cloud calls or deployed
reads. The live-tuple contracts protect the observed
deployed identity, the supported-Client floor and the immutable release binding; their
offline assertions remain required by `check` without claiming actual publication or a real
gate run.

The automatic `Check` entry's `tool-regressions` job runs the one retained operational-support
test file, its implementation and shared evidence/source contracts, and the lockfile.
`quality.yml` carried no path
filter, so that job now runs on every check rather than only on its former path set; the
cost is recorded in the PR body for #163. Both jobs have only `contents: read` and no
deployment environment or credential steps. SQS prototypes are excluded from both routine
core and tool checks and retain their [source-only handoff](scripts/beta-sqs-boundary-handoff.md).
The accepted [testing principles](https://github.com/anywear-ai/AnyWear-Meta/blob/main/architecture/system-component-architecture/technical-architecture/devops/test/test_governance.md)
define the classification, cost, evidence, admission and retirement policy this
repository applies.

## Execution Policy

Pull requests do not run cross-repository browser E2E as a required check. The E2E
Check entry runs the explicitly registered core test files,
the credential-free tool regressions, lint, type checking, and Playwright test discovery. Client and Service workflows remain responsible for their
required unit, repository integration, contract, database, and browser integration tests.

The `smoke` operation of the protected gate entry is an on-demand deployed Beta
diagnostic and runs only the small `@smoke` subset. It reads the live deployed tuple,
exercises Beta's real identity boundary, re-observes the tuple before it reports, and
carries no gate verdict. It does not run a local database or mutate the deployment.
Only the `full` operation runs the release-gating suite.

The protected `pnpm test` suite step is reserved for the `full` operation of the gate
entry, and it runs the release-gating selection. Only a passing `full` run against the live
tuple it read before and after the suite gates the deployment that Production
may consume. The
[scenario inventory](docs/scenario-inventory.md) records which scenarios that step's
selection contains; a diagnostic result is not part of it and carries no release
verdict in either direction.

The run keeps its own Playwright JSON report as diagnostics, not as a verdict: the suite
step writes `test-results/beta-e2e-report.json` (the path the job environment declares as
`E2E_REPORT_PATH`) and the `beta-e2e-diagnostics-*` artifact retains it beside the live
identities, the worker-environment captures and the error contexts. Nothing derives a
pass/fail claim from those bytes — the run's `conclusion` is the verdict — and no other
repository downloads the artifact. The
[scenario inventory](docs/scenario-inventory.md) remains the classification contract for the
selection, and `tests/scenario-declarations.test.mjs` keeps the spec titles and the inventory
agreeing about every tag; that parser is now its only consumer.

Test classification is explicit: `@smoke` marks the small, stable critical path for the
on-demand Beta diagnostic; `@regression` marks the scenarios admitted to the
release-gating selection; `@full-stack` marks cross-repository scenarios. The
rejection-contract scenario carries only `@regression`, because it observes the deployed
Service without crossing the Client boundary. A tag selects; the
[scenario inventory](docs/scenario-inventory.md) states the class and the verdict.
Dev verification remains in the Client and Service unit and integration suites.

The non-skipped `worker-smoke.spec.ts` signs in with the existing leased
`workerAccount` fixture and opens Dashboard and Wardrobe. Provisioning, budget,
protected execution, retention and Service/Cognito cleanup controls remain shared with
the deployed selection. `auth.spec.ts` and its `E2E_PUBLIC_REGISTRATION_OPEN` switch are
retired: registration is gated by the Beta tester allowlist in the Cognito `PreSignUp`
trigger, so public self-registration is no longer a product surface for the scenario to
observe. The [scenario inventory](docs/scenario-inventory.md) records the retirement and its
replacement coverage.

The manual `Beta E2E gate` entry (`beta-e2e.yml`) is the single protected dispatch
surface, with the required operation menu `full` (release gate), `smoke` (diagnostic) and
`reconcile` (automatic leftover expiry). Its
dispatch also carries
`expected_service_commit` and `expected_client_commit` (`full` only), `trigger` (`manual`,
`deploy-smoke` for the deployment smoke hook, `deploy-gate` for the deploy chain's
gate, `release-gate` for a deliberate human re-gate, `scheduled` for the
daily reconcile dispatch from `AnyWear-Infra`'s scheduled entry) and
`dispatched_by` (the HTTPS URL of the run that dispatched the gate, empty for a hand dispatch,
whose run name states `@<actor>` instead, and accepted only from a run an app identity created),
and the credential-free
preflight validates that combination before any credential job — a value on `manual`, a
non-HTTPS value, or a value from a run a person created — like a retired trigger
spelling — is refused there by name. For an operator
dispatch
(`trigger=manual`, all three operations, or `trigger=release-gate`) the preflight also
performs the outbound writer admission (#344): it lists the nonterminal `AnyWear-Infra` writer
runs (`mutate.yml` and the scheduled entry) through a read-only `AnyWear-Infra` App token and
refuses only when a foreign run's hold job (`e2e-hold` or `hold`) is still nonterminal,
failing open with a warning when a list cannot be read; only a `release-gate` gate that
`AnyWear-Infra`'s scheduled entry dispatched names its own writer run in `dispatched_by` and is
admitted by that one comparison, while a hand dispatch carries no value and so can exempt no
holding writer. The automated dispatches
(`deploy-gate`, `deploy-smoke`, `scheduled`) are started by the writer inside its held run
and skip the read, so they cannot be refused by a queued writer. Each run is named
`Beta E2E gate: <operation> · <trigger> · <expected Service commit or -> · by <dispatched_by or @actor>`
(exactly the shape `AnyWear-Meta` ADR-0027 §4 pins);
that name is the cross-repository read contract (`AnyWear-Infra` filters its run list by the
`Beta E2E gate: full` prefix and reads the run's URL back from its own dispatch). The `full` operation is the
production-readiness gate for an already-deployed Beta environment. It reads the live Client
`build-metadata.json` and Service `/health`, compares them with the dispatch expectation,
verifies that the live Service commit resolves to an immutable Service release, runs the
release-gating deployed selection (including the
rejection-contract leg that proves the deployed Service refuses a Client below the reviewed
floor), and re-reads both live identities, requiring an identical tuple. A green `full` run
is the complete
release decision; there is no separate approval action or approval Environment, no sealed
record to verify, and the audit
trail is the `workflow_dispatch` event (actor and time) plus the run object and its
`beta-e2e-diagnostics-*` artifact. A failed, mismatched, or changed deployment, or a worker task
definition that changed during the suite, cannot make that run green. The suite runs and the
diagnostics artifact carry GitHub's artifact retention, subject to its configured
repository or organization ceiling; nothing outside this run depends on the artifact, so an
expired artifact loses reader convenience and no gate capability. Persistent
S3 evidence storage will be reconsidered only if long-term audit or rollback requirements arise.

## Runtime Reliability Evidence

### Tester Admission Verification (Historical)

The one-time deployed synthetic allowlist acceptance and recovery workflows were
retired after the feature's acceptance completed. Their historical evidence, including
the owner's real email-code and normal-login confirmation, is recorded in
[AnyWear issue #59](https://github.com/git-malu/AnyWear/issues/59). The ordinary
`full` and `smoke` operations of the gate entry do not mutate tester policy or claim to
verify a real tester mailbox. Future changes to admission behavior should define only the
focused tests needed for that change; the retired deployed harness is not a standing release gate.

The wardrobe scenario verifies repeated `Idempotency-Key` confirmation before and after
completion, recovery after a browser reload, consistent terminal state in two browser
pages, and a monotonic state version. It requires a successful `ready` state, so a
provider failure cannot pass merely because the processing indicator disappears.

Expanded Beta and Production reliability drills are deferred to
[AnyWear issue #58](https://github.com/git-malu/AnyWear/issues/58); they are not current
personal closed-Beta acceptance gates and have not been passed. The manual runtime-drill
and dedicated runtime-recovery workflows were retired under
[issue #79](https://github.com/git-malu/AnyWear/issues/79). Historical Actions runs and
artifacts remain available as evidence of their actual outcomes.

The retained manual runtime instrumentation ladder was retired under
[#213](https://github.com/git-malu/AnyWear/issues/213), together with the admission mode it
operated: `runtime-drill`, `runtime-window-controls`, `nonpaid-runtime-controls`,
`runtime-one-shot`, `runtime-no-start`, `runtime-identity-creation`, `beta-runtime-adapter`
and their exclusive support modules, fixtures and tests. Their admission-window half had no
subject once Beta registration became the only admission decision, and their fault-injection
half had no workflow caller since #79; the testing policy's retirement rule requires an
ongoing owner and trigger for retained tooling, and Git history plus the original run
artifacts preserve their provenance. The credential-free `sse-replica-attribution` contract
is the one retained operational-support regression. Any future expanded-release work must
first select the smallest required risk-based scope in issue #58; the historical
fault-injection design is not an instruction to rerun its full matrix or rebuild a separate
control platform.

The deployed Client must serve the exact reviewed build at an HTTPS URL, support its
browser routes, and expose `/build-metadata.json`. The Client-owned Beta workflow publishes
the static build to the Beta PlatformStack's CloudFront distribution. The gate reads that
endpoint from the workflow constants `E2E_CLIENT_URL` / `E2E_SERVICE_URL` in
`beta-e2e.yml` (beside `AWS_ACCOUNT_ID` / `AWS_REGION`), so an operator does **not**
set `BETA_CLIENT_URL` or edit the `beta` environment for a gate run; those
environment-scoped copies are unused by this workflow. If a distribution is recreated, the two
workflow constants move with it in one reviewed change.

## CI Model

The gate reads the live deployed tuple; the committed compatibility pin, its tools and
its two documents are **deleted** (#192), and no gate path reads a committed
deployment file: `beta-e2e.yml`, `pnpm check`, `test:core` and `test:list` were
already pin-free. The former measurement workload was the last executed reader of the pin,
and it was deleted with the sizing apparatus. The last expected-tuple readers were the manual
drill and recovery CLIs, retired under
[#213](https://github.com/git-malu/AnyWear/issues/213), so no tracked command reads a
deployed tuple and no new reader of a committed deployment file may be added.

The live tuple is:

- the Client at `E2E_CLIENT_URL`: `/build-metadata.json` with `schema_version: 3`,
  `component: 'AnyWear-Client'`, `source_commit`, `client_version` and `built_at`;
- the Service at `E2E_SERVICE_URL`: `/health` with `status: 'ok'`, `service_commit`,
  `image_digest` and `minimum_client_version`.

#358 removed the third member: the repository's own full-resource platform hash snapshot
(the platform hash snapshot, #228) existed to seal a run's result into an immutable ledger. The
platform's stability across the suite is now carried by the two live identity reads and by
the retained writer/starter mutex, so no committed stage-parameter list or observation region
list is read on the live path.

The two endpoints are workflow constants in `beta-e2e.yml` (the same values as the
`beta` environment's `BETA_CLIENT_URL`/`BETA_SERVICE_URL`). They are constants because the
environment-free `preflight` must read the live tuple before any credential job, and a job
without `environment: beta` cannot resolve environment-scoped variables. If a distribution is
ever recreated, the constants move with it in one reviewed change.

The only committed input on the live path is
[`minimum-supported-client.json`](minimum-supported-client.json): `{ "version": 13 }`. It
states the reviewed Client floor version only — the Client commit it used to name was read
by the deleted oldest-Client leg. Its `version` must equal the live Service's
`minimum_client_version`, and a disagreement is refused — never resolved by picking the
oldest version — with a message that says to sync the file. Every direct Service request in
the deployed suite presents that version in the `X-AnyWear-Client-Version` header, because
at a floor above 0 the Service refuses a headerless request; the new
`tests/rejection-contract.spec.ts` scenario proves the rejection contract against the
deployed Service.

`AnyWear-Service`'s deploy chain verifies its own sealed artifact before deploying it; E2E
independently verifies that the live Service commit resolves to an immutable
`service-artifacts-<service sha>` GitHub release whose tag resolves to that same commit and
whose four expected assets — `pre-sign-up.zip`, `post-confirmation.zip`, `runtime-policy.json`
and `service-schema.json` — are each uploaded with a non-empty size and a published
`sha256` digest (`scripts/service-release.mjs`). The gate reads the release and the tag ref
through the GitHub API and downloads no release asset, so the image digest stays in the live
`/health` identity and is no longer compared with a release field. No AWS credential is
requested before that read succeeds. A pre-change five-asset release, which also carries the
retired `service-artifacts.json` manifest, stays gateable during the 5→4 transition: the
gate requires the four names it consumes and ignores the extra asset, and it never reads or
parses the manifest.

## Gate verdict

There is no qualification ledger. #358 deleted the v4 record, its producer and verifier, the
`record` job and the two artifacts a release consumer used to download. What remains is the
`full` run itself:

| Question the old record answered | Where the answer lives now |
| --- | --- |
| What was expected, and from which source? | the run name's third segment (`-` when a manual `full` supplied none) and the dispatch event |
| Which Client, Service and E2E revisions ran? | the `preflight` step summary and the two live identity reads; the E2E revision is the run's `head_sha` |
| Which immutable Service release was verified? | the `preflight` step summary's release line, read by `scripts/service-release.mjs` |
| Did the deployment change during the suite? | `Confirm deployed identities remained stable` fails the run; the worker-environment verdict attributes a red suite |
| Which tests ran, and how? | `beta-e2e-diagnostics-*` carries `test-results/beta-e2e-report.json` with the raw results and the error contexts |
| Was the run green? | the run's `conclusion` — the only verdict |

`full` gates the tuple from its own reads, with no cross-run comparison: it collects the live
Client and Service identities before the suite, runs the release-gating selection, and reads
the same observation again after the suite, refusing any difference. The two reads must be
identical. The consumer-side drift gate that compared the deploy-smoke observation of the same
release with this run's observation was removed (#259), because decision D2(c) of
[#226](https://github.com/git-malu/AnyWear/issues/226) dropped the precondition it enforced;
`smoke` keeps its own revision evidence for the operator.

The release decision is that green `full` run: there is no `record` job, no approval job, no
approval Environment and no `Approved`/`Rejected` state. The `workflow_dispatch` event (actor
and time) and the `full` run object are the audit trail. A failed run produces nothing to
release, and nothing outside this repository keeps a copy of its verdict.

## Private retrieval and observation

Private retrieval uses separate GitHub App readers. The immutable Service release identity is
read with a token scoped to `AnyWear-Service` (Contents/Actions read): the gate reads the
release and its tag ref only and downloads no release asset. `scripts/github-read.mjs` owns the
`gh` seam and the per-repository token scoping that renames the one allowed reader to
`GH_TOKEN` and removes every other reader token. The E2E deployment-record download chain
(`trusted-deployment-inputs.mjs`), the cross-repository Infra observer checkout
(`infra-source.mjs`), the recovery owner-artifact reader and the cleanup diagnostic reader
(`account-recovery-inputs.mjs`, `beta-cleanup-diagnostic.mjs`) are deleted.

AWS credentials are assumed after the live-tuple gate. The dedicated
`beta-e2e-qualification-role` (the name is frozen by #358) still reads what the surviving
operations need: named SSM parameters (the Cognito user pool and client ids, the tester
allowlist), the Cognito admin plane for account provisioning and deletion, the wardrobe
bucket's `s3:GetObject`, the `api`/`worker` log groups, the auto-tagging DLQ receive/visibility
pair, CloudTrail `LookupEvents` for account attribution, and `cloudformation
describe-stacks` for `AnyWearRuntimeStack-beta`'s cleanup capability version output
(`scripts/cleanup-capability.mjs`). #358 removed the full-resource platform hash snapshot, so
the seven discovery families that existed only for it — list/describe of stacks, templates,
Lambdas, queues and CloudFront distributions — have no reader here any more. The matching IAM
narrowing is `AnyWear-Infra`'s source change and takes effect at the next authorized
`deploy-platform`, not with this repository's merge, so the live role stays wider than that
source until that deployment runs.

## Ordinary E2E execution

The former offline cross-repository builder gate was retired with the `selection`
contract. The Service deploy chain verifies its own sealed artifact before it
deploys, and the gate independently verifies that the live Service commit resolves to
an immutable `service-artifacts-<sha>` release whose tag resolves to that commit and whose
four expected assets carry published digests (`scripts/service-release.mjs`), without
executing the retired Service parser, reading a manifest or downloading a release asset.

Verify that Infra/Client/legacy writers have ceased before allocating an E2E
gate window. Repository-local concurrency
does not serialize those other repositories. Keep `ENABLE_BETA_MUTATION` unset or
`false` during preparation. For an authorized protected Beta dispatch, set or verify:

| Variable | Required value |
| --- | --- |
| `ENABLE_BETA_MUTATION` | `true` only after role/access/cutover gates pass; the single stage switch shared by the system |
| `E2E_CLEANUP_SERVICE_SOURCE_SHA` | Full reviewed deployed Service source SHA, derived by each job from its own deployment evidence and never configured |
| `E2E_CLEANUP_SERVICE_IMAGE_DIGEST` | Reviewed deployed Service image digest, derived by each job from its own deployment evidence and never configured |
| `E2E_WORKER_SLOT_OFFSET` | Allocated first slot, integer 0 through 7; the selected workers must fit within slots 0 through 7 |
| `AWS_ACCOUNT_ID`, `AWS_REGION` | `650880818323`, `ap-east-1` |

The cleanup capability version is not configured here. `scripts/cleanup-capability.mjs resolve`
reads the version ARN `AnyWearRuntimeStack-beta` publishes as a stack output at run time, pins it
for the job and appends the value and the output it came from to the run's step summary; the
`full`, `smoke` and `reconcile` entries all take the value from that one read, and each re-checks
it against the deployment before the first account or deletion and again before every new cleanup
execution. The former `BETA_CLEANUP_STATE_MACHINE_VERSION_ARN` repository variable is retired.

The cleanup Service source and image are not configuration. `preflight` reads the deployed
Service `/health` (`service_commit` and `image_digest`) and proves that the commit names exactly
one published, immutable `service-artifacts-<sha>` release whose tag resolves to that commit and
whose four assets carry published `sha256:` digests (`scripts/cleanup-source.mjs verify`); a
`reconcile` dispatch, which is outside the live-identity gate, runs that proof on its own. The
`preflight` job publishes the proved pair as `reviewed_service_commit` and
`reviewed_service_image_digest` for `full` and `smoke` only, and each of those jobs derives
`E2E_CLEANUP_SERVICE_SOURCE_SHA` and `E2E_CLEANUP_SERVICE_IMAGE_DIGEST` from its own deployment
evidence and compares the two pairs before the first account or deletion
(`scripts/cleanup-source.mjs gate`). A scheduled `reconcile` pins no pair, so a deployment replaced
while it runs does not refuse the reconciliation; an in-suite `reconcile` inherits the
gate run's pin and compares. Every refusal is one sentence carrying `unset`, `malformed`,
`absent` or `drift`, both values, the operation, and the grammar that applied —
`^[0-9a-f]{40}$` for the commit and `^sha256:[0-9a-f]{64}$` for the digest. The former
`E2E_CLEANUP_SERVICE_SHA` repository variable is retired: no workflow, script or test reads it, and
`pnpm check` refuses its reintroduction.

The protected Beta environment, exact repository/owner IDs, main workflow dispatch,
the single gate entry and the explicitly stated `operation` establish source
identity. `execution-guard.mjs --source-only` checks that identity before credentials,
including that the operation is one of `full`, `smoke` or `reconcile` and that
the workflow ref is the entry the operation map names. After
assuming the dedicated `beta-e2e-qualification-role`, each operation job captures fresh
STS account/principal values and checks the exact account, role and region. Those
values are supplied by the workflow, not dispatch inputs. The default guard requires
that captured principal before observations, suite and mutation boundaries, including
Cognito deletion after a fixed cleanup operation wait. Missing or mismatched identity
retains the cleanup manifest, and the `reconcile` operation resolves it inside its bound.
`full` has a 90-minute job bound; `smoke` has a 60-minute bound;
`reconcile` has a 15-minute bound and stops starting work after 720 seconds so the record
is still written. All three share
the `beta-e2e-account-pool` concurrency group with cancellation disabled. Verify
all local/Actions/CFN/ECS/nested Service jobs have ceased before handing the
environment to another writer; timeout alone never releases it.

The Infra-owned versioned Step Functions cleanup capability invokes Service's fixed
application-data task. The ordinary gate cleanup and the `reconcile` operation
submit the same strict normal-mode envelope and enter the same resume/verify/
retry rule. The Service cleanup deletes the captured users' objects under
`wearable-items/<sub>/`, `base-photos/<sub>/` and `outfit-generations/<sub>/`, plus the
`task-attempts/vto/<vto_id>/` staging objects of their captured generations, reads absence
back by listing, and only then
deletes their PostgreSQL rows; it reports `objects` and `objectsMissing` in its committed result; `reconcile` requires both counters before it
deletes an identity, so a Service release that cannot prove the object phase leaves the
identity retained. A retained record whose captured subject and worker-family address (a stable
pool row, or a historical run-scoped address of that run) are intact is
resolved by the same reviewed cleanup — capability tuple, Service commit proof, absence
readback and ledger `deleted` with the original reason preserved — while a record whose
ownership is unproven is reported and never deleted. The
reconcile path is in [docs/account-reconcile.md](docs/account-reconcile.md). The account artifact preserves the capability execution,
source/image binding and exact cleanup request before any Cognito deletion, including
when later cleanup fails. Legacy `service-cleanup-run.json` records remain accepted as
historical operation input; new runs use `service-cleanup-operation.json`. E2E does not
check out a mutable cleanup helper or pass the Lifecycle/Cleanup task roles. Service's
surviving operator must select the dedicated `CleanupTaskRoleArn` with no fallback to
the old Lifecycle role. Its legacy image still needs narrowly reviewed data-cleanup
permissions for the two Beta DLQs, while tester-allowlist controls remain outside that role.
None of these operations deploy CDK, change the tester allowlist, or revive the retired
runtime drill.

Operation evidence uses schema 4 and records initiation, observed terminal state,
a separate `proof_status`, and the `proof_origin` that produced a verified proof. Step
Functions success alone does not permit identity deletion: E2E first rechecks the exact
execution input/version, both stopped ECS tasks, their immutable definitions,
image/source, fixed command and log paths, and the unique
`ANYWEAR_BETA_CLEANUP_RESULT=` Service completion marker. When a stopped task has aged
out of ECS's one-hour retention, the same proof is read once from that cleanup task's own
completion marker in its execution-output stream; when that marker has expired as well, a
previously verified operation record for the exact execution, uploaded with an earlier
run's artifact, stands in its place with its envelope, request, execution, instance, task
identities and committed counters all re-proved. A cleanup with none of those surviving
refuses at `task_proof` and the identity stays retained. The marker's envelope hash binds
the actual ECS command bytes, while its request hash binds the original captured worker
JSON. Requests exceeding ECS's 8192-byte serialized override bound are rejected before
starting an execution.

DLQ counters may include messages that the fixed Service implementation proves
belong to deleted terminal tasks. E2E validates nonnegative counters and refuses an
unassigned diagnostic `known_message`; those counters alone do not establish
per-message ownership. Source/image-bound Service validation and live unrelated
data/message preservation evidence provide that acceptance boundary.

The automatic reconcile and the ordinary gate cleanup
share one rule. For the
exact captured run scope, the entry point resolves one deterministic execution name,
`beta-cleanup-<runScope>-<requestHash16>`; an absent generation 0 is started under the
current version and normal envelope. It resumes that execution while it is `RUNNING`,
verifies the committed result when it has `SUCCEEDED`, and only when it is terminal
non-success performs the bounded predecessor check: the execution `describe` that
established the terminal state, then one inventory pass over the three bounded cleanup
task families (`beta-anywear-cleanup`, `beta-anywear-cleanup-verify` and
`beta-anywear-cleanup-acceptance`) asking ECS only for `RUNNING`-desired tasks. The
inventory never reads `lastStatus`: any returned task refuses the next start, and an
inventory that cannot complete refuses as well. A task still draining with a `STOPPED`
desired status is therefore outside this single-inventory check. Otherwise the dispatch
starts `beta-cleanup-<runScope>-<requestHash16>-retry1` once, or resumes or verifies that
name when it already exists.

The one 90-day migration reconcile carries an explicit migration allowance that no other
dispatch has (#217). Only when both ordinary generations already exist and are terminal
non-success, and one bounded predecessor check shows the cleanup families stopped, it starts
`beta-cleanup-<runScope>-<requestHash16>-migration1` once. The migration name is derived from
the same envelope, so the captured `runScope`, the request hash and the cleanup operation
identity are preserved rather than re-scoped. That name is resumed when it is `RUNNING` and
verified when it is `SUCCEEDED`; when it is itself terminal non-success the dispatch refuses
and starts nothing else, so a scope never reaches a fourth execution. The allowance never
manufactures its own precondition: a migration dispatch that finds the retry absent refuses
instead of starting it, while generation 0 keeps its ordinary behavior so a scope with no
execution is still cleaned. The ordinary reconcile, `full`, `smoke` and the gate
teardown leave the allowance unset and keep the two-name rule above.

The original-owner-evidence read and its validators are removed with the manual `recover`
operation (#217). Nothing sets `E2E_CLEANUP_ORIGINAL_EVIDENCE_PATH` any more, so the dispatch
reads only its own current captured request, and the cleanup regression proves a supplied path
is ignored. The current run scope, the ordinary teardown and `reconcile` are the only producers.

A captured run scope therefore carries at most two ordinary executions: the base deterministic
name and one `-retry1` (plus the migration-only `-migration1` name described above, which only
the 90-day migration reconcile may start). A retry newly started by this rule uses the current
version and normal envelope. An existing retry that binds the current pair is resumed when it
is `RUNNING` and verified when it is `SUCCEEDED`, under that envelope and version. A recorded
retry that is already terminal non-success refuses the same way: it records
`refusal_phase`/`refusal_category`, starts no third execution and
deletes no identity. An execution that binds neither — for example a retry started
under an intermediate reviewed tuple — is refused fail-closed: the
dispatch records `refusal_phase`/`refusal_category`, starts no third execution and deletes
no identity. The retry is the only retry: there is no attempt number, attempt input,
predecessor artifact or execution-history hash, and no second cessation sample.

Every dispatch always emits `operation_mode: 'normal'` and no `recovery_attempt`; the
envelope keeps the optional attempt field only because the Service validates it.
`validateCommitted` still compares both echoed fields, so a Service that echoes an
attempt is refused. Partial Cognito reconciliation never shrinks the canonical cleanup
request. Shared account-pool
concurrency does not establish a cross-repository writer allocation; that remains an
operational preflight gate.

The `full` and `smoke` operations accept `worker_slot_offset` (default `0`) for
allocating the run's two worker slots; for example `2` selects slots 2 and 3 without
reusing slots 0 and 1. The admission pre-flight uses the same offset: it requires every
pool address this run can lease, and only those, to be on the tester allowlist before the
first account exists. `reconcile` uses no slot: it resolves the exact captured
emails/subjects a retained manifest records. An offset does
not establish cessation of other jobs or authorize use of occupied slots: verify
outstanding executions, tasks and manifests are reconciled before reuse.

## Environment change during a suite

A gate run can span a deployment rotation, and the run now says so instead of
reporting the platform's recovery as a product failure. The workflow records the
identity of the worker(s) serving Beta immediately before and immediately after the
suite - the worker service's task ARN set and the task definition those tasks run - and
compares them. `scripts/e2e-environment.mjs` reads that identity from the
workflow, which holds the scoped AWS credentials; the Playwright spec reads no AWS and
decides no environment change, so the module owns the verdict
shape and the comparison rules while the spec keeps recording what it observed.

- `.e2e-inputs/beta-environment-before.json` and
  `.e2e-inputs/beta-environment-after.json` are the two captures; the
  after-capture runs even when the suite failed.
- `test-results/beta-environment-verdict.json` is the verdict: `environment-changed`,
  `unchanged`, or `unavailable` when an input is missing or malformed, with
  `product_failure_asserted` and the exact worker task ARNs that appeared and
  disappeared.

A verdict of `environment-changed` **replaces the product-failure report**: the run
states that the platform was redeployed under the suite and that no product failure is
asserted. It does not turn the run green. When the suite failed, the job still ends
non-success. The converse is equally strict: a
case that fails while the worker identity is unchanged is still a product failure, and a
check that could not be established is reported as `unavailable` so the failure keeps
standing instead of being explained away. An `incomplete` suite - one that was cancelled
or ended by the job timeout and so neither passed nor produced a product failure -
asserts no product failure either, because none was established; its red run comes from
the cancelled step. The verdict is a conservative label rather than per-case causation -
the captures bracket the suite and cannot say when a rotation happened relative to the
interrupted case - so a genuine product failure that coincides with a worker replacement
is reported as an environment change and must be re-adjudicated by a re-run.

The verdict is attribution evidence, not a gate of its own (#358). Its former blocking
half refused a verdict for a passing suite measured across two worker task
definitions; with no record there is no consumer for that refusal. The window it covered is
now closed by two retained controls: the writer/starter mutex keeps a deployment holding the
tuple while its gate runs, and `Confirm deployed identities remained stable` fails the run
when the Client or Service identity moved. A rotation of worker task ARNs on one unchanged
definition is still recorded and never blocks, and the reason line says which of the two
happened: an added-only change reads as a scale-out, not as workers being replaced. Run
[38879938899](https://github.com/git-malu/AnyWear-E2E/actions/runs/38879938899) is that
rotation - its suite passed, the verdict recorded 2 worker task(s) appeared and none removed
with the task definition unchanged. A redeployment that replaces the deployed tuple is
caught separately by `Confirm deployed identities remained stable`.

The capture is unconditional for every gate run, because a deployment change
invalidates the run's own evidence of any kind.
