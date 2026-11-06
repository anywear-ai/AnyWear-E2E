# Scenario inventory

This inventory is the per-scenario classification the [testing principles and execution
policy](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/system-component-architecture/technical-architecture/devops/test/test_governance.md)
requires in place of tags alone. It records, for every tracked deployed scenario, the
governance class that policy defines, the claim it asserts, the invocation that selects
it, the cleanup contract that disposes of what it creates, and the verdict a red result
carries.

The policy owns the classes, the tag vocabulary, the scenario admission rule and the
evidence levels. This document owns which class each scenario here is, and what its
result means. Where the two could disagree, the policy governs and this document is
wrong.

## Deployed invocations

Each invocation below carries its own trigger and its own verdict. The verdicts are
separated deliberately: a diagnostic result is data about one operation, and it
can neither satisfy nor fail release qualification.

| invocation | Selects | Trigger | Verdict |
| --- | --- | --- | --- |
| `test:smoke` | `@smoke` | The `smoke` operation of the protected `qualify` entry | Diagnostic observation of a narrow deployed path; it does not qualify a release |
| `test:regression` | `@regression` | The `full` operation of the protected `qualify` entry, as the only release-gating selection | Release qualification: a red result fails the gate, and a green result is a required input to the qualification record |
| `test:full-stack` | `@full-stack`, which every cross-repository scenario carries | Explicit operator selection | Broad deployed cross-boundary observation; not a release-gating selection on its own |
| `test` | `@regression` | Local investigation, and the `full` operation's qualification suite step | Identical to `test:regression`: the release gate |
| `test:core` | The explicitly listed offline `scripts/*.test.mjs` contract files and `tests/scenario-declarations.test.mjs` | The automatic Check entry (PR/main) and qualify preflight source preparation | Source contract result; no deployed claim |
| `test:tool-regressions` | The explicitly listed offline retained-tool files | The automatic Check entry's `tool-regressions` job on every PR/main | Tool source result; no deployed claim |
| `test:deferred-sqs` | The explicitly listed prospective SQS protocol files | Manual deferred-owner review | Prototype contract only |

The separation is carried by the signed `operation` field, not by a workflow boundary, a step
or a job. One protected dispatch surface, the `qualify` entry in `beta-qualification.yml`,
carries `full`, `smoke` and `reconcile`. A release consumer accepts a qualification
record only from the `full` operation of a completed-success qualification run: the record
states `operation: full` and is produced only by that operation, so a `smoke` or
`reconcile` run can neither produce nor withhold a record the gate legitimately produced. The
three properties separation keeps are: the record is produced only by `full`; the record binds
the operation dispatched, so its producer is uniquely identifiable; and both this repository's
producer/verifier and the Infra-side executor allow-list check `operation == full`.

