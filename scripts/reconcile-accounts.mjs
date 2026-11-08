import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify, isDeepStrictEqual } from 'node:util';
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { ghApi } from './github-read.mjs';
import { assertE2EExecution } from './execution-guard.mjs';
import { byteHash, parseStrictJson, repositories } from './evidence-contract.mjs';
import { runCleanupOperation } from '../tests/support/service-cleanup-operation.ts';
import { isCapturedBetaWorkerEmail, STABLE_WORKER_EMAIL_PATTERN } from '../tests/support/beta-address.ts';

// #217: the reconciler that replaced the manual `recover` exit.
//
// Attribution follows the creator, not the address. A new attempt leases one of the eight
// stable pool rows, so the address alone never names the run that created the identity now
// bound to it. The creating run is named twice, both by AWS and by the run itself:
//   - every protected credential step assumes `beta-e2e-qualification-role` with
//     `role-session-name: e2e-<run>-<attempt>`, so the `AdminCreateUser` CloudTrail event
//     names the creating run before the identity exists;
//   - the run's `beta-account-lifecycle-<run>-<attempt>` artifact names the address and its
//     captured subject.
// A teardown that cannot prove deletion records the identity `retained`; this operation finds
// it again, replays the same exact-reference Service cleanup, deletes the Cognito identity by
// its immutable username, reads absence back, and records the outcome against the original
// run. It runs before every `qualify` suite and daily through the scheduled dispatch of the
// same protected `workflow_dispatch` entry.
//
// Two sources, one identity set:
//   - the run-bound lifecycle manifests of the lookback are authoritative for their address,
//     subject and run;
//   - CloudTrail `AdminCreateUser` events over the same window prove ownership for a creation
//     whose manifest was never uploaded, and prove the caller is the E2E qualification role.
//     The live event masks the created address (#217): `requestParameters.username` is the
//     literal `HIDDEN_DUE_TO_SECURITY_REASONS`, `Resources` is absent, and the immutable
//     username is `additionalEventData.sub`. The reconcile resolves that sub to its address
//     with `AdminGetUser` before the identity set exists, so a masked creation is attributed
//     instead of dropped. A creation with no usable sub, or whose sub resolves to no captured
//     worker, is reported to the operator as a run warning and never deleted.
//     Such a creation derives its cleanup scope from its run; its `sub` is read back.
// A creation newer than a manifest record displaces it: a successful `AdminCreateUser` proves
// the previous identity was absent, so the stale subject of the run that held the address
// before must not judge the live identity.
//
// The record is `anywear_e2e_account_reconcile` v1. It is the audit trail; the artifacts
// it was built from expire, the record does not.
//
// Nothing here lists Cognito users or deletes by prefix: an identity is only ever touched
// when a manifest names it or CloudTrail proves its creation, and the Service cleanup
// receives the exact captured `{runScope, users}` request.

export const RECONCILE_RECORD_TYPE = 'anywear_e2e_account_reconcile';
export const RECONCILE_SCHEMA_VERSION = 1;
export const RECONCILE_WINDOW_DAYS = 7;
/** The one recorded migration dispatch, which reads the 90-day artifact retention (#217). */
export const RECONCILE_MIGRATION_WINDOW_DAYS = 90;
export const RECONCILE_LOOKBACK_DAYS = Object.freeze([RECONCILE_WINDOW_DAYS, RECONCILE_MIGRATION_WINDOW_DAYS]);
/** At most nine lifecycle artifacts per lookback day; the listing fails closed above it. */
export const RECONCILE_ARTIFACTS_PER_DAY = 9;
/**
 * The reconcile family's own per-day listing bound (#224). A reconcile run uploads one
 * `beta-account-reconcile-<run>-<attempt>` artifact, so nine a day is ample for the pre-suite and
 * scheduled dispatches; the bound exists so a runaway repository cannot turn the witness lookup
 * into an unbounded walk. It counts a different population from the lifecycle bound above.
 */
export const RECONCILE_RECORD_ARTIFACTS_PER_DAY = 9;
/** The durable witness lookup reads at most this many candidate artifacts per execution (#224). */
export const RECONCILE_WITNESS_ARTIFACT_READS = 40;
/**
 * The migration window must start marginally inside CloudTrail's 90-day history: `LookupEvents`
 * accepts only the last 90 days, and a range that starts exactly at `now - 90 days` is often
 * already outside it by the time the request is evaluated. Five minutes is enough for the clock
 * and request latency, and it still rounds to the reviewed 90-day lookback.
 */
export const RECONCILE_CLOUDTRAIL_MARGIN_MS = 5 * 60_000;
export const RECONCILE_RETENTION_HOURS = 24;
export const RECONCILE_MAX_EVENTS = 1000;
export const RECONCILE_MAX_USERS_PER_REQUEST = 8;
export const DEFAULT_RECONCILE_DEADLINE_SECONDS = 720;
/** The closed upload set a lifecycle artifact may contain (#217). */
export const LIFECYCLE_MANIFESTS = Object.freeze(['account-budget.json', 'account-budget-oldest-client.json']);
export const LIFECYCLE_DIAGNOSTICS = Object.freeze(['service-cleanup-operation.json', 'service-cleanup-run.json']);
export const LIFECYCLE_UPLOAD_SET = Object.freeze([...LIFECYCLE_MANIFESTS, ...LIFECYCLE_DIAGNOSTICS]);
/** The two fixed diagnostics one reconcile artifact carries (#224); its other files are records. */
export const RECONCILE_DIAGNOSTICS = Object.freeze(['account-reconcile.json', 'deployment-evidence.json']);
/** One per-scope Service cleanup operation record a reconcile artifact carries (#224). */
const RECONCILE_RECORD_FILE = /^service-cleanup-(0|[1-9][0-9]*)-[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{16}\.json$/;
export const LIFECYCLE_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
export const LIFECYCLE_FILE_MAX_BYTES = 1024 * 1024;
/** One page of the repository artifact list, and the safety bound on walking it. */
export const ARTIFACT_PAGE_SIZE = 100;
/**
 * The listing walks every page the repository has, because unrelated workflows fill the list and
 * must not consume the lifecycle bound. This is a sanity bound on the API walk itself, not the
 * nine-per-lookback-day lifecycle bound: a repository this large is a listing failure, never a
 * silent truncation.
 */
export const MAX_ARTIFACT_PAGES = 500;
export const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
/** The one workflow that may produce a lifecycle artifact a reconcile treats as authoritative. */
export const LIFECYCLE_WORKFLOW_PATH = '.github/workflows/beta-qualification.yml';
export const E2E_QUALIFICATION_CALLER = /^arn:aws:sts::650880818323:assumed-role\/beta-e2e-qualification-role\/[A-Za-z0-9+=,.@_-]{1,64}$/;
export const E2E_QUALIFICATION_ROLE = /^arn:aws:iam::650880818323:role\/beta-e2e-qualification-role$/;
/** The run-scoped credential session every protected credential step assumes. */
export const E2E_QUALIFICATION_SESSION = /^e2e-([1-9][0-9]{0,19})-([1-9][0-9]{0,5})$/;
export const RECONCILE_RUN_SCOPE = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
export const CAPTURED_SUBJECT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/**
 * The literal CloudTrail writes instead of a Cognito identity value (#217). `AdminCreateUser`
 * masks `requestParameters.username`, `requestParameters.userAttributes` and
 * `responseElements.user`, and the event then carries no `Resources` array, so the request
 * username is not an address. The immutable username arrives in `additionalEventData.sub`.
 */
export const CLOUDTRAIL_MASKED_VALUE = 'HIDDEN_DUE_TO_SECURITY_REASONS';
/**
 * The bound on a reported address outside the Beta worker families. `outside_worker_family`
 * is the only reason that admits one, and it never selects a deletion, so the record states
 * it without widening what the operation may touch.
 */
export const BOUNDED_E2E_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}@anywear\.local$/;
export const ACCOUNT_STATUSES = Object.freeze([
  'reserved', 'provisioning', 'in_use', 'cleanup_pending', 'deleted', 'retained',
]);
export const CLEANUP_ACTION = Object.freeze(['committed', 'refused', 'unavailable', 'not_required']);
export const COGNITO_ACTION = Object.freeze(['deleted', 'already_absent', 'refused', 'not_attempted']);
export const OBJECT_ACTION = Object.freeze(['deleted', 'absent', 'none', 'unavailable', 'not_required']);
export const READBACK_ACTION = Object.freeze(['absent', 'present', 'unreadable', 'not_attempted']);
export const IDENTITY_OUTCOMES = Object.freeze(['reconciled', 'already_absent', 'retained']);
/**
 * The three conditions no automatic path in this design can resolve. They are recorded and
 * warned about, and they never fail a reconcile: failing every qualification on one would
 * reintroduce the operator dependency the issue removes.
 */
export const REPORTED_REASONS = Object.freeze(['outside_worker_family', 'unattributable_caller', 'unprovable_ownership']);
export const UNRESOLVED_REASONS = Object.freeze([
  'cognito_delete_refused',
  'cognito_readback_failed',
  'deadline_exceeded',
  'outside_worker_family',
  'service_cleanup_refused',
  'service_cleanup_unavailable',
  'subject_mismatch',
  'unattributable_caller',
  'unprovable_ownership',
]);

const execute = promisify(execFile);
const SKEW_MS = 5 * 60_000;
const ARTIFACT_NAME = /^(beta-account-lifecycle|beta-smoke-account-lifecycle)-([1-9][0-9]*)-([1-9][0-9]*)$/;
/** The reconcile family whose verified records answer the durable witness lookup (#224). */
export const RECONCILE_ARTIFACT_NAME = /^beta-account-reconcile-([1-9][0-9]*)-([1-9][0-9]*)$/;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const WORKER_SCOPE = /^e2e-beta-([1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16})-[0-7]-[a-f0-9]{8}@anywear\.local$/;

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

/**
 * A normalized ISO-8601 UTC instant.
 *
 * CloudTrail may hand back an epoch number or a string, and the AWS CLI serializes its own
 * `EventTime` field as an offset (`2026-10-23T14:02:12+00:00`) while the event's embedded
 * `eventTime` is `Z`. Both are the same instant, so an offset form is normalized rather than
 * refused; the record always states UTC with a `Z` suffix.
 */
function instant(value, label) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  throw new Error(`${label} must be an ISO-8601 UTC instant`);
}

/**
 * The record window. Both sources are read over exactly this span, so the record can be
 * re-read against the artifacts and the CloudTrail history it names.
 *
 * The lookback is a closed set: the ordinary seven days, or the 90-day artifact retention the
 * one recorded migration dispatch reads. Any other value is a dispatch mistake, not a bound.
 */
export function reconcileWindow(now = Date.now(), days = RECONCILE_WINDOW_DAYS) {
  requirePositiveInteger(days, 'Reconcile lookback');
  if (!RECONCILE_LOOKBACK_DAYS.includes(days)) {
    throw new Error(`Reconcile lookback must be one of ${RECONCILE_LOOKBACK_DAYS.join(', ')} days`);
  }
  const to = new Date(now);
  // CloudTrail's event history is exactly 90 days, so the migration window starts just inside it;
  // a range starting at `now - 90 days` is already outside the accepted range when it is read.
  const margin = days === RECONCILE_MIGRATION_WINDOW_DAYS ? RECONCILE_CLOUDTRAIL_MARGIN_MS : 0;
  const from = new Date(to.getTime() - days * 24 * 60 * 60_000 + margin);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The lookback a recorded window states, in whole days. */
export function lookbackDaysOfWindow(window) {
  const from = Date.parse(instant(window?.from, 'Reconcile window start'));
  const to = Date.parse(instant(window?.to, 'Reconcile window end'));
  if (from >= to) throw new Error('Reconcile window is not a positive span');
  const days = Math.round((to - from) / (24 * 60 * 60_000));
  if (!RECONCILE_LOOKBACK_DAYS.includes(days)) throw new Error('Reconcile window is not the reviewed lookback');
  return days;
}

/** The artifact bound for one window: nine lifecycle artifacts per lookback day. */
export function maxArtifactsForWindow(window) {
  return lookbackDaysOfWindow(window) * RECONCILE_ARTIFACTS_PER_DAY;
}

/** The reconcile family's own bound for one window: nine artifacts per lookback day (#224). */
export function maxReconcileArtifactsForWindow(window) {
  return lookbackDaysOfWindow(window) * RECONCILE_RECORD_ARTIFACTS_PER_DAY;
}

/** The bound an identity must be resolved inside. */
export function reconcileBound(from, hours = RECONCILE_RETENTION_HOURS) {
  requirePositiveInteger(hours, 'Reconcile retention');
  const at = Date.parse(instant(from, 'Reconcile bound start'));
  return new Date(at + hours * 60 * 60_000).toISOString();
}

/**
 * Parse one lifecycle artifact name. The manifest artifact name is unchanged from before
 * #217, so historical records stay readable.
 */
export function parseManifestArtifactName(name) {
  if (typeof name !== 'string') return undefined;
  const match = ARTIFACT_NAME.exec(name);
  if (!match) return undefined;
  return { smoke: match[1] === 'beta-smoke-account-lifecycle', runId: Number(match[2]), attempt: Number(match[3]) };
}

/**
 * Parse one reconcile artifact name (#224). The family is produced by the same protected
 * `workflow_dispatch` `main` run the lifecycle binding already checks, so it is bound by the same
 * two functions; it is read only as a source of verified cleanup records.
 */
export function parseReconcileArtifactName(name) {
  if (typeof name !== 'string') return undefined;
  const match = RECONCILE_ARTIFACT_NAME.exec(name);
  if (!match) return undefined;
  return { smoke: false, runId: Number(match[1]), attempt: Number(match[2]) };
}

/** The E2E repository's immutable GitHub id, which the artifact and its run must name. */
export const E2E_REPOSITORY_ID = 1317091305;

/**
 * A bound lifecycle artifact must carry the digest GitHub publishes for it, so the bytes the
 * reader verifies are the bytes the listing named. A missing or malformed digest is refused as a
 * source failure: skipping the check would accept an artifact whose bytes nobody vouched for.
 */
export function requireLifecycleArtifactDigest(value, label) {
  if (typeof value !== 'string' || !ARTIFACT_DIGEST.test(value)) {
    throw new Error(`${label} has no well-formed sha256 digest`);
  }
  return value;
}

/**
 * The repository's lifecycle and reconcile artifacts inside the window, read from the whole
 * artifact list.
 *
 * The repository keeps every workflow's artifacts, and they are not this operation's budget:
 * the listing walks every page the API reports (`total_count`) and keeps only non-expired,
 * lifecycle- or reconcile-named rows created inside the window. The two families are counted
 * against their own per-lookback-day bounds: nine lifecycle artifacts (#217), and nine reconcile
 * artifacts whose records may answer a durable witness lookup (#224). A page failure, a
 * malformed page, a short or empty page before the API's last page, or an exhausted page walk
 * fails closed: a truncated list would read as a quiet scan.
 *
 * `fetchPage(page, perPage)` returns one parsed page; the production transport is the GitHub API
 * and the tests inject a fake.
 */
export async function collectLifecycleArtifacts({ window, fetchPage, pageSize = ARTIFACT_PAGE_SIZE } = {}) {
  if (typeof fetchPage !== 'function') throw new Error('Artifact listing requires its page transport');
  requirePositiveInteger(pageSize, 'Artifact page size');
  const bound = maxArtifactsForWindow(window);
  const reconcileBound = maxReconcileArtifactsForWindow(window);
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const artifacts = [];
  const reconcileArtifacts = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_ARTIFACT_PAGES) throw new Error('Artifact listing exceeds its page bound');
    const response = await fetchPage(page, pageSize);
    if (!response || typeof response !== 'object' || Array.isArray(response) || !Array.isArray(response.artifacts)) {
      throw new Error('Artifact list response is malformed');
    }
    if (!Number.isSafeInteger(response.total_count) || response.total_count < 0) {
      throw new Error('Artifact list response is malformed');
    }
    const pages = Math.max(1, Math.ceil(response.total_count / pageSize));
    if (page < pages && response.artifacts.length === 0) throw new Error('Artifact listing is truncated');
    for (const artifact of response.artifacts) {
      // An expired artifact has no bytes left to read; it is outside the scan rather than
      // unbound, and the recorded residual is the leftover older than both retention windows.
      if (artifact?.expired !== false) continue;
      const lifecycle = parseManifestArtifactName(artifact?.name);
      const reconcile = lifecycle ? undefined : parseReconcileArtifactName(artifact?.name);
      if (!lifecycle && !reconcile) continue;
      const createdAt = Date.parse(artifact.created_at ?? '');
      if (!Number.isFinite(createdAt) || createdAt < from || createdAt > to) continue;
      const row = {
        id: requirePositiveInteger(artifact.id, 'Artifact id'),
        name: artifact.name,
        digest: requireLifecycleArtifactDigest(artifact.digest, `Lifecycle artifact ${artifact.name}`),
        created_at: artifact.created_at,
        // The listing has already dropped every expired artifact; the row carries the flag so a
        // consumer can re-check the same bound without knowing it read the collector (#224). The
        // durable witness lookup requires `expired === false`, and a hand-built row that lost the
        // flag closed the artifact tier in production.
        expired: false,
        workflow_run: artifact.workflow_run,
      };
      // The two families are partitioned here, before anything is read, so each keeps its own
      // bound: `sources.artifacts` counts the lifecycle family and never the reconcile one.
      (lifecycle ? artifacts : reconcileArtifacts).push(row);
    }
    if (artifacts.length > bound) throw new Error('Lifecycle artifacts in the window exceed the reconcile bound');
    if (reconcileArtifacts.length > reconcileBound) throw new Error('Reconcile artifacts in the window exceed the reconcile bound');
    if (page >= pages) break;
    if (response.artifacts.length < pageSize) throw new Error('Artifact listing is truncated');
  }
  return [...artifacts, ...reconcileArtifacts];
}

/**
 * The closed upload set one lifecycle artifact may contain.
 *
 * A `full` artifact carries both account manifests (the default leg and the oldest-supported
 * Client leg) and the two Service cleanup diagnostics; a `smoke` artifact carries the first,
 * third and fourth. Every `account-budget*.json` present is read as a manifest, so a retained
 * identity from the oldest-client leg is no longer invisible, and both legs feed one identity
 * set. The diagnostics are ignored, and no specific manifest is required: the reader accepts
 * whichever legs the run uploaded.
 *
 * Everything else is refused: an unknown name, a directory, a symlink, a duplicate, or a file
 * over its bound. The reader never guesses which file was meant.
 */
export function classifyLifecycleArchive(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Lifecycle artifact is empty');
  const seen = new Set();
  const manifests = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') {
      throw new Error('Lifecycle artifact entry is malformed');
    }
    if (seen.has(entry.name)) throw new Error(`Lifecycle artifact repeats ${entry.name}`);
    seen.add(entry.name);
    if (entry.directory === true || entry.symlink === true) throw new Error(`Lifecycle artifact contains a directory or symlink: ${entry.name}`);
    if (!LIFECYCLE_UPLOAD_SET.includes(entry.name)) throw new Error(`Lifecycle artifact contains an unknown file: ${entry.name}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > LIFECYCLE_FILE_MAX_BYTES) {
      throw new Error(`Lifecycle artifact file is over its bound: ${entry.name}`);
    }
    if (LIFECYCLE_MANIFESTS.includes(entry.name)) manifests.push(entry.name);
  }
  return { manifests: manifests.sort(), diagnostics: entries.length - manifests.length };
}

/**
 * The closed upload set one reconcile artifact may contain (#224).
 *
 * `account-reconcile.json` is the record this family exists for, `deployment-evidence.json` is
 * the live tuple the run read, and every `service-cleanup-<index>-<runScope>.json` is one
 * per-scope Service cleanup operation record. Exactly those names are accepted; anything else,
 * a directory, a symlink, a duplicate or an over-bound file refuses the artifact, the same way
 * the lifecycle reader refuses an unknown file.
 */
export function classifyReconcileArchive(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Reconcile artifact is empty');
  const seen = new Set();
  const records = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') {
      throw new Error('Reconcile artifact entry is malformed');
    }
    if (seen.has(entry.name)) throw new Error(`Reconcile artifact repeats ${entry.name}`);
    seen.add(entry.name);
    if (entry.directory === true || entry.symlink === true) throw new Error(`Reconcile artifact contains a directory or symlink: ${entry.name}`);
    const record = RECONCILE_RECORD_FILE.test(entry.name);
    if (!record && !RECONCILE_DIAGNOSTICS.includes(entry.name)) {
      throw new Error(`Reconcile artifact contains an unknown file: ${entry.name}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > LIFECYCLE_FILE_MAX_BYTES) {
      throw new Error(`Reconcile artifact file is over its bound: ${entry.name}`);
    }
    if (record) records.push(entry.name);
  }
  return { records: records.sort() };
}

/**
 * The artifact list's own binding to the protected run.
 *
 * A lifecycle- or reconcile-named artifact is authoritative only when its name's run is the run
 * the artifact API reports, that run is on `main`, and the artifact and its head repository are
 * this repository. A run's conclusion is deliberately not required: a failed or cancelled run's
 * manifest is exactly the leftover this operation must read, and its reconcile artifact may still
 * carry a verified cleanup record. A lifecycle artifact that fails this binding is ignored and
 * counted; a reconcile artifact that fails it is simply not a witness candidate.
 */
export function lifecycleArtifactBinding(artifact) {
  const parsed = parseManifestArtifactName(artifact?.name) ?? parseReconcileArtifactName(artifact?.name);
  if (!parsed) return { bound: false, reason: 'name' };
  const run = artifact.workflow_run;
  if (!run || typeof run !== 'object' || Array.isArray(run)) return { bound: false, reason: 'run' };
  if (run.id !== parsed.runId) return { bound: false, reason: 'run-id' };
  if (run.head_branch !== 'main') return { bound: false, reason: 'branch' };
  if (Number(run.repository_id) !== E2E_REPOSITORY_ID || Number(run.head_repository_id) !== E2E_REPOSITORY_ID) {
    return { bound: false, reason: 'repository' };
  }
  if (typeof run.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(run.head_sha)) return { bound: false, reason: 'head-sha' };
  return { bound: true, parsed, headSha: run.head_sha };
}