Since [#180](https://github.com/git-malu/AnyWear/issues/180) the dispatch surface also names
the trigger and the expectation it was dispatched for: `trigger=deploy-smoke` only runs
`smoke`, `trigger=deploy-qualify` only runs `full` and requires `expected_service_commit`,
`worker_slot_offset=0` and the dispatching run URL, `trigger=release-qualify` only runs `full`
and requires `expected_service_commit`, and `trigger=manual` covers re-runs and diagnostics.
Since [#226](https://github.com/git-malu/AnyWear/issues/226) the deploy chain's `full` uses
`deploy-qualify`, and `release-qualify` has no workflow producer: it stays the value a person
dispatches for a deliberate re-qualification. `full` compares the expected Service commit
with the live `/health` value, writes qualification record v4 from the live observed tuple and
the immutable Service release identity it verified (the release tag, the commit it resolves to
and the four released assets with their published digests), and
the `record` job is the last qualification job: the green `full` run plus its sealed record is
the release decision, with the dispatch event, the run/attempt and the record tuple as the
audit trail. No release-qualification path reads a committed compatibility file; the
qualification path reads `minimum-supported-client.json` as the reviewed Client floor.

`test:list` and `playwright test --list` discover tests without executing them. Discovery
reads configuration only, makes no cloud call and asserts no verdict.

`tests/scenario-declarations.test.mjs` is the offline check that keeps this document and
the spec files agreeing, and it is named on the `test:core` list so the registry states its
membership explicitly rather than by discovery.

Scenario membership is positive: a scenario is in an invocation because it carries that
invocation's tag. A scenario that loses its tag therefore leaves the release-gating
selection, which is why `tests/scenario-declarations.test.mjs` fails the offline check if
a spec stops declaring its invocation, or if this document and `package.json` stop
agreeing about the invocations that exist.

## Scenarios

### `tests/vto.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Virtual try-on @regression @full-stack` |
| Policy class | Full deployed system E2E |
| Tags | `@regression @full-stack` |
| Intent | One single-garment virtual try-on completes end to end against the deployed Client and Service: the garment reaches terminal `ready`, the base photo is accepted, the generation is accepted with exactly one credit debit, reaches terminal `Complete` with a monotonic state version, returns retrievable image bytes, renders in the Client, and takes no second debit |
| Current caller | The `full` operation of the protected `qualify` entry, through the release-gating selection. `test:smoke` does not select it |
| Assertion boundary | Deployed Client UI and Service HTTP API together, with the Service's real auto-tagging and VTO provider calls in the path |
| Actual operation | Leases a synthetic Cognito identity, creates a wardrobe item through the real Client upload flow, uploads one base photo through the Mirror UI, submits one VTO generation with that garment, polls it to terminal `Complete`, retrieves the generated image, and asserts the Client's rendered result |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Current. It is the only end-to-end coverage of the VTO path; the sizing workload that also exercised it is retired by this issue's separate deletion PR |
| Command | `pnpm test:regression`, and `pnpm test` because the suite step runs the same selection |
| Default trigger | The `full` operation of the `qualify` entry, whose selection this scenario is part of |
| Cost | External write and paid provider cost: one leased identity, one uploaded garment object, one uploaded base photo, one auto-tagging task and one VTO generation per attempt. Not separately metered |
| Side effects | Application rows, two uploaded S3 objects, provider spend, and a Cognito identity |
| Evidence level | Qualification, when the complete selection and the pre/post identity checks pass |
| Disposition | Retain |
| Cleanup contract | `DirectTeardown` against the attempt's own `run_scope`/`test_scope`: register before the first business side effect, bind the owner subject, capture the created `wardrobe_item`, `base_photo`, `outfit` and `outfit_generation` as they are created, then finalize with the attempt's own authorization. The scenario reads back exact absence (HTTP 404) for the routed resources and the captured base-photo id's absence from the authenticated `GET /vto/base-photos` list, independently of the product assertion, and a teardown that is not `passed` retains the scope and fails a separate gate. The worker-lease fixture then deletes the Cognito identity and releases the lease |
| Verification rationale | The product assertion stands alone; teardown is reported beside it and never rewrites it. The terminal wait is a bound on the platform's 900 s VTO recovery floor, not a measurement of observed provider latency, so the scenario does not report the platform's own recovery as a product failure. `retries: 0` is configured, because each attempt spends real provider budget and a failed attempt must not be repeated automatically. The terminal `Complete`, the image bytes, the single debit and the Client render can only be proven by a deployed run |
| Red result means | A release-gating product failure in the try-on path, or an environment/provider condition. A `Failed` generation fails immediately instead of waiting out the recovery floor |

### `tests/wardrobe.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Wardrobe Management @regression @full-stack` |
| Policy class | Full deployed system E2E |
| Tags | `@regression @full-stack` |
| Intent | A wardrobe item survives the real auto-tagging pipeline: the upload is confirmed idempotently before and after the terminal state, tagging reaches `ready` with a monotonic state version across a reload and a second browser page, the item can be edited, and deletion removes it without disturbing items that pre-date the run. The batch scenario adds two photos in one action through the Add Item dialog and requires both items to appear in the wardrobe list and both to reach terminal `ready` on the page that is already open, with no reload |
| Current caller | The `full` operation of the protected `qualify` entry, through the release-gating selection. `test:smoke` does not select it |
| Assertion boundary | Deployed Client UI and Service HTTP API together, with the Service's real provider call in the path |
| Actual operation | Leases a synthetic Cognito identity, signs in through the real Client, presigned-uploads one fixture for the idempotency scenario or two fixtures in a single add action for the batch scenario to S3, creates and mutates wardrobe items, and invokes the external VLM |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Current; retired only with a caller and lifecycle decision per the policy's retention rules |
| Command | `pnpm test:regression`, and `pnpm test` because the suite step runs the same selection |
| Default trigger | The `full` operation of the `qualify` entry, whose selection this scenario is part of |
| Cost | External write and paid provider cost: one identity, and either one uploaded object and one tagging task (the idempotency scenario) or two uploaded objects and two tagging tasks (the batch scenario) per attempt. Not separately metered |
| Side effects | Application rows, one or two S3 objects, provider spend, and a Cognito identity |
| Evidence level | Qualification, when the complete selection and the pre/post identity checks pass |
| Disposition | Retain |
| Cleanup contract | `DirectTeardown` against the attempt's own `run_scope`/`test_scope`: register before the first business side effect, bind the owner subject, capture every created `wardrobe_item` as it is confirmed, then finalize with the attempt's own authorization. The scenarios read back exact absence (HTTP 404) for every captured item, independently of the product assertion, and a teardown that is not `passed` retains the scope and fails a separate gate. The worker-lease fixture then deletes the Cognito identity and releases the lease |
| Verification rationale | The product assertion stands alone; teardown is reported beside it and never rewrites it. A red result means a product defect or a provider failure — the scenarios require a terminal `ready`, so a provider failure cannot pass by the processing indicator disappearing. The batch scenario fails unless both rows leave processing on the open page, asserts the list gained exactly the two confirmed items, and counts document loads so a reload cannot stand in for the live delivery. `retries: 0` is configured, because a failed provider attempt must not be repeated automatically and the reconcile operation owns non-terminal resources |
| Red result means | A release-gating product failure. It is not a measurement: no measurement failure can produce it, and it cannot be excused as one |

### `tests/auth-startup.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Session startup @smoke @regression @full-stack` |
| Policy class | Deployed smoke, and Full deployed system E2E in the release selection |
| Tags | `@smoke @regression @full-stack` |
| Intent | The real session starts, is restored across documents, and is destroyed on logout: every authenticated step observes a successful `/users/me` with a bearer header, no transient sign-in heading or login form, and no unexpected navigation to `/login`; an unauthenticated reload and a protected navigation issue no profile request; the persisted Amplify session is cleared before the next document |
| Current caller | `test:smoke` in the `smoke` operation, and the release-gating selection in `full` |
| Assertion boundary | Deployed Client UI and navigation behaviour together with the Service profile endpoint and the real identity provider's session storage |
| Actual operation | Leases a synthetic Cognito identity, signs in through the real Client, navigates, reloads, opens a second page in the same context, signs out, and reads browser storage |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Current |
| Command | `pnpm test:smoke` for the diagnostic, and `pnpm test:regression` for the qualification |
| Default trigger | The `smoke` operation's dispatch, and the `full` operation |
| Cost | External write and paid provider cost bounded by one leased identity and no business resource; no provider spend |
| Side effects | A Cognito identity for the duration of the attempt; in-page observation bindings |
| Evidence level | Deployed smoke for the diagnostic run; Qualification as part of the complete release selection |
| Disposition | Retain |
| Cleanup contract | Declares `declareNoBusinessCleanup` with `teardownResult: 'passed'`, because the attempt creates no business resource. The worker-lease fixture then deletes the captured Cognito identity, reads back its absence, and releases the lease; the declaration replaces the business-cleanup operation, never the identity cleanup. An undeclared attempt is treated as `partial` and retained rather than released |
| Verification rationale | The scenario is the stable critical path the smoke invocation requires, and it is the only `@smoke` scenario that exercises session destruction as well as startup. Its retry budget is the workflow default rather than `0`, so a run that only passes on a retry is a flake to investigate, not evidence that its assertion needed the retry |
| Red result means | A product failure in session startup, restore or logout — or an environment or credential condition. A red smoke run withholds diagnostic confidence but asserts no release verdict by itself; the same red inside the qualification selection fails the release gate |

### `tests/worker-smoke.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Worker account smoke @smoke @regression @full-stack` |
| Policy class | Deployed smoke, and Full deployed system E2E in the release selection |
| Tags | `@smoke @regression @full-stack` |
| Intent | The first profile read of the attempt's own synthetic identity binds that identity, and the signed-in account reaches the dashboard and the wardrobe |
| Current caller | `test:smoke` in the `smoke` operation, and the release-gating selection in `full` |
| Assertion boundary | Deployed Client UI against the Service profile endpoint and the real identity boundary |
| Actual operation | Leases a synthetic Cognito identity, signs in through the real Client, observes the first `GET /users/me`, and navigates to two routes. No upload and no provider call |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Current. It exists to observe the profile binding that issue #129 could only read from CloudWatch |
| Command | `pnpm test:smoke` for the diagnostic, and `pnpm test:regression` for the qualification |
| Default trigger | The `smoke` operation's dispatch, and the `full` operation |
| Cost | External write bounded by one leased identity; no provider spend |
| Side effects | A Cognito identity for the duration of the attempt; a retained trace on failure, by an explicit file-scoped `test.use`, because the failed attempt is the evidence |
| Evidence level | Deployed smoke for the diagnostic run; Qualification as part of the complete release selection |
| Disposition | Retain |
| Cleanup contract | Declares `declareNoBusinessCleanup` with `teardownResult: 'passed'`. The worker-lease fixture deletes the captured Cognito identity, reads back its absence, and releases the lease. Ownership is per attempt: the address is bound to the run scope and slot and is never re-bound |
| Verification rationale | The binding assertion is the reason the scenario exists and it cannot be established at a lower boundary: the defect it guards against appeared only against the deployed identity boundary. The profile status is attached as evidence for a red run |
| Red result means | A product failure in the identity/profile binding contract, or an environment condition. As smoke it withholds diagnostic confidence; inside the release selection it fails the gate |

### `tests/rejection-contract.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Client version rejection contract @regression` |
| Policy class | Full deployed system E2E |
| Tags | `@regression` |
| Intent | The deployed Service enforces its release Client floor on the ordinary request path: a Client below the floor, a headerless request and a malformed header are refused with HTTP 400 `CLIENT_VERSION_UNSUPPORTED` carrying the floor and the parsed header value, a Client at the floor is admitted, and `/health` stays reachable below the floor |
| Current caller | The `full` operation of the protected `qualify` entry, through the release-gating selection. `test:smoke` does not select it |
| Assertion boundary | Deployed Service HTTP contract only: no Client UI, no identity and no provider call |
| Actual operation | Reads `E2E_SERVICE_URL`, reads the live floor from the Service's own `/health`, then issues four unauthenticated probes to a non-exempt business route (`GET /users/me`, which answers 401 once admitted) and a second, below-floor `/health` read |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Current. It replaces the deleted oldest-Client qualification leg (#256): the floor is proven through the rejection contract instead of by building and running an old Client |
| Command | `pnpm test:regression`, and `pnpm test` because the suite step runs the same selection |
| Default trigger | The `full` operation of the `qualify` entry, whose selection this scenario is part of |
| Cost | No identity, no uploaded object and no provider spend; six HTTP reads per attempt |
| Side effects | None: read-only probes against the deployed Service |
| Evidence level | Qualification, when the complete selection and the pre/post identity checks pass |
| Disposition | Retain |
| Cleanup contract | None to perform: the bare Playwright `request` fixture creates no Cognito identity, no Service row and no cloud resource, so the scenario registers no teardown and deletes nothing |
| Verification rationale | The contract is the Service's own middleware behaviour and can only be proven against the deployed floor. The live floor is read in the test body, and a floor below 1 refuses clearly rather than skipping, because `floor - 1` cannot be derived otherwise. `playwright test --list` loads the spec with no E2E environment, so no environment variable is read at module scope |
| Red result means | A release-gating product failure in the Service's Client-version gate: it admits a Client below the floor, refuses one at the floor, misses the exemption, or states a floor the committed manifest does not match. A live floor below 1 is a fail-closed precondition refusal of the deployed configuration, not a product result |

## Retired scenarios

A retired scenario keeps its record here because the policy treats retirement as a caller and
lifecycle decision with a recorded rationale, not as a test-count change. Its source stays in
Git history and its original acceptance evidence stays in the immutable run artifacts.

| Scenario | Retired | Reason | Replacement coverage |
| --- | --- | --- | --- |
| `tests/auth.spec.ts` — Optional public registration, `@regression @full-stack` | [#213](https://github.com/git-malu/AnyWear/issues/213), 2026-10-23 | Beta registration is gated by the exact tester allowlist in the Cognito `PreSignUp` trigger; public self-registration is no longer a product surface, so there is no "registration open" state for the scenario to observe. It never ran: it required `E2E_PUBLIC_REGISTRATION_OPEN=true`, which no workflow set, and that variable is removed with it. | The deployed suite proves a leased allowlisted pool identity signs in and binds its profile through the real identity boundary (`tests/auth-startup.spec.ts`, `tests/worker-smoke.spec.ts`), and `scripts/beta-admission-eligibility.mjs` refuses before any account exists unless every pool address this run can lease is on the exact allowlist. A refusal for an unlisted address is proven by the Service's `PreSignUp` tests against the deployed policy, not by a deployed E2E scenario, because this repository cannot hold an unlisted account in Beta. |

## Admission rule

The [testing policy
admission rule](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/system-component-architecture/technical-architecture/devops/test/test_governance.md)
governs whether a new deployed scenario is admitted, and this document does not restate it:
the policy is its single normative statement, so that a reader has one wording to rely on
rather than two that can drift apart.

What this repository adds is the local procedure a candidate follows once the policy admits
it, because a scenario's verdict follows from the invocation that selects it:

1. Declare the invocation tag on the `test.describe` title, and give the scenario a
   section in this document that applies the policy's inventory-row fields.
   `tests/scenario-declarations.test.mjs` fails the offline check if a spec and this
   document disagree.
2. Tag a release-gating scenario `@regression` and every cross-repository scenario
   `@full-stack`. A deployed scenario is in the release gate only through the
   `@regression` tag the gate's positive `--grep` selection matches.
3. Record the cleanup contract. A scenario that creates no business resource declares that
   in its own attempt record; an absent declaration is not a declaration.
4. Satisfy the offline `pnpm check` gate before the scenario enters any deployed
   invocation.

## Related documents

- [README](../README.md) — commands, execution policy and the CI model
- [AGENTS.md](../AGENTS.md) — repository ownership and stage rules