/**
 * The cached `GET actions/runs/<run>` half of the binding: the artifact must have been produced
 * by the protected `main` `workflow_dispatch` run of `beta-qualification.yml`, at the same head
 * the artifact recorded.
 *
 * A readable run that fails any of these checks is a verdict, not an exception: the artifact is
 * ignored and counted in `sources.artifacts_ignored`, and it is never authoritative. Only an
 * unreadable run lookup — the transport could not say anything — is a source failure, and that
 * is raised by the caller around `io.getWorkflowRun`.
 */
export function lifecycleWorkflowRunBinding(run, headSha) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return { bound: false, reason: 'run' };
  if (run.path !== LIFECYCLE_WORKFLOW_PATH) return { bound: false, reason: 'path' };
  if (run.event !== 'workflow_dispatch') return { bound: false, reason: 'event' };
  if (run.head_branch !== 'main') return { bound: false, reason: 'branch' };
  if (run.head_sha !== headSha) return { bound: false, reason: 'head-sha' };
  return { bound: true };
}

/**
 * The one compatibility read the new model keeps: a manifest written before #217 records
 * `quarantined`, which is the state this design replaced. It is read as `retained` and its
 * original reason is preserved, so a historical leftover resolves through the same path
 * and no operator has to translate it.
 */
export function normalizeAccountStatus(status) {
  if (status === 'quarantined') return 'retained';
  if (typeof status !== 'string' || !ACCOUNT_STATUSES.includes(status)) return undefined;
  return status;
}

/**
 * One manifest, validated in the manifest's own terms.
 *
 * The manifest must name the artifact's own run and attempt, so a forged or corrupted
 * manifest cannot make one run's artifact authoritative for another run's identities. A
 * mismatch is a contract violation and fails the reconcile closed (nothing is deleted).
 */
export function readManifest(bytes, artifact) {
  const manifest = parseStrictJson(bytes);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Account manifest must be an object');
  if (manifest.version !== 1 || !RECONCILE_RUN_SCOPE.test(manifest.runScope ?? '')
    || !Array.isArray(manifest.accounts) || manifest.accounts.length > 50) {
    throw new Error('Account manifest does not describe one bounded run scope');
  }
  if (!manifest.runScope.startsWith(`${artifact.runId}-${artifact.attempt}-`)) {
    throw new Error(`Account manifest run scope does not name the artifact's run and attempt: ${artifact.runId}-${artifact.attempt}`);
  }
  return { manifest, artifact };
}

/**
 * The identity set the manifests contribute.
 *
 * Every non-`deleted` worker record is a leftover: `reserved`, `provisioning`, `in_use` and
 * `cleanup_pending` mean the teardown never proved absence, and `retained` (or a legacy
 * `quarantined`) means it ran and failed. A stable pool address is reused by later runs, so
 * the latest record for an address wins: a later `deleted` record proves the address was
 * resolved after the older record was written, and re-reconciling the older one would
 * touch an identity another attempt owns.
 */
export function manifestIdentities(manifests) {
  const latest = new Map();
  for (const { manifest, artifact } of manifests) {
    for (const account of manifest.accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('Account manifest record is malformed');
      const email = requireString(account.email, 'Account manifest address');
      const createdAt = instant(account.createdAt ?? account.updatedAt, 'Account manifest creation time');
      const updatedAt = instant(account.updatedAt ?? account.createdAt, 'Account manifest transition time');
      const status = normalizeAccountStatus(account.status);
      if (!status) throw new Error(`Account manifest records an unknown account state: ${email}`);
      const record = {
        email,
        mode: account.mode,
        status,
        createdAt,
        updatedAt,
        subject: typeof account.subject === 'string' && CAPTURED_SUBJECT.test(account.subject) ? account.subject.toLowerCase() : undefined,
        // `retainedReason` is the #217 field; `reason` is what every historical manifest
        // wrote for a quarantined record. Both are bounded prose and neither selects a
        // deletion, so the older name is read rather than invented.
        retainedReason: typeof account.retainedReason === 'string' ? account.retainedReason
          : typeof account.reason === 'string' ? account.reason : undefined,
        reconcileBy: typeof account.reconcileBy === 'string' && Number.isFinite(Date.parse(account.reconcileBy))
          ? instant(account.reconcileBy, 'Account manifest reconcile bound') : undefined,
        origin: { kind: 'manifest', run: requirePositiveInteger(artifact.runId, 'Manifest run'), attempt: requirePositiveInteger(artifact.attempt, 'Manifest attempt') },
        runScope: manifest.runScope,
      };
      const previous = latest.get(email);
      if (!previous || Date.parse(record.updatedAt) >= Date.parse(previous.updatedAt)) latest.set(email, record);
    }
  }
  return [...latest.values()]
    .filter((record) => record.status !== 'deleted')
    // The bound is measured from the creating run, not from the retention write: it states
    // when this run's leftover became late, not when a later attempt noticed it.
    .map((record) => ({ ...record, boundAt: Date.parse(record.reconcileBy ?? reconcileBound(record.createdAt)) }))
    .sort((left, right) => left.boundAt - right.boundAt || left.email.localeCompare(right.email));
}

function callerOf(event) {
  const identity = event.userIdentity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return undefined;
  if (typeof identity.arn === 'string') return identity.arn;
  const issuer = identity.sessionContext?.sessionIssuer?.arn;
  return typeof issuer === 'string' ? issuer : undefined;
}

/**
 * The run a qualification-role caller names.
 *
 * Every protected credential step assumes the qualification role with
 * `role-session-name: e2e-<run>-<attempt>`, so the assumed-role ARN's session name is the
 * creating run. A creation recorded before that convention has no run here and is attributed
 * to the qualification role and the event instead.
 */
export function qualificationSession(arn) {
  if (typeof arn !== 'string') return undefined;
  const match = /^arn:aws:sts::650880818323:assumed-role\/beta-e2e-qualification-role\/(.+)$/.exec(arn);
  if (!match) return undefined;
  const session = E2E_QUALIFICATION_SESSION.exec(match[1]);
  return session ? { run: Number(session[1]), attempt: Number(session[2]) } : undefined;
}

/** A CloudTrail value that is present and not the masking sentinel. */
function realIdentityValue(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toUpperCase() === CLOUDTRAIL_MASKED_VALUE) return undefined;
  return trimmed;
}

/**
 * The request username, when the event still carries one.
 *
 * A live `AdminCreateUser` event masks `requestParameters.username` (#217), so this normally
 * returns `undefined` and the creation is named by its `additionalEventData.sub` instead. A
 * user-pool user resource, when an event carries one, is the fallback.
 */
function createdUsername(event) {
  const parameters = event.requestParameters;
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    const username = realIdentityValue(parameters.username) ?? realIdentityValue(parameters.userName);
    if (username) return username;
  }
  if (Array.isArray(event.Resources)) {
    for (const resource of event.Resources) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
      if (resource.ResourceType !== 'AWS::Cognito::UserPoolUser') continue;
      const name = realIdentityValue(resource.ResourceName);
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * The immutable username a masked creation names.
 *
 * In this pool the Cognito username *is* the `sub`, so `additionalEventData.sub` is both the
 * immutable username and the identity's subject. A value outside the captured subject grammar
 * is not usable as a lookup, and no masked literal is ever read as an address.
 */
function createdSubject(event) {
  const additional = event.additionalEventData;
  if (!additional || typeof additional !== 'object' || Array.isArray(additional)) return undefined;
  const sub = realIdentityValue(additional.sub);
  return sub && CAPTURED_SUBJECT.test(sub) ? sub.toLowerCase() : undefined;
}

/** One operator-facing entry for a creation that never became an identity. */
function creationWarning(entry, detail) {
  return { eventId: entry.eventId, eventTime: entry.eventTime, caller: entry.caller ?? 'unknown', detail };
}

/** The run annotations a creation warning earns. A reported creation never fails a run. */
export function creationWarningAnnotations(entries) {
  return entries.map((entry) => `::warning title=Unattributed E2E creation::CloudTrail event ${entry.eventId} at ${entry.eventTime} by ${entry.caller}: ${entry.detail}`);
}

/**
 * Read the `AdminCreateUser` history into creation facts.
 *
 * The live event is masked (#217): `requestParameters.username` is the literal
 * `HIDDEN_DUE_TO_SECURITY_REASONS`, no `Resources` array is present, and the immutable username
 * is `additionalEventData.sub`. A creation therefore names either a real request username or a
 * `sub`; resolving a sub to its address is IO and belongs to `resolveCreateUserEvents`, so this
 * function stays pure.
 *
 * The caller is checked before any address-based exclusion: a creation by a caller other than
 * the qualification role is reported, with its caller and any address it names, and is never
 * deleted. A creation that names no address at all — no real username and no usable sub — is
 * returned as a warning rather than dropped: an in-window creation is always reported.
 */
export function parseCreateUserEvents(events, window, { userPoolId } = {}) {
  if (!Array.isArray(events)) throw new Error('CloudTrail response must be an event array');
  if (events.length > RECONCILE_MAX_EVENTS) throw new Error('CloudTrail read exceeds its bound');
  const created = [];
  const unattributable = [];
  const warnings = [];
  for (const entry of events) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('CloudTrail event is malformed');
    let detail;
    try { detail = JSON.parse(String(entry.CloudTrailEvent)); } catch { throw new Error('CloudTrail event detail is not JSON'); }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('CloudTrail event detail is malformed');
    if (detail.eventName !== undefined && detail.eventName !== 'AdminCreateUser') continue;
    if (typeof detail.errorCode === 'string' && detail.errorCode.length > 0) continue;
    // A creation for another user pool is not this reconcile's to attribute.
    const parameters = detail.requestParameters;
    if (userPoolId && parameters && typeof parameters === 'object' && typeof parameters.userPoolId === 'string'
      && parameters.userPoolId !== userPoolId) continue;
    // The event's own `eventTime` is the canonical `Z` instant. The CLI envelope's `EventTime`
    // is the same instant in offset form, and is the fallback for a synthetic event detail.
    const eventTime = instant(detail.eventTime ?? entry.EventTime, 'CloudTrail event time');
    if (Date.parse(eventTime) < Date.parse(window.from) || Date.parse(eventTime) > Date.parse(window.to)) continue;
    const caller = callerOf(detail);
    const eventId = requireString(entry.EventId ?? detail.eventID, 'CloudTrail event id');
    const username = createdUsername(detail);
    const sub = createdSubject(detail);
    // The caller is decided first: no address rule may drop a foreign creation before it is
    // reported. `qualificationSession` is only meaningful for the qualification role.
    if (!caller || (!E2E_QUALIFICATION_CALLER.test(caller) && !E2E_QUALIFICATION_ROLE.test(caller))) {
      if (!username && !sub) {
        warnings.push(creationWarning({ eventId, eventTime, caller: caller ?? 'unknown' },
          'the creation names no usable username or additionalEventData.sub'));
        continue;
      }
      unattributable.push({
        ...(username ? { email: username } : {}),
        ...(sub ? { sub } : {}),
        caller: caller ?? 'unknown',
        eventId,
        eventTime,
      });
      continue;
    }
    const session = qualificationSession(caller);
    const identity = {
      ...(username ? { email: username } : {}),
      ...(sub ? { sub } : {}),
      caller,
      eventId,
      eventTime,
      ...(session ? { run: session.run, attempt: session.attempt } : {}),
    };
    if (username && !isCapturedBetaWorkerEmail(username)) {
      // A real request username outside the worker families is reported, never silently
      // dropped and never an identity: it can never select a deletion.
      warnings.push(creationWarning(identity, `the creation address ${username} is outside the Beta worker families`));
      continue;
    }
    if (!username && !sub) {
      warnings.push(creationWarning(identity, 'the creation names no usable username or additionalEventData.sub'));
      continue;
    }
    created.push(identity);
  }
  return { created, unattributable, warnings };
}

/**
 * Resolve the address of every masked creation before the identity set is built.
 *
 * The masked request username is not an address; `additionalEventData.sub` is the immutable
 * Cognito username in this pool, so `AdminGetUser(Username=<sub>)` returns the identity that was
 * created and its `email` attribute is the pool address. Resolution is the only IO here, which
 * keeps `parseCreateUserEvents` pure. A sub that no longer resolves to a live identity leaves
 * nothing to clean and is reported as a warning; any other read failure is a source failure and
 * refuses before any deletion, because the attribution cannot be decided at all.
 */
export async function resolveCreateUserEvents(parsed, { io } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Array.isArray(parsed.created) || !Array.isArray(parsed.unattributable)) {
    throw new Error('Create-user events must be parsed before they are resolved');
  }
  if (!io || typeof io.getUserByUsername !== 'function') throw new Error('Create-user resolution requires the Cognito username read');
  const warnings = [...(Array.isArray(parsed.warnings) ? parsed.warnings : [])];
  const resolved = new Map();

  async function addressOf(entry) {
    if (entry.email) return entry;
    if (!entry.sub) {
      warnings.push(creationWarning(entry, 'the creation names no usable username or additionalEventData.sub'));
      return undefined;
    }
    if (!resolved.has(entry.sub)) {
      try {
        const user = await io.getUserByUsername(entry.sub);
        const attributes = Object.fromEntries((user?.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
        // The pool's immutable username is the sub; a returned identity whose own subject
        // differs is not the identity the event created, so it cannot be attributed by it.
        if (typeof user?.Username !== 'string' || attributes.sub?.toLowerCase() !== entry.sub) {
          throw new Error(`CloudTrail creation ${entry.eventId}: username ${entry.sub} is not that identity`);
        }
        const email = typeof attributes.email === 'string' ? attributes.email : undefined;
        resolved.set(entry.sub, email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined);
      } catch (error) {
        if (isUserNotFound(error)) {
          resolved.set(entry.sub, null);
        } else {
          throw new Error(`CloudTrail creation ${entry.eventId}: username ${entry.sub} could not be read (${error instanceof Error ? error.message : 'unknown error'})`, { cause: error });
        }
      }
    }
    const address = resolved.get(entry.sub);
    if (address === undefined || address === null) {
      warnings.push(creationWarning(entry, address === null
        ? `the sub ${entry.sub} resolves to no live identity`
        : `the sub ${entry.sub} resolves to an identity with no usable email`));
      return undefined;
    }
    return { ...entry, email: address };
  }

  const created = [];
  for (const entry of parsed.created) {
    const addressed = await addressOf(entry);
    if (addressed) created.push(addressed);
  }
  const unattributable = [];
  for (const entry of parsed.unattributable) {
    const addressed = await addressOf(entry);
    if (addressed) unattributable.push(addressed);
  }
  return { created, unattributable, warnings };
}

/**
 * The cleanup scope a creation-only identity derives from its run.
 *
 * `runScope` is an operation/idempotency name, never a selector: the exact users select the
 * rows and objects. A creation whose credential session names its run therefore derives a
 * scope from that run, so a retry of the same reconcile reuses the same Service execution
 * name. A creation recorded before run-scoped sessions has no run to name; its scope is
 * derived from its own creation fact, so it is still deterministic and still not a selector.
 * An address in the historical scoped grammar carries its own scope and keeps it.
 */
export function creationRunScope(creation) {
  const scoped = WORKER_SCOPE.exec(creation.email);
  if (scoped) return scoped[1];
  const seed = createHash('sha256')
    .update(`${creation.email}|${creation.eventId}|${creation.eventTime}`)
    .digest('hex')
    .slice(0, 16);
  const run = creation.run ?? Math.floor(Date.parse(creation.eventTime) / 1_000);
  const attempt = creation.attempt ?? 1;
  return `${run}-${attempt}-${seed}`;
}

/** The record origin of a creation, naming its run and attempt when its session does. */
export function creationOrigin(creation) {
  return {
    kind: 'cloudtrail',
    event_id: creation.eventId,
    event_time: creation.eventTime,
    ...(creation.run ? { run: creation.run, attempt: creation.attempt } : {}),
  };
}

/**
 * One reconcile identity set: manifests authoritative, CloudTrail proving or displacing them.
 *
 * `parsed` is the resolved creation set (`resolveCreateUserEvents`); when it is absent the
 * events are parsed here for a pure caller, which is what the offline unit tests use. A masked
 * creation therefore arrives with its address already read back, and no masked literal is ever
 * an address.
 *
 * The rule per address is:
 *   - a record outside the Beta worker families is reported, never deleted;
 *   - a creation newer than the record's own `createdAt` displaces it, because a successful
 *     `AdminCreateUser` proves the identity the record named was absent, so the record's stale
 *     subject must not judge the live one — the live `sub` is read back instead;
 *   - a stable pool row needs a captured subject or a qualification-role creation for that
 *     exact address; without either it is reported as unprovable ownership;
 *   - a historical scoped address carries its run scope and stays reconcilable;
 *   - a creation by a caller other than the qualification role is reported, never deleted;
 *   - a creation whose address resolves outside the worker families, or that names no address
 *     at all, is reported and never deleted.
 */
export function buildIdentitySet({ manifests, events = [], parsed, window, userPoolId }) {
  const unresolved = [];
  const identities = [];
  const creationSet = parsed ?? parseCreateUserEvents(events, window, { userPoolId });
  const { created, unattributable } = creationSet;
  const warnings = [...(Array.isArray(creationSet.warnings) ? creationSet.warnings : [])];
  const latestCreation = new Map();
  for (const creation of created) {
    // A masked creation is resolved before this point on the reconcile path. A direct caller
    // that skipped the resolution gets a report rather than an address-less identity.
    if (!creation.email) {
      warnings.push(creationWarning(creation, `the creation names no address; resolve the sub ${creation.sub ?? 'none'} before building the identity set`));
      continue;
    }
    const previous = latestCreation.get(creation.email);
    if (!previous || Date.parse(creation.eventTime) > Date.parse(previous.eventTime)) latestCreation.set(creation.email, creation);
  }

  for (const record of manifestIdentities(manifests)) {
    if (record.mode !== 'worker' || !isCapturedBetaWorkerEmail(record.email)) {
      unresolved.push({
        email: record.email,
        reason: 'outside_worker_family',
        origin: record.origin,
        boundAt: record.boundAt,
      });
      continue;
    }
    const creation = latestCreation.get(record.email);
    const displaced = creation !== undefined && Date.parse(creation.eventTime) > Date.parse(record.createdAt) + SKEW_MS;
    if (displaced) {
      identities.push({
        email: record.email,
        mode: 'worker',
        status: 'retained',
        subject: undefined,
        retainedReason: 'displaced by a newer creation',
        origin: creationOrigin(creation),
        runScope: creationRunScope(creation),
        boundAt: Date.parse(reconcileBound(creation.eventTime)),
      });
      continue;
    }
    // A stable allowlist row is an address a human tester can hold too, so its grammar proves
    // nothing: the captured subject or a qualification-role creation is the ownership proof,
    // and without either the record is reported instead of deleted (ADR-0031 §4).
    if (STABLE_WORKER_EMAIL_PATTERN.test(record.email) && !record.subject && !creation) {
      unresolved.push({
        email: record.email,
        reason: 'unprovable_ownership',
        origin: record.origin,
        boundAt: record.boundAt,
      });
      continue;
    }
    identities.push(record.subject || !creation
      ? record
      // A creation-proven stable record has no captured subject: the creation event is the
      // proof, and the live `sub` is read back from the identity itself.
      : {
        ...record,
        subject: undefined,
        origin: creationOrigin(creation),
        runScope: record.runScope,
      });
  }

  for (const entry of unattributable) {
    if (!entry.email) {
      // No address could be resolved for a foreign creation: it is reported and never dropped.
      warnings.push(creationWarning(entry, 'the creation names no usable username or additionalEventData.sub'));
      continue;
    }
    if (!isCapturedBetaWorkerEmail(entry.email)) {
      // A foreign creation is reported with the bounded E2E address it resolved to, and never
      // deleted. An address the record's closed grammar cannot state is a run warning.
      if (BOUNDED_E2E_ADDRESS.test(entry.email)) {
        unresolved.push({
          email: entry.email,
          reason: 'outside_worker_family',
          origin: { kind: 'cloudtrail', event_id: entry.eventId, event_time: entry.eventTime },
          boundAt: Date.parse(reconcileBound(entry.eventTime)),
        });
      } else {
        warnings.push(creationWarning(entry, `the creation address ${entry.email} is outside the Beta worker families`));
      }
      continue;
    }
    const displacedRecord = identities.find((identity) => identity.email === entry.email
      && identity.origin.kind === 'manifest'
      && Date.parse(entry.eventTime) > Date.parse(identity.createdAt) + SKEW_MS);
    if (displacedRecord) {
      // A foreign creation newer than the record proves the record's identity was absent, and
      // the reconciler has no ownership proof for the live one. Report it, delete nothing.
      identities.splice(identities.indexOf(displacedRecord), 1);
      unresolved.push({
        email: entry.email,
        reason: 'unattributable_caller',
        caller: entry.caller,
        origin: { kind: 'cloudtrail', event_id: entry.eventId, event_time: entry.eventTime },
        boundAt: Date.parse(reconcileBound(entry.eventTime)),
      });
      continue;
    }
    if (identities.some((identity) => identity.email === entry.email)) {
      // The record's captured subject still proves the identity it names; the unrelated
      // foreign creation is not this reconcile's to delete and does not displace it.
      continue;
    }
    unresolved.push({
      email: entry.email,
      reason: 'unattributable_caller',
      caller: entry.caller,
      origin: { kind: 'cloudtrail', event_id: entry.eventId, event_time: entry.eventTime },
      boundAt: Date.parse(reconcileBound(entry.eventTime)),
    });
  }

  for (const creation of latestCreation.values()) {
    if (!isCapturedBetaWorkerEmail(creation.email)) {
      // A masked creation whose sub resolves to an address outside the worker families is
      // reported, never deleted: it cannot select a cleanup.
      if (BOUNDED_E2E_ADDRESS.test(creation.email)) {
        unresolved.push({
          email: creation.email,
          reason: 'outside_worker_family',
          origin: { kind: 'cloudtrail', event_id: creation.eventId, event_time: creation.eventTime },
          boundAt: Date.parse(reconcileBound(creation.eventTime)),
        });
      } else {
        warnings.push(creationWarning(creation, `the creation address ${creation.email} is outside the Beta worker families`));
      }
      continue;
    }
    if (identities.some((identity) => identity.email === creation.email)) continue;
    if (unresolved.some((entry) => entry.email === creation.email)) continue;
    // A creation with no manifest entry is attributed to the run its credential session names
    // (or, before run-scoped sessions, to the qualification role and the event). Its `sub` is
    // read back and its cleanup scope is derived from that run, never from its address alone.
    identities.push({
      email: creation.email,
      mode: 'worker',
      status: 'retained',
      subject: undefined,
      retainedReason: 'lifecycle manifest missing for this creation',
      origin: creationOrigin(creation),
      runScope: creationRunScope(creation),
      boundAt: Date.parse(reconcileBound(creation.eventTime)),
    });
  }
  identities.sort((left, right) => left.boundAt - right.boundAt || left.email.localeCompare(right.email));
  return { identities, unresolved, created, unattributable, warnings };
}

/**
 * Group the Service cleanup requests by the run scope they were captured under, oldest
 * first. The Service admits at most eight exact users per request, and one request per
 * captured scope keeps the execution name deterministic for a retry.
 */
export function cleanupGroups(identities, { maxUsers = RECONCILE_MAX_USERS_PER_REQUEST } = {}) {
  requirePositiveInteger(maxUsers, 'Cleanup users per request');
  const byScope = new Map();
  for (const identity of identities) {
    if (!byScope.has(identity.runScope)) byScope.set(identity.runScope, []);
    byScope.get(identity.runScope).push(identity);
  }
  const groups = [];
  for (const [runScope, members] of byScope) {
    if (!RECONCILE_RUN_SCOPE.test(runScope)) throw new Error('Cleanup group run scope is invalid');
    for (let index = 0; index < members.length; index += maxUsers) {
      const chunk = members.slice(index, index + maxUsers);
      groups.push({ runScope, identities: chunk, boundAt: Math.min(...chunk.map((identity) => identity.boundAt)) });
    }
  }
  return groups.sort((left, right) => left.boundAt - right.boundAt || left.runScope.localeCompare(right.runScope));
}

/** The canonical exact-reference cleanup request the Service accepts. */
export function cleanupRequest(runScope, users) {
  return JSON.stringify({ runScope, users: users.map(({ sub, email }) => ({ sub, email })) });
}

/**
 * The `actions.objects` value a committed cleanup result proves. A Service release that does
 * not state both counters cannot prove the object phase, so it is `unavailable` and the
 * identity is retained rather than reported clean on an assumption.
 */
export function objectAction(committed) {
  if (!committed || typeof committed !== 'object' || Array.isArray(committed)) return 'unavailable';
  const { objects, objectsMissing } = committed;
  if (!Number.isSafeInteger(objects) || objects < 0 || !Number.isSafeInteger(objectsMissing) || objectsMissing < 0) return 'unavailable';
  if (objects > 0) return 'deleted';
  if (objectsMissing > 0) return 'absent';
  return 'none';
}

function recordIdentity(identity, { subject, actions, outcome }) {
  return {
    email: identity.email,
    subject: typeof subject === 'string' && CAPTURED_SUBJECT.test(subject) ? subject.toLowerCase() : null,
    origin: identity.origin.kind === 'manifest'
      ? { kind: 'manifest', run: identity.origin.run, attempt: identity.origin.attempt }
      : {
        kind: 'cloudtrail',
        event_id: identity.origin.event_id,
        event_time: identity.origin.event_time,
        ...(identity.origin.run ? { run: identity.origin.run, attempt: identity.origin.attempt } : {}),
      },
    actions,
    outcome,
  };
}

/**
 * Build and validate the `anywear_e2e_account_reconcile` v1 record. The record is the audit
 * trail for leftovers, so it names the original run, the address and the outcome of every
 * identity, and it fails closed on any field outside the reviewed contract.
 */
export function buildReconcileRecord({ reconcileId, window, sources, identities, unresolved, result }) {
  const record = {
    schema_version: RECONCILE_SCHEMA_VERSION,
    record_type: RECONCILE_RECORD_TYPE,
    reconcile_id: reconcileId,
    window: { from: window.from, to: window.to },
    sources: {
      artifacts: sources.artifacts,
      artifacts_ignored: sources.artifacts_ignored,
      cloudtrail_events: sources.cloudtrail_events,
    },
    identities,
    unresolved,
    result,
  };
  validateReconcileRecord(record);
  return record;
}

export function validateReconcileRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Reconcile record must be an object');
  if (Object.keys(record).sort().join(',') !== 'identities,reconcile_id,record_type,result,schema_version,sources,unresolved,window') {
    throw new Error('Reconcile record has an unknown or missing member');
  }
  if (record.schema_version !== RECONCILE_SCHEMA_VERSION || record.record_type !== RECONCILE_RECORD_TYPE) throw new Error('Reconcile record schema is not v1');
  if (typeof record.reconcile_id !== 'string' || !/^[1-9][0-9]*-[1-9][0-9]*$/.test(record.reconcile_id)) throw new Error('Reconcile record id is not a run/attempt pair');
  if (!record.window || Object.keys(record.window).sort().join(',') !== 'from,to') throw new Error('Reconcile window has an unknown or missing member');
  const days = lookbackDaysOfWindow(record.window);
  if (!record.sources || Object.keys(record.sources).sort().join(',') !== 'artifacts,artifacts_ignored,cloudtrail_events') {
    throw new Error('Reconcile sources have an unknown or missing member');
  }
  // Zero is a valid scan: a seven-day window with no lifecycle manifest is exactly the case
  // in which CloudTrail alone proves a crashed run's creation.
  const artifactBound = days * RECONCILE_ARTIFACTS_PER_DAY;
  if (!Number.isSafeInteger(record.sources.artifacts) || record.sources.artifacts < 0
    || record.sources.artifacts > artifactBound) throw new Error('Reconcile artifact count is unbounded');
  if (!Number.isSafeInteger(record.sources.artifacts_ignored) || record.sources.artifacts_ignored < 0) {
    throw new Error('Reconcile ignored artifact count is unbounded');
  }
  if (!Number.isSafeInteger(record.sources.cloudtrail_events) || record.sources.cloudtrail_events < 0 || record.sources.cloudtrail_events > RECONCILE_MAX_EVENTS) {
    throw new Error('Reconcile CloudTrail count is unbounded');
  }
  if (!['passed', 'failed'].includes(record.result)) throw new Error('Reconcile result is not passed or failed');
  if (!Array.isArray(record.identities) || record.identities.length > 500) throw new Error('Reconcile identities are unbounded');
  const addresses = new Set();
  for (const identity of record.identities) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('Reconcile identity is malformed');
    if (Object.keys(identity).sort().join(',') !== 'actions,email,origin,outcome,subject') throw new Error('Reconcile identity has an unknown member');
    if (!isCapturedBetaWorkerEmail(identity.email)) throw new Error('Reconcile identity address is outside the captured Beta worker families');
    if (addresses.has(identity.email)) throw new Error('Reconcile identity is duplicated');
    addresses.add(identity.email);
    if (!(identity.subject === null || typeof identity.subject === 'string' && CAPTURED_SUBJECT.test(identity.subject))) {
      throw new Error('Reconcile identity subject is not a captured subject');
    }
    if (!identity.actions || Object.keys(identity.actions).sort().join(',') !== 'cognito,objects,readback,service_cleanup') {
      throw new Error('Reconcile identity actions have an unknown member');
    }
    if (!CLEANUP_ACTION.includes(identity.actions.service_cleanup) || !COGNITO_ACTION.includes(identity.actions.cognito)
      || !OBJECT_ACTION.includes(identity.actions.objects) || !READBACK_ACTION.includes(identity.actions.readback)) {
      throw new Error('Reconcile identity action value is outside the closed set');
    }
    if (!IDENTITY_OUTCOMES.includes(identity.outcome)) throw new Error('Reconcile identity outcome is outside the closed set');
    validateOrigin(identity.origin, 'Reconcile identity origin');
  }
  if (!Array.isArray(record.unresolved) || record.unresolved.length > 500) throw new Error('Reconcile unresolved list is unbounded');
  for (const entry of record.unresolved) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Reconcile unresolved entry is malformed');
    if (!['caller,email,origin,reason', 'email,origin,reason'].includes(Object.keys(entry).sort().join(','))) throw new Error('Reconcile unresolved entry has an unknown member');
    // `outside_worker_family` is the one reason that admits a bounded E2E address outside the
    // worker families, and it never selects a deletion. Every other reason is a worker address.
    if (typeof entry.email !== 'string' || (entry.reason === 'outside_worker_family'
      ? !BOUNDED_E2E_ADDRESS.test(entry.email)
      : !isCapturedBetaWorkerEmail(entry.email))) throw new Error('Reconcile unresolved address is outside the captured Beta worker families');
    if (!UNRESOLVED_REASONS.includes(entry.reason)) throw new Error('Reconcile unresolved reason is outside the closed set');
    validateOrigin(entry.origin, 'Reconcile unresolved origin');
  }
  if (record.result === 'failed' && record.unresolved.length === 0) throw new Error('Reconcile result is failed with no unresolved identity');
  return record;
}

function validateOrigin(origin, label) {
  if (origin?.kind === 'manifest') {
    if (Object.keys(origin).sort().join(',') !== 'attempt,kind,run') throw new Error(`${label} has an unknown member`);
    requirePositiveInteger(origin.run, `${label} run`);
    requirePositiveInteger(origin.attempt, `${label} attempt`);
    return;
  }
  if (origin?.kind === 'cloudtrail') {
    // The creation's credential session optionally names the run and attempt, so the record
    // proves the creating run from the event itself.
    const members = Object.keys(origin).sort().join(',');
    if (members !== 'event_id,event_time,kind' && members !== 'attempt,event_id,event_time,kind,run') {
      throw new Error(`${label} has an unknown member`);
    }
    requireString(origin.event_id, `${label} event id`);
    instant(origin.event_time, `${label} event time`);
    if (origin.run !== undefined) requirePositiveInteger(origin.run, `${label} run`);
    if (origin.attempt !== undefined) requirePositiveInteger(origin.attempt, `${label} attempt`);
    return;
  }
  throw new Error(`${label} is not manifest or cloudtrail`);
}

/**
 * The run fails only for a leftover it was supposed to resolve inside its bound. A retry
 * inside the bound is the ordinary path: the identity is recorded and the next run — or the
 * daily schedule — tries again. The three reported conditions — a foreign caller, a
 * pool-address record with neither a captured subject nor a creation event, and a record
 * outside the Beta worker families — cannot be resolved by any automatic path this design has,
 * so they are recorded and warned about but never fail the run on their own. A bound breach is
 * what the alert is for.
 */
export function judgeResult(unresolved, now, bounds) {
  for (const entry of unresolved) {
    if (REPORTED_REASONS.includes(entry.reason)) continue;
    const bound = bounds.get(entry.email);
    if (bound === undefined || now > bound) return 'failed';
  }
  return 'passed';
}

/** The Service cleanup evidence path for one group, so groups cannot overwrite each other. */
export function cleanupEvidencePath(directory, index, runScope) {
  return resolve(directory, `service-cleanup-${index}-${runScope}.json`);
}

/**
 * A verified live-root record: the only population a durable cleanup proof may be read from
 * (#224).
 *
 * A v3 record can only have come from the live tier, so it is live by construction; a v4 record
 * must say so. A marker record carries no task entries and an artifact record stamps them
 * `artifact`, so neither can be a source: every accepted proof traces one hop back to a run that
 * read ECS.
 */
function isVerifiedLiveRoot(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.record_type !== 'anywear_e2e_service_cleanup_operation') return false;
  if (record.schema_version !== 3 && record.schema_version !== 4) return false;
  const operation = record.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return false;
  if (operation.proof_status !== 'verified' || operation.status !== 'SUCCEEDED') return false;
  if (typeof operation.execution_name !== 'string' || operation.execution_name.length === 0) return false;
  if (record.schema_version === 4 && operation.proof_origin !== 'live') return false;
  if (operation.artifact_source !== undefined) return false;
  if (!Array.isArray(operation.tasks) || operation.tasks.length !== 2) return false;
  return operation.tasks.every(task => task && typeof task === 'object' && !Array.isArray(task) && task.proof_origin === 'live');
}

/** The provenance the written record restates for one artifact entry. */
function witnessSourceFor(artifact, entry) {
  return { artifact_id: artifact.id, artifact_name: artifact.name, artifact_digest: artifact.digest,
    file: entry.name, record_sha256: byteHash(entry.bytes) };
}

/**
 * The index of verified live-root records a run has read (#224).
 *
 * One record per execution name: an identical duplicate keeps the earlier artifact (a record
 * cannot be improved by being uploaded twice), while two records for one name that differ drop
 * the name entirely and are counted in the run log, so the verifier refuses that identity
 * instead of letting a coin flip decide between them.
 */
export function createCleanupWitnessIndex({ log = () => {} } = {}) {
  const entries = new Map();
  const dropped = new Set();
  const add = (bytes, source, createdAt = 0) => {
    let record;
    try { record = parseStrictJson(bytes); }
    catch (error) { throw new Error(`Cleanup record ${source.file} is not strict JSON`, { cause: error }); }
    if (!isVerifiedLiveRoot(record)) return false;
    const name = record.operation.execution_name;
    if (dropped.has(name)) return false;
    const existing = entries.get(name);
    if (!existing) { entries.set(name, { record, source, createdAt }); return true; }
    if (isDeepStrictEqual(existing.record, record)) {
      if (createdAt < existing.createdAt) entries.set(name, { record, source, createdAt });
      return true;
    }
    entries.delete(name);
    dropped.add(name);
    log(`cleanup record for ${name} appears in two artifacts with different bytes; refusing it rather than choosing`);
    return false;
  };
  return {
    add,
    lookup: name => (dropped.has(name) ? undefined : entries.get(name)),
    isDropped: name => dropped.has(name),
  };
}

/**
 * The lazy durable-witness lookup the reconcile supplies to the cleanup verifier (#224).
 *
 * The listing it filters is the single artifact-list walk the run already performed, so nothing
 * extra is listed. Nothing is read until the verifier asks: an execution whose live ECS tasks or
 * completion marker still prove it costs zero artifact reads. When asked, only the reconcile
 * family is considered, only rows with a published digest created at or after the execution's
 * own `stopped_at` are candidates, and at most `maxReads` candidates are read, nearest the stop
 * time first. The first record for the exact execution name answers; anything else is a miss,
 * and a miss is a refusal at `task_proof`, never a pass.
 */
export function createCleanupWitnessLookup({ artifacts = [], io, index, log = () => {}, runs = new Map(),
  maxReads = RECONCILE_WITNESS_ARTIFACT_READS } = {}) {
  if (!io || typeof io.readArtifact !== 'function' || typeof io.getWorkflowRun !== 'function') {
    throw new Error('Cleanup witness lookup requires the artifact and workflow-run transports');
  }
  if (!index || typeof index.lookup !== 'function' || typeof index.add !== 'function' || typeof index.isDropped !== 'function') {
    throw new Error('Cleanup witness lookup requires its record index');
  }
  const read = new Set();
  const announce = (name, found) => log(`cleanup record for ${name} read from ${found.source.artifact_name} (${found.source.file})`);
  return async function recovery(executionName, stoppedAt) {
    const known = index.lookup(executionName);
    if (known) {
      announce(executionName, known);
      return known;
    }
    if (index.isDropped(executionName)) return undefined;
    const stop = Date.parse(stoppedAt ?? '');
    if (!Number.isFinite(stop)) return undefined;
    const candidates = artifacts.filter(artifact => artifact?.expired === false
      && ARTIFACT_DIGEST.test(artifact?.digest ?? '')
      && Number.isFinite(Date.parse(artifact?.created_at ?? ''))
      && Date.parse(artifact.created_at) >= stop)
      .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at) || left.id - right.id);
    let reads = 0;
    for (const artifact of candidates) {
      if (index.lookup(executionName) || index.isDropped(executionName)) break;
      if (read.has(artifact.id)) continue;
      if (reads >= maxReads) break;
      // The same protected-run binding the lifecycle family uses; an artifact it cannot bind is
      // never a witness, and a run lookup the transport cannot answer leaves it unbound.
      const binding = lifecycleArtifactBinding(artifact);
      if (!binding.bound) continue;
      if (!runs.has(binding.parsed.runId)) runs.set(binding.parsed.runId, await io.getWorkflowRun(binding.parsed.runId));
      if (!lifecycleWorkflowRunBinding(runs.get(binding.parsed.runId), binding.headSha).bound) continue;
      reads += 1;
      read.add(artifact.id);
      const entries = await io.readArtifact(artifact);
      const { records } = classifyReconcileArchive(entries);
      for (const file of records) {
        const entry = entries.find(candidate => candidate.name === file);
        if (!entry || entry.bytes === undefined) continue;
        index.add(entry.bytes, witnessSourceFor(artifact, entry), Date.parse(artifact.created_at));
      }
    }
    const found = index.lookup(executionName);
    if (found) {
      announce(executionName, found);
      return found;
    }
    return undefined;
  };
}

/**
 * The run annotations the record earns (#217).
 *
 * A reported condition — a foreign caller, a pool-address record with no proof, a record
 * outside the Beta worker families — is a warning that never fails the run. An unresolved
 * leftover past its bound is an error and fails it. The distinction is the whole point of the
 * reported-exception rule, so it is stated in one place and asserted by a test.
 */
export function recordAnnotations(record) {
  const warnings = [];
  const errors = [];
  for (const entry of record.unresolved) {
    const run = entry.origin.kind === 'manifest'
      ? `run ${entry.origin.run} attempt ${entry.origin.attempt}`
      : `CloudTrail event ${entry.origin.event_id} at ${entry.origin.event_time}`
        + `${entry.origin.run ? ` (run ${entry.origin.run} attempt ${entry.origin.attempt})` : ''}`;
    if (REPORTED_REASONS.includes(entry.reason)) {
      warnings.push(`::warning title=Reported E2E leftover condition::${entry.email} (${entry.reason}) from ${run}`);
      continue;
    }
    errors.push(`::error title=Unresolved E2E leftover::${entry.email} (${entry.reason}) from ${run}`);
  }
  return { warnings, errors };
}

/**
 * Prove the identity set and its unresolved entries against the record's closed contract
 * *before the first mutation*.
 *
 * A record is only useful if it can be written, and writing it after a deletion is too late to
 * refuse: a foreign address, an unknown origin or an off-contract reason discovered at that
 * point would lose the statement about work already done. The skeleton is the record's own
 * shape with placeholder actions, so an identity set that validates here can only produce
 * closed-set values afterwards.
 */
export function assertIdentitySetWithinContract({ reconcileId, window, identities, unresolved }) {
  return buildReconcileRecord({
    reconcileId,
    window,
    sources: { artifacts: 0, artifacts_ignored: 0, cloudtrail_events: 0 },
    identities: identities.map((identity) => recordIdentity(identity, {
      subject: identity.subject ?? null,
      actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'not_attempted' },
      outcome: 'retained',
    })),
    unresolved: unresolved.map((entry) => ({
      email: entry.email,
      reason: entry.reason,
      ...(entry.caller ? { caller: entry.caller } : {}),
      origin: entry.origin,
    })),
    result: 'passed',
  });
}

/** The in-job deadline, which a NaN or a non-positive value must refuse rather than disable. */
function requireDeadline(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number of milliseconds`);
  }
  return value;
}

/**
 * The reconcile operation.
 *
 * `io` is the whole transport seam, so the offline tests exercise the reader, the binding, the
 * diff, the bounds and the record without an AWS or GitHub call:
 *   listArtifacts(window)          -> lifecycle-named artifact rows in the window
 *   readArtifact(artifact)         -> the artifact's entries, each {name, size, directory, symlink, bytes}
 *   getWorkflowRun(runId)          -> { path, event, head_branch, head_sha } of one workflow run
 *   lookupCreateUserEvents(window) -> CloudTrail lookup-events rows
 *   getUserByUsername(username)    -> { Username, UserAttributes } or UserNotFoundException;
 *                                     resolves a masked creation's `additionalEventData.sub` to
 *                                     the address that identity was created with
 *   getUser(email)                 -> { Username, UserAttributes } or UserNotFoundException
 *   deleteUser(username)           -> deletes by immutable username
 *   runServiceCleanup(inputs, env, { deadline, migrationGeneration?, recovery? })
 *                                  -> { proof_status, committed_result } or undefined
 *                                     `recovery` is the lazy durable-witness lookup this run
 *                                     supplies; nothing else supplies one (#224)
 */
export async function reconcileAccounts({
  io,
  environment = process.env,
  now = Date.now(),
  runIdentity,
  window = reconcileWindow(now, Number(environment.E2E_ACCOUNT_RECONCILE_LOOKBACK_DAYS ?? RECONCILE_WINDOW_DAYS)),
  deadlineMs = Number(environment.E2E_ACCOUNT_RECONCILE_DEADLINE_SECONDS ?? DEFAULT_RECONCILE_DEADLINE_SECONDS) * 1000,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!io) throw new Error('Reconcile requires its transport');
  requirePositiveInteger(runIdentity?.runId, 'Reconcile run id');
  requirePositiveInteger(runIdentity?.attempt, 'Reconcile run attempt');
  const reconcileId = `${runIdentity.runId}-${runIdentity.attempt}`;
  const deadline = Date.now() + requireDeadline(deadlineMs, 'Reconcile deadline');
  // The one extra cleanup generation is allowed to the migration dispatch and to nothing
  // else (#217): the allowance follows the recorded window, which is itself a closed set of
  // seven days or the 90-day artifact retention. An ordinary reconcile, `full`, `smoke` and
  // the teardown never pass it, so their two-name rule is unchanged.
  const migrationGeneration = lookbackDaysOfWindow(window) === RECONCILE_MIGRATION_WINDOW_DAYS;

  const listed = await io.listArtifacts(window);
  // An empty window is a valid scan, not a failure (#217): the design's own orphan case is a
  // run whose manifest was never uploaded, and when that run is the only one in the lookback
  // there is no artifact at all. The identity set is then built from CloudTrail alone and the
  // record states `sources.artifacts: 0`. Only a transport/API failure or an over-bound list
  // refuses before any deletion.
  if (!Array.isArray(listed)) throw new Error('Lifecycle artifact list is unavailable');
  const artifactBound = maxArtifactsForWindow(window);
  const reconcileBound = maxReconcileArtifactsForWindow(window);
  // Partition the single listing by name family before anything is read (#224), so
  // `sources.artifacts` keeps counting exactly the lifecycle family it has always counted.
  const listedLifecycle = [];
  const listedReconcile = [];
  for (const artifact of listed) {
    if (parseManifestArtifactName(artifact?.name)) listedLifecycle.push(artifact);
    else if (parseReconcileArtifactName(artifact?.name)) listedReconcile.push(artifact);
    else throw new Error('Reconcile was offered a non-lifecycle artifact');
  }
  if (listedLifecycle.length > artifactBound) {
    // Fail closed rather than truncate: a truncated list would read as a quiet scan.
    throw new Error('Lifecycle artifacts in the window exceed the reconcile bound');
  }
  if (listedReconcile.length > reconcileBound) {
    throw new Error('Reconcile artifacts in the window exceed the reconcile bound');
  }

  // Bind every lifecycle-named artifact to the protected run. An unbound one — including one
  // whose readable cached run fails the workflow half of the binding — is ignored and counted;
  // only a run lookup the transport cannot answer is a source failure, because then the binding
  // cannot be decided at all.
  const artifacts = [];
  let artifactsIgnored = 0;
  const runs = new Map();
  for (const artifact of listedLifecycle) {
    const binding = lifecycleArtifactBinding(artifact);
    if (!binding.bound) {
      artifactsIgnored += 1;
      continue;
    }
    if (!runs.has(binding.parsed.runId)) {
      const run = await io.getWorkflowRun(binding.parsed.runId);
      if (run === undefined) throw new Error(`Lifecycle artifact ${artifact.id} workflow run is unavailable`);
      runs.set(binding.parsed.runId, run);
    }
    if (!lifecycleWorkflowRunBinding(runs.get(binding.parsed.runId), binding.headSha).bound) {
      artifactsIgnored += 1;
      continue;
    }
    artifacts.push({ artifact, parsed: binding.parsed });
  }

  // The durable witness index (#224). Lifecycle artifacts are read for their manifests anyway, so
  // their `service-cleanup-operation.json` diagnostic is indexed here at no extra read; the
  // reconcile family is read only by the lazy lookup, when a cleanup's live proof is exhausted.
  const witnessIndex = createCleanupWitnessIndex({
    log: (line) => log(`Reconcile ${reconcileId}: ${line}`),
  });
  const manifests = [];
  for (const { artifact, parsed } of artifacts) {
    const entries = await io.readArtifact(artifact);
    const { manifests: names } = classifyLifecycleArchive(entries);
    for (const name of names) {
      const entry = entries.find((candidate) => candidate.name === name);
      manifests.push(readManifest(entry.bytes, parsed));
    }
    const diagnostic = entries.find((candidate) => candidate.name === 'service-cleanup-operation.json');
    if (diagnostic?.bytes !== undefined) {
      // The diagnostic was ignored before #224, so a corrupt one may not turn an otherwise valid
      // reconcile into a source failure: it simply contributes no witness.
      try { witnessIndex.add(diagnostic.bytes, witnessSourceFor(artifact, diagnostic)); }
      catch { log(`Reconcile ${reconcileId}: ignored an unreadable cleanup diagnostic in ${artifact.name}`); }
    }
  }
  const witnessLookup = createCleanupWitnessLookup({
    artifacts: listedReconcile,
    io,
    index: witnessIndex,
    runs,
    log: (line) => log(`Reconcile ${reconcileId}: ${line}`),
  });

  const events = await io.lookupCreateUserEvents(window);
  // The live event masks the created address (#217), so a masked creation's `sub` is resolved
  // to its address before the identity set exists. Resolution happens here, before any Service
  // cleanup or Cognito delete, and a read it cannot answer is a source failure.
  const creationSet = parseCreateUserEvents(events, window, { userPoolId: environment.USER_POOL_ID });
  const resolvedCreations = await resolveCreateUserEvents(creationSet, { io });
  const identitySet = buildIdentitySet({ manifests, parsed: resolvedCreations, window });
  const creationWarnings = creationWarningAnnotations(identitySet.warnings ?? []);
  if (artifacts.length === 0) {
    log(`Reconcile ${reconcileId}: no run-bound lifecycle artifact in the ${lookbackDaysOfWindow(window)}-day window`
      + `${artifactsIgnored > 0 ? ` (${artifactsIgnored} ignored as unbound)` : ''}; `
      + `the identity set is built from ${events.length} CloudTrail event(s) alone.`);
  }
  log(`Reconcile ${reconcileId}: ${artifacts.length} run-bound artifact(s), ${artifactsIgnored} ignored, `
    + `${manifests.length} manifest(s), ${listedReconcile.length} reconcile artifact(s), ${events.length} CloudTrail event(s), `
    + `${identitySet.identities.length} attributable identit(ies), ${identitySet.unresolved.length} reportable condition(s), `
    + `${creationWarnings.length} unattributed creation warning(s).`);

  const recordIdentities = [];
  const unresolved = [];
  const bounds = new Map();
  for (const entry of identitySet.unresolved) {
    bounds.set(entry.email, entry.boundAt);
    unresolved.push({
      email: entry.email,
      reason: entry.reason,
      ...(entry.caller ? { caller: entry.caller } : {}),
      origin: entry.origin,
    });
  }
  for (const identity of identitySet.identities) bounds.set(identity.email, identity.boundAt);

  // Nothing below may discover an input the contract cannot state: the whole identity set is
  // proven against the record's closed shape before the first Service, Cognito or delete call.
  assertIdentitySetWithinContract({ reconcileId, window, identities: identitySet.identities, unresolved });

  const groups = cleanupGroups(identitySet.identities);
  for (const [index, group] of groups.entries()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      for (const identity of group.identities) {
        unresolved.push({ email: identity.email, reason: 'deadline_exceeded', origin: identity.origin });
        recordIdentities.push(recordIdentity(identity, {
          subject: identity.subject,
          actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'not_attempted' },
          outcome: 'retained',
        }));
      }
      continue;
    }
    await reconcileGroup({ group, index, io, environment, recordIdentities, unresolved, deadline, migrationGeneration,
      recovery: witnessLookup });
  }

  const result = judgeResult(unresolved, now, bounds);
  // The values here were all validated before the first mutation; this call re-proves the same
  // closed set and cannot introduce a new failure mode.
  const record = buildReconcileRecord({
    reconcileId,
    window,
    sources: { artifacts: artifacts.length, artifacts_ignored: artifactsIgnored, cloudtrail_events: events.length },
    identities: recordIdentities.sort((left, right) => left.email.localeCompare(right.email)),
    unresolved: unresolved.sort((left, right) => left.email.localeCompare(right.email)),
    result,
  });
  return { record, result, identitySet, warnings: creationWarnings };
}

async function reconcileGroup({ group, index, io, environment, recordIdentities, unresolved, deadline, migrationGeneration, recovery }) {
  const members = [];
  for (const identity of group.identities) {
    let live;
    try {
      live = await io.getUser(identity.email);
    } catch (error) {
      if (isUserNotFound(error)) {
        // An absent identity with a captured subject still owes the row and object cleanup:
        // the ordered teardown deletes those first, so absence alone does not prove them.
        // Without a captured subject the exact request cannot be built, and the absence is
        // the completed re-run case the design records as `already_absent`.
        if (identity.subject) members.push({ identity, subject: identity.subject, username: undefined });
        else {
          recordIdentities.push(recordIdentity(identity, {
            subject: null,
            actions: { service_cleanup: 'not_required', cognito: 'already_absent', objects: 'not_required', readback: 'absent' },
            outcome: 'already_absent',
          }));
        }
        continue;
      }
      unresolved.push({ email: identity.email, reason: 'cognito_readback_failed', origin: identity.origin });
      recordIdentities.push(recordIdentity(identity, {
        subject: identity.subject,
        actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'unreadable' },
        outcome: 'retained',
      }));
      continue;
    }
    const attributes = Object.fromEntries((live.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
    if (typeof live.Username !== 'string' || live.Username.length === 0 || live.Username.includes('@')
      || attributes.email !== identity.email
      || typeof attributes.sub !== 'string' || !CAPTURED_SUBJECT.test(attributes.sub)) {
      unresolved.push({ email: identity.email, reason: 'unprovable_ownership', origin: identity.origin });
      recordIdentities.push(recordIdentity(identity, {
        subject: identity.subject,
        actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'not_attempted' },
        outcome: 'retained',
      }));
      continue;
    }
    // The captured subject stays a consistency check when the manifest has one: a
    // disagreement means this is not the identity the run created.
    if (identity.subject && identity.subject.toLowerCase() !== attributes.sub.toLowerCase()) {
      unresolved.push({ email: identity.email, reason: 'subject_mismatch', origin: identity.origin });
      recordIdentities.push(recordIdentity(identity, {
        subject: identity.subject,
        actions: { service_cleanup: 'not_required', cognito: 'not_attempted', objects: 'not_required', readback: 'not_attempted' },
        outcome: 'retained',
      }));
      continue;
    }
    members.push({ identity, subject: attributes.sub.toLowerCase(), username: live.Username });
  }
  if (members.length === 0) return;

  const inputs = {
    action: 'cleanup',
    emails: '[]',
    cleanup_json: cleanupRequest(group.runScope, members.map(({ identity, subject }) => ({ sub: subject, email: identity.email }))),
  };
  let evidence;
  try {
    evidence = await io.runServiceCleanup(inputs, {
      ...environment,
      E2E_SERVICE_CLEANUP_EVIDENCE_PATH: cleanupEvidencePath(environment.E2E_ACCOUNT_RECONCILE_DIRECTORY ?? 'reconcile', index, group.runScope),
    }, { deadline, ...(migrationGeneration ? { migrationGeneration: true } : {}), recovery });
  } catch (error) {
    // The cleanup wait is bounded by the absolute in-job deadline, so a Service wait cannot
    // outlive the job and lose the record. A deadline stop is the design's own condition.
    const deadlineStopped = error instanceof Error && error.name === 'CleanupDeadlineExceeded';
    recordServiceFailure(members, recordIdentities, unresolved, deadlineStopped ? 'deadline_exceeded' : 'service_cleanup_refused');
    return;
  }
  if (!evidence) {
    recordServiceFailure(members, recordIdentities, unresolved, 'service_cleanup_unavailable');
    return;
  }
  if (evidence.proof_status !== 'verified') {
    recordServiceFailure(members, recordIdentities, unresolved, 'service_cleanup_refused');
    return;
  }
  // The object phase is proven by the committed result's own counters. A committed result that
  // cannot state them is not proof of the object phase: the Service's own refusal vocabulary
  // covers a partial object deletion, so it is recorded as a Service refusal and retried.
  const objects = objectAction(evidence.committed_result);
  if (objects === 'unavailable') {
    recordServiceFailure(members, recordIdentities, unresolved, 'service_cleanup_refused');
    return;
  }
  for (const member of members) {
    if (member.username === undefined) {
      recordIdentities.push(recordIdentity(member.identity, {
        subject: member.identity.subject ?? member.subject,
        actions: { service_cleanup: 'committed', cognito: 'already_absent', objects, readback: 'absent' },
        outcome: 'already_absent',
      }));
      continue;
    }
    try {
      await io.deleteUser(member.username);
    } catch (error) {
      if (!isUserNotFound(error)) {
        unresolved.push({ email: member.identity.email, reason: 'cognito_delete_refused', origin: member.identity.origin });
        recordIdentities.push(recordIdentity(member.identity, {
          subject: member.identity.subject ?? member.subject,
          actions: { service_cleanup: 'committed', cognito: 'refused', objects, readback: 'not_attempted' },
          outcome: 'retained',
        }));
        continue;
      }
    }
    try {
      await io.getUser(member.identity.email);
    } catch (error) {
      if (isUserNotFound(error)) {
        recordIdentities.push(recordIdentity(member.identity, {
          subject: member.identity.subject ?? member.subject,
          actions: { service_cleanup: 'committed', cognito: 'deleted', objects, readback: 'absent' },
          outcome: 'reconciled',
        }));
        continue;
      }
      unresolved.push({ email: member.identity.email, reason: 'cognito_readback_failed', origin: member.identity.origin });
      recordIdentities.push(recordIdentity(member.identity, {
        subject: member.identity.subject ?? member.subject,
        actions: { service_cleanup: 'committed', cognito: 'deleted', objects, readback: 'unreadable' },
        outcome: 'retained',
      }));
      continue;
    }
    unresolved.push({ email: member.identity.email, reason: 'cognito_readback_failed', origin: member.identity.origin });
    recordIdentities.push(recordIdentity(member.identity, {
      subject: member.identity.subject ?? member.subject,
      actions: { service_cleanup: 'committed', cognito: 'deleted', objects, readback: 'present' },
      outcome: 'retained',
    }));
  }
}

function recordServiceFailure(members, recordIdentities, unresolved, reason) {
  for (const member of members) {
    unresolved.push({ email: member.identity.email, reason, origin: member.identity.origin });
    recordIdentities.push(recordIdentity(member.identity, {
      subject: member.identity.subject ?? member.subject,
      actions: {
        service_cleanup: reason === 'service_cleanup_refused' ? 'refused' : 'unavailable',
        cognito: 'not_attempted',
        objects: 'unavailable',
        readback: 'not_attempted',
      },
      outcome: 'retained',
    }));
  }
}

function isUserNotFound(error) {
  return error instanceof Error && (error.name === 'UserNotFoundException' || /UserNotFoundException/.test(error.message));
}

// One artifact's closed upload set, listed and extracted in one pass so the reader can reject an
// unknown name, a directory, a symlink or a repeated file before it reads anything. A v4 artifact
// upload flattens `test-results/account-budget.json` to `account-budget.json`; both account legs
// and the two cleanup diagnostics keep their names. The closed set is a parameter (#224): the
// reconcile family extracts its two diagnostics and every `service-cleanup-<index>-<scope>.json`
// record, which are named only by their pattern.
function archiveReader(closed, pattern = '') {
  return [
    'import sys, json, zipfile, base64, re',
    `closed=${JSON.stringify(closed)}`,
    `pattern=re.compile(${JSON.stringify(pattern)}) if ${JSON.stringify(pattern)} else None`,
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' entries=z.infolist()',
    ' names=[e.filename for e in entries]',
    ' if len(names)!=len(set(names)): raise ValueError("Artifact repeats a file")',
    ' listed=[]',
    ' files={}',
    ' for e in entries:',
    '  symlink=((e.external_attr>>16)&0o170000)==0o120000',
    '  listed.append({"name":e.filename,"size":e.file_size,"directory":e.is_dir(),"symlink":symlink})',
    '  if (e.filename in closed or (pattern and pattern.match(e.filename))) and not e.is_dir() and not symlink and e.file_size<=1048576:',
    '   files[e.filename]=base64.b64encode(z.read(e.filename)).decode("ascii")',
    ' print(json.dumps({"entries":listed,"files":files}))',
  ].join('\n');
}

const LIFECYCLE_ARCHIVE_READER = archiveReader(LIFECYCLE_UPLOAD_SET);
const RECONCILE_RECORD_FILE_PATTERN = '^service-cleanup-(?:0|[1-9][0-9]*)-(?:[1-9][0-9]*)-(?:[1-9][0-9]*)-[a-f0-9]{16}\\.json$';
const RECONCILE_ARCHIVE_READER = archiveReader(RECONCILE_DIAGNOSTICS, RECONCILE_RECORD_FILE_PATTERN);

function extractLifecycleArchive(archivePath, reader = LIFECYCLE_ARCHIVE_READER) {
  const stdout = execFileSync('python3', ['-c', reader, archivePath], {
    timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
  const parsed = parseStrictJson(stdout);
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error('Lifecycle artifact listing is malformed');
  return parsed.entries.map((entry) => ({
    name: entry.name,
    size: entry.size,
    directory: entry.directory === true,
    symlink: entry.symlink === true,
    bytes: typeof parsed.files?.[entry.name] === 'string' ? Buffer.from(parsed.files[entry.name], 'base64') : undefined,
  }));
}

// The production transports. They are the only places that touch GitHub, AWS or the Service
// cleanup capability; the tests inject the same interface instead. `cleanupIo` is the test seam
// for the real `runCleanupOperation` transport; production always leaves it undefined.
export function createReconcileIo(environment = process.env, { cleanupIo } = {}) {
  const repository = repositories.e2e;
  const userPoolId = environment.USER_POOL_ID;
  if (!userPoolId) throw new Error('USER_POOL_ID is required to read the Beta pool');
  const client = new CognitoIdentityProviderClient({ region: environment.AWS_REGION ?? 'ap-east-1' });

  async function listArtifacts(window) {
    return await collectLifecycleArtifacts({
      window,
      fetchPage: (page, perPage) => parseStrictJson(
        ghApi(`repos/${repository}/actions/artifacts?per_page=${perPage}&page=${page}`, false, environment),
      ),
    });
  }

  async function getWorkflowRun(runId) {
    const run = parseStrictJson(ghApi(`repos/${repository}/actions/runs/${requirePositiveInteger(runId, 'Workflow run id')}`, false, environment));
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('Workflow run response is malformed');
    return { path: run.path, event: run.event, head_branch: run.head_branch, head_sha: run.head_sha };
  }

  async function readArtifact(artifact) {
    // A bound artifact is read only against its published digest, so a listing row that lost it
    // is refused before a byte is fetched instead of skipping verification.
    const digest = requireLifecycleArtifactDigest(artifact?.digest, `Lifecycle artifact ${artifact?.id}`);
    const archive = ghApi(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, true, environment);
    if (!Buffer.isBuffer(archive) || archive.length === 0) throw new Error('Lifecycle artifact is empty or unavailable');
    if (archive.length > LIFECYCLE_ARCHIVE_MAX_BYTES) throw new Error('Lifecycle artifact exceeds its bound');
    if (digest !== `sha256:${byteHash(archive)}`) throw new Error('Lifecycle artifact digest does not match its bytes');
    const directory = await mkdtemp(join(tmpdir(), 'anywear-reconcile-'));
    try {
      const path = join(directory, 'artifact.zip');
      await writeFile(path, archive);
      // The reconcile family's records are named only by their pattern, so its reader gets the
      // closed set that admits them (#224).
      return extractLifecycleArchive(path, parseReconcileArtifactName(artifact?.name) ? RECONCILE_ARCHIVE_READER : LIFECYCLE_ARCHIVE_READER);
    } finally {
      // The extracted copy is a scratch detail; nothing read from it is kept on disk.
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function lookupCreateUserEvents(window) {
    const rows = [];
    let token;
    for (let page = 0; page < 20; page += 1) {
      const args = ['cloudtrail', 'lookup-events', '--region', 'ap-east-1',
        '--lookup-attributes', 'AttributeKey=EventName,AttributeValue=AdminCreateUser',
        '--start-time', window.from, '--end-time', window.to, '--max-results', '50',
        '--output', 'json', '--no-cli-pager', ...(token ? ['--next-token', token] : [])];
      const { stdout } = await execute('aws', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true });
      const response = parseStrictJson(stdout);
      if (!response || !Array.isArray(response.Events)) throw new Error('CloudTrail lookup response is malformed');
      rows.push(...response.Events);
      if (rows.length > RECONCILE_MAX_EVENTS) throw new Error('CloudTrail read exceeds its bound');
      if (typeof response.NextToken !== 'string' || response.NextToken.length === 0) return rows;
      if (page === 19) throw new Error('CloudTrail pagination exceeds its bound');
      token = response.NextToken;
    }
    return rows;
  }

  return {
    listArtifacts,
    readArtifact,
    getWorkflowRun,
    lookupCreateUserEvents,
    async getUser(email) {
      const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
      return { Username: user.Username, UserAttributes: user.UserAttributes };
    },
    /**
     * Read one identity by its immutable username.
     *
     * CloudTrail masks `AdminCreateUser`'s request username, so the event's
     * `additionalEventData.sub` is the only address handle it carries. In this pool the
     * immutable Cognito username is that `sub`, so the same read the reconcile already uses
     * resolves a masked creation to the address it was created with.
     */
    async getUserByUsername(username) {
      const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
      return { Username: user.Username, UserAttributes: user.UserAttributes };
    },
    async deleteUser(username) {
      assertE2EExecution(environment);
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    },
    async runServiceCleanup(inputs, cleanupEnvironment, { deadline, migrationGeneration, recovery } = {}) {
      // The absolute in-job deadline bounds the Service wait, so a 30-minute capability wait
      // cannot outlive the 15-minute job and lose the record it was about to write.
      if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0) {
        throw new Error('Service cleanup requires the caller\'s absolute deadline');
      }
      // The migration allowance reaches the cleanup only when the recorded window is the
      // 90-day retention; every other dispatch leaves the key absent (#217). The durable
      // witness lookup is the reconcile's own source (#224); every other caller passes none.
      const evidence = await runCleanupOperation(inputs, cleanupEnvironment, cleanupIo,
        { deadline, ...(migrationGeneration === true ? { migrationGeneration: true } : {}),
          ...(typeof recovery === 'function' ? { recovery } : {}) });
      if (!evidence) return undefined;
      const operation = evidence.operation ?? {};
      return { proof_status: operation.proof_status, committed_result: operation.committed_result };
    },
    destroy() { client.destroy(); },
  };
}

async function main() {
  const recordPath = process.env.E2E_ACCOUNT_RECONCILE_RECORD_PATH ?? 'reconcile/account-reconcile.json';
  let io;
  try {
    assertE2EExecution();
    io = createReconcileIo(process.env);
    const runIdentity = { runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
    const { record, warnings } = await reconcileAccounts({ io, environment: process.env, runIdentity });
    await mkdir(dirname(resolve(recordPath)), { recursive: true });
    await writeFile(resolve(recordPath), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Reconcile record: ${record.reconcile_id} result=${record.result} identities=${record.identities.length} unresolved=${record.unresolved.length} warnings=${warnings.length}\n`);
    const annotations = recordAnnotations(record);
    // An unattributed creation is a warning, never a failure: the record cannot state an address
    // it could not resolve, so the annotation is the only place the operator sees the event.
    for (const warning of [...warnings, ...annotations.warnings]) process.stderr.write(`${warning}\n`);
    for (const error of annotations.errors) process.stderr.write(`${error}\n`);
    if (record.result !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Account reconcile failed'}\n`);
    process.exitCode = 1;
  } finally {
    io?.destroy?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
